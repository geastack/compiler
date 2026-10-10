import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { interfaceFlowImplementorsOf } from './interface-implementors.js'

/**
 * Property declarations the program writes a value outside of through a write
 * the checker does not check, restated to admit that value.
 *
 * Three such writes exist, and each lets a value past the declaration unseen
 * (a fourth kind of evidence, arguments narrowed to `never`, is documented
 * where it is collected below):
 *
 * - An `any` right-hand side. `any` is the unchecked top: the checker lets it
 *   into every position. A class that declares
 *   `time?: Clock` and writes `this.time = reply?.time ?? null` with
 *   `reply` an `any`-typed document is the case; node stores the `null` the `?? null` produces. Only a `null`
 *   the program SPELLS counts -- the literal, the fallback arm of `??`/`||`,
 *   an arm of a conditional. A `null` hidden inside an opaque `any` is not
 *   visible here and still meets the checked unwrap.
 * - A `null` an overload implementation typed `any` returns. The checker
 *   relates that `any` to none of the overload signatures callers are typed
 *   by. A method declared as overloads
 *   `toValue<T>(element, as: T): ValueOf[T]` whose `any` implementation
 *   returns `null` when the element is of another kind; a caller then tests
 *   `value == null`, which the declaration says is impossible for `boolean`.
 * - An object-literal computed key whose type is a union of literals. The
 *   checker cannot tell which member such a key names, so it types the
 *   property as an index-signature entry and never relates the value to the
 *   member the key actually lands on. A function that builds
 *   `{ [flag ? 'a' : 'b']: 1, ... }` as an `Options` whose `a?: boolean` /
 *   `b?: boolean` then hold the number `1` is the case. Only a primitive value type counts, so the restated
 *   type is always nameable where the member is declared.
 *
 * Every later stage takes the declaration at its word -- the field is laid
 * out for the declared type, the write converts the value through a checked
 * unwrap and throws a TypeError, and reads fold comparisons against it. The
 * declaration is the one authority every read, local and comparison inherits
 * its type from, so it is the place to state the truth: its type becomes
 * `(T) | V` and the checker re-derives everything downstream from that,
 * including a diagnostic wherever the program then passes the member on to a
 * position that cannot hold `V` -- a real defect in the program's typing, not
 * one this introduces.
 *
 * Positions are those of the program's own current text, so the rewritten
 * text supersedes every earlier preparation of the same file.
 */
export const uncheckedWriteMemberDeclarations = (program: ts.Program, checker: ts.TypeChecker): ReadonlyMap<string, string> => {
  const options = program.getCompilerOptions()
  const nullChecked = options.strictNullChecks ?? options.strict ?? false
  const spellsNull = (expression: ts.Expression, depth = 0): boolean => {
    if (depth > 8) return false
    if (expression.kind === ts.SyntaxKind.NullKeyword) return true
    if (ts.isParenthesizedExpression(expression)) return spellsNull(expression.expression, depth + 1)
    if (ts.isConditionalExpression(expression))
      return spellsNull(expression.whenTrue, depth + 1) || spellsNull(expression.whenFalse, depth + 1)
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      return spellsNull(expression.right, depth + 1)
    return false
  }
  const admitsNull = (type: ts.Type): boolean =>
    (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    (type.isUnion() && type.types.some((member) => (member.flags & ts.TypeFlags.Null) !== 0))
  const widened = new Map<ts.SourceFile, Map<ts.TypeNode, Set<string>>>()
  const widen = (declaration: ts.Declaration, admits: (declared: ts.Type) => boolean, spelling: string): void => {
    if (!ts.isPropertyDeclaration(declaration) && !ts.isPropertySignature(declaration)) return
    widenTypeNode(declaration.type, declaration.getSourceFile(), admits, spelling)
  }
  const widenTypeNode = (
    typeNode: ts.TypeNode | undefined,
    file: ts.SourceFile,
    admits: (declared: ts.Type) => boolean,
    spelling: string
  ): void => {
    if (!typeNode || file.isDeclarationFile || admits(checker.getTypeFromTypeNode(typeNode))) return
    const known = widened.get(file) ?? new Map<ts.TypeNode, Set<string>>()
    widened.set(file, known)
    const spellings = known.get(typeNode) ?? new Set<string>()
    known.set(typeNode, spellings)
    spellings.add(spelling)
  }
  const containingFunction = (node: ts.Node): ts.SignatureDeclaration | undefined => {
    for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return current
    return undefined
  }
  // The overload signatures an implementation typed `any` answers for. The
  // checker relates the implementation to each overload only loosely and its
  // `any` return to none of them, so a `null` the body returns reaches callers
  // typed by an overload that never admitted it.
  const overloadsAnsweredByAny = (implementation: ts.SignatureDeclaration): readonly ts.SignatureDeclaration[] => {
    if (!('body' in implementation) || !implementation.body || !implementation.name) return []
    const declared = implementation.type
    if (declared ? declared.kind !== ts.SyntaxKind.AnyKeyword : true) {
      const signature = checker.getSignatureFromDeclaration(implementation)
      if (declared || !signature || (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Any) === 0) return []
    }
    const symbol = checker.getSymbolAtLocation(implementation.name)
    return (symbol?.declarations ?? []).filter(
      (declaration): declaration is ts.SignatureDeclaration =>
        declaration !== implementation &&
        declaration.kind === implementation.kind &&
        ts.isFunctionLike(declaration) &&
        !('body' in declaration && declaration.body)
    )
  }
  const primitiveValueFlags =
    ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Null
  const literalKeysOf = (type: ts.Type): readonly string[] | undefined => {
    const members = type.isUnion() ? type.types : [type]
    const keys: string[] = []
    for (const member of members) {
      if (member.isStringLiteral()) keys.push(member.value)
      else if (member.isNumberLiteral()) keys.push(String(member.value))
      else return undefined
    }
    return members.length > 1 ? keys : undefined
  }
  const visit = (node: ts.Node): void => {
    if (
      nullChecked &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      spellsNull(node.right) &&
      (checker.getTypeAtLocation(node.right).flags & ts.TypeFlags.Any) !== 0
    ) {
      const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left.argumentExpression)
      for (const declaration of symbol?.declarations ?? []) widen(declaration, admitsNull, 'null')
    }
    if (nullChecked && ts.isReturnStatement(node) && node.expression && spellsNull(node.expression)) {
      const implementation = containingFunction(node)
      for (const overload of implementation ? overloadsAnsweredByAny(implementation) : [])
        widenTypeNode(overload.type, overload.getSourceFile(), admitsNull, 'null')
    }
    if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name) && ts.isObjectLiteralExpression(node.parent)) {
      const keys = literalKeysOf(checker.getTypeAtLocation(node.name.expression))
      const contextual = keys ? checker.getContextualType(node.parent) : undefined
      const value = contextual ? checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(node.initializer)) : undefined
      if (keys && contextual && value && !value.isUnion() && (value.flags & primitiveValueFlags) !== 0) {
        const spelling = checker.typeToString(value)
        for (const target of contextual.isUnion() ? contextual.types : [contextual])
          for (const key of keys)
            for (const declaration of checker.getPropertyOfType(target, key)?.declarations ?? [])
              widen(declaration, (declared) => checker.isTypeAssignableTo(value, declared), spelling)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) visit(file)

  // Arguments the checker narrowed to `never`: a declared member read after
  // every guard its declared type allows has failed, handed to a primitive
  // parameter. The program is stating what the member holds when it is not
  // what the declaration says. A member declared `counter: Int64` (a library
  // integer class) read as
  // `Int64.isInt64(v.counter) ? v.counter : Int64.fromNumber(v.counter)` --
  // where a decoder actually stores a `number`, so that last arm is the one
  // that runs, and the any-to-record assertion of the decoded document
  // refused the number.
  //
  // One occurrence's evidence must not break another: widening by `bigint`
  // because `typeof c === 'bigint' ? Int64.fromBigInt(c) : ...` names it would
  // hand `bigint` to an `Int64.fromNumber(c)` elsewhere that has no such guard.
  // So each candidate primitive is kept only while every occurrence it would
  // reach (after the `typeof` guards around that occurrence) accepts it.
  interface NeverOccurrence {
    readonly spelling: string
    readonly parameter: ts.Type
    readonly admitted: (primitive: string) => boolean
  }
  const primitiveSpellingOf = (type: ts.Type): string | undefined => {
    if (type.flags & ts.TypeFlags.Number) return 'number'
    if (type.flags & ts.TypeFlags.String) return 'string'
    if (type.flags & ts.TypeFlags.Boolean) return 'boolean'
    if (type.flags & ts.TypeFlags.BigInt) return 'bigint'
    return undefined
  }
  const primitiveTypeOf = (spelling: string): ts.Type | undefined =>
    spelling === 'number'
      ? checker.getNumberType()
      : spelling === 'string'
        ? checker.getStringType()
        : spelling === 'boolean'
          ? checker.getBooleanType()
          : spelling === 'bigint'
            ? checker.getBigIntType()
            : undefined
  // The `typeof` guards enclosing an occurrence, as a filter over primitives.
  const guardsAround = (occurrence: ts.Expression): ((primitive: string) => boolean) => {
    const text = occurrence.getText()
    const tests: ((primitive: string) => boolean)[] = []
    const typeofTest = (condition: ts.Expression): { readonly name: string; readonly equal: boolean } | undefined => {
      while (ts.isParenthesizedExpression(condition)) condition = condition.expression
      if (!ts.isBinaryExpression(condition)) return undefined
      const op = condition.operatorToken.kind
      const equal = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken
      if (!equal && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return undefined
      const [probe, literal] = ts.isTypeOfExpression(condition.left)
        ? [condition.left, condition.right]
        : ts.isTypeOfExpression(condition.right)
          ? [condition.right, condition.left]
          : [undefined, undefined]
      if (!probe || !literal || !ts.isStringLiteral(literal) || probe.expression.getText() !== text) return undefined
      return { name: literal.text, equal }
    }
    for (let child: ts.Node = occurrence, parent = occurrence.parent; parent; child = parent, parent = parent.parent) {
      const [condition, whenTrue, whenFalse] = ts.isConditionalExpression(parent)
        ? [parent.condition, parent.whenTrue, parent.whenFalse]
        : ts.isIfStatement(parent)
          ? [parent.expression, parent.thenStatement, parent.elseStatement]
          : [undefined, undefined, undefined]
      const test = condition ? typeofTest(condition) : undefined
      if (!test || (child !== whenTrue && child !== whenFalse)) continue
      const inTrue = child === whenTrue
      tests.push((primitive) => (primitive === test.name) === (inTrue === test.equal))
    }
    return (primitive) => tests.every((test) => test(primitive))
  }
  const neverOccurrences = new Map<ts.TypeNode, { file: ts.SourceFile; occurrences: NeverOccurrence[] }>()
  const collectNever = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const signature = checker.getResolvedSignature(node)
      for (const [index, argument] of (node.arguments ?? []).entries()) {
        if (!ts.isPropertyAccessExpression(argument)) continue
        if ((checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Never) === 0) continue
        const parameter = signature?.getParameters()[index]
        const parameterType = parameter ? checker.getTypeOfSymbolAtLocation(parameter, node) : undefined
        const spelling = parameterType ? primitiveSpellingOf(parameterType) : undefined
        if (!parameterType || !spelling) continue
        for (const declaration of checker.getSymbolAtLocation(argument.name)?.declarations ?? []) {
          if (!ts.isPropertyDeclaration(declaration) && !ts.isPropertySignature(declaration)) continue
          const typeNode = declaration.type
          const file = declaration.getSourceFile()
          if (!typeNode || file.isDeclarationFile) continue
          const entry = neverOccurrences.get(typeNode) ?? { file, occurrences: [] }
          entry.occurrences.push({ spelling, parameter: parameterType, admitted: guardsAround(argument) })
          neverOccurrences.set(typeNode, entry)
        }
      }
    }
    ts.forEachChild(node, collectNever)
  }
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) collectNever(file)
  for (const [typeNode, { file, occurrences }] of neverOccurrences) {
    const declared = checker.getTypeFromTypeNode(typeNode)
    const candidates = new Set(occurrences.map((occurrence) => occurrence.spelling))
    for (const spelling of [...candidates]) {
      const type = primitiveTypeOf(spelling)
      if (type === undefined || checker.isTypeAssignableTo(type, declared)) candidates.delete(spelling)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const spelling of [...candidates]) {
        const type = primitiveTypeOf(spelling)!
        const breaks = occurrences.some(
          (occurrence) => occurrence.admitted(spelling) && !checker.isTypeAssignableTo(type, occurrence.parameter)
        )
        if (breaks) {
          candidates.delete(spelling)
          changed = true
        }
      }
    }
    for (const spelling of candidates) widenTypeNode(typeNode, file, () => false, spelling)
  }
  // An interface only class instances ever enter holds those instances
  // (`interfaceFlowImplementorsOf`), so a member read through it reads THEIR
  // member. Where the interface spells that member as an anonymous object
  // type, no class can inhabit it: the read rebuilt a fresh object out of
  // each instance's member, and a write through it -- a function doing
  // `target.s.state = next` over `interface WithState
  // { s: { state: string } }` -- landed in the copy. The member's declared
  // type gains each implementor's own member type, spelled as an import type
  // (erased; no module edge), so the read carries the implementor's object.
  const programFiles = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  for (const [declaration, classes] of interfaceFlowImplementorsOf(checker, programFiles)) {
    const home = declaration.getSourceFile()
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeLiteralNode(member.type)) continue
      if (!ts.isIdentifier(member.name)) continue
      const key = member.name.text
      const declaredMember = checker.getTypeFromTypeNode(member.type)
      const spellings: string[] = []
      let complete = true
      for (const implementor of classes) {
        const name = implementor.name?.text
        const symbol = implementor.name ? checker.getSymbolAtLocation(implementor.name) : undefined
        const property = symbol ? checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), key) : undefined
        const hidden = property?.declarations?.some(
          (entry) =>
            (ts.getCombinedModifierFlags(entry) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0 ||
            (ts.isPropertyDeclaration(entry) && ts.isPrivateIdentifier(entry.name))
        )
        if (!name || !symbol || !property || hidden) {
          complete = false
          break
        }
        if (checker.getTypeOfSymbol(property) === declaredMember) continue
        const file = implementor.getSourceFile()
        if (file === home) {
          spellings.push(`${name}[${JSON.stringify(key)}]`)
          continue
        }
        const moduleSymbol = checker.getSymbolAtLocation(file)
        const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol).some((entry) => entry.name === name) : false
        if (!exported) {
          complete = false
          break
        }
        let specifier = relative(dirname(home.fileName), file.fileName).replace(/\.(d\.)?[cm]?tsx?$/, '')
        if (!specifier.startsWith('.')) specifier = `./${specifier}`
        spellings.push(`import(${JSON.stringify(specifier)}).${name}[${JSON.stringify(key)}]`)
      }
      if (!complete) continue
      for (const spelling of spellings) widenTypeNode(member.type, home, () => false, spelling)
    }
  }
  const sourceText = new Map<string, string>()
  for (const [file, typeNodes] of widened) {
    let text = file.text
    const ordered = [...typeNodes].sort(([left], [right]) => right.getStart(file) - left.getStart(file))
    for (const [typeNode, spellings] of ordered) {
      const start = typeNode.getStart(file)
      text = `${text.slice(0, start)}(${text.slice(start, typeNode.end)}) | ${[...spellings].sort().join(' | ')}${text.slice(typeNode.end)}`
    }
    sourceText.set(resolve(file.fileName), text)
  }
  return sourceText
}
