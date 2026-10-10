import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * A plain record that spreads a class instance, stored where the statement
 * names that CLASS as its only home.
 *
 * A generic logging helper that logs `{ name, ...args[0] }` as
 * `StartedEvent | LoggableFailedEvent | LoggableSucceededEvent`. In the copy
 * that spreads a started event the literal is the event's own data fields: an
 * object, never an instance (no class getter, `instanceof` false), and both record arms require a
 * `duration` it lacks. The checker allows it only because the generic body
 * types the literal `any`. A class arm is nominal -- a flat struct of exactly
 * that class -- so no arm of the statement can hold the record, and building an
 * instance from it would invent the getter and the prototype node never has.
 *
 * The record keeps its own carrier instead, as one more arm of EVERY union the
 * value provably reaches: the binding, the parameters it is handed to (through
 * a bound method's labeled rest tuple too -- `debug = this.log.bind(this,
 * 'debug')`), and each read of those, narrowed or not. The added arm is keyed
 * by the union TYPE, not by the slot, because one union type is one carrier
 * everywhere it appears: `log`'s `message: Loggable | string` and the bound
 * `debug` field's callable type share the very same checker union, and a
 * `.bind` frame must state its source's suffix convention exactly. Adding an
 * arm is always a superset -- every value the statement already admits still
 * converts exactly as before -- so a union elsewhere that happens to be the
 * same type only carries an arm it never holds.
 *
 * What makes keeping the arm beside the class sound is that the program cannot
 * tell the two apart on this flow: a record that spreads a `C` differs from a
 * `C` only in the keys the literal wrote that `C` lacks, in `C`'s accessors and
 * methods, and in its prototype. Where no narrowing condition on the flow
 * observes one of those, the checker's own narrowing treats the record exactly
 * as it treats `C`, so the record is live at a read precisely where `C` is.
 * Anything the census cannot follow -- a value returned, stored into a
 * container, handed to a callable whose other bodies share the slot, or read
 * down to the bare class -- withdraws the arm, and the certification refusal
 * stands.
 */
export interface RecordStandInArmCensus {
  /** The records a union type carries beside its declared arms, or `null`. */
  readonly armsOf: (union: ts.Type) => readonly ts.Type[] | null
  /**
   * The arms of one READ the checker narrowed down to the bare class --
   * `switch (logObject.name) { case COMMAND_STARTED: ... }` -- where the
   * record is live exactly as the class is: the class and the record. A class
   * alone is not a union type, and widening every place it is named is not
   * what this read needs.
   */
  readonly armsAt: (node: ts.Node) => readonly ts.Type[] | null
  /** The records a seed literal may build, in whichever copy its shape is one of them. */
  readonly recordsOf: (literal: ts.Node) => readonly ts.Type[] | null
}

export const emptyRecordStandInArmCensus: RecordStandInArmCensus = { armsOf: () => null, armsAt: () => null, recordsOf: () => null }

interface StandIn {
  readonly record: ts.Type
  readonly standIn: ts.Type
  /** The keys whose presence tells the record from its class: the literal's own, the class's accessors and methods. */
  readonly distinguishing: ReadonlySet<string>
}

/** The internal, present-on-every-pinned-version constructor `field-bindings.ts` already relies on. */
interface AnonymousTypeConstructingChecker {
  createAnonymousType(
    symbol: ts.Symbol | undefined,
    members: ts.SymbolTable,
    callSignatures: readonly ts.Signature[],
    constructSignatures: readonly ts.Signature[],
    indexInfos: readonly ts.IndexInfo[]
  ): ts.Type
}

const isClassInstanceType = (type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.Object) !== 0 && ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0

const presentMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)

/** An own data member a spread copies: never an accessor or method, never a `#private` name. */
const isSpreadDataMember = (symbol: ts.Symbol): boolean =>
  (symbol.flags & ts.SymbolFlags.Property) !== 0 &&
  (symbol.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) === 0 &&
  !(symbol.declarations ?? []).some((declaration) => ts.isPropertyDeclaration(declaration) && ts.isPrivateIdentifier(declaration.name))

const containsTypeParameter = (checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean => {
  if (depth > 4) return true
  if (type.flags & ts.TypeFlags.TypeParameter) return true
  if (type.isUnionOrIntersection()) return type.types.some((member) => containsTypeParameter(checker, member, depth + 1))
  if ((type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0)
    return checker.getTypeArguments(type as ts.TypeReference).some((argument) => containsTypeParameter(checker, argument, depth + 1))
  return false
}

const functionOwning = (node: ts.Node): ts.SignatureDeclaration | null => {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  return current ?? null
}

/**
 * A callable whose parameter cells no other body shares: a free function, a
 * function or arrow expression, or a private method. An overridable method's
 * cell is the ABI every override shares -- `record-home-arms.ts` draws the
 * same line.
 */
const isClosedCallable = (declaration: ts.SignatureDeclaration): boolean =>
  ((ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) &&
    declaration.body !== undefined) ||
  (ts.isMethodDeclaration(declaration) &&
    declaration.body !== undefined &&
    (ts.isPrivateIdentifier(declaration.name) || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0))

const skipTransparent = (node: ts.Node): ts.Node => {
  let current = node
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent
  return current
}

export const censusRecordStandInArms = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  valueFlow: ValueFlowIndex
): RecordStandInArmCensus => {
  const constructing = checker as unknown as Partial<AnonymousTypeConstructingChecker>
  if (typeof constructing.createAnonymousType !== 'function') return emptyRecordStandInArmCensus

  const callsOf = new Map<ts.Node, (ts.CallExpression | ts.NewExpression)[]>()
  for (const site of valueFlow.calls) {
    const declaration = site.checkerDeclaration
    if (!declaration) continue
    const group = callsOf.get(declaration)
    if (group) group.push(site.call)
    else callsOf.set(declaration, [site.call])
  }

  /**
   * The spread source at one call of the literal's own callable: a parameter,
   * or one element of a rest parameter, read off the signature the checker
   * resolved that call to. The literal's own type is `any` inside a generic
   * body; the call is where the hole is filled.
   */
  const spreadSourceAtCall = (
    owner: ts.SignatureDeclaration,
    expression: ts.Expression,
    call: ts.CallExpression | ts.NewExpression
  ): ts.Type | null => {
    let reference = expression
    let element: number | null = null
    if (ts.isElementAccessExpression(expression) && ts.isNumericLiteral(expression.argumentExpression)) {
      reference = expression.expression
      element = Number(expression.argumentExpression.text)
    }
    if (!ts.isIdentifier(reference)) return null
    const declaration = checker.getSymbolAtLocation(reference)?.valueDeclaration
    if (!declaration || !ts.isParameter(declaration) || declaration.parent !== owner) return null
    const index = owner.parameters.indexOf(declaration)
    const signature = checker.getResolvedSignature(call)
    const parameter = signature?.getParameters()[index]
    if (!signature || !parameter) return null
    const type = checker.getTypeOfSymbol(parameter)
    if (element === null) return declaration.dotDotDotToken ? null : type
    if (!declaration.dotDotDotToken || !checker.isTupleType(type)) return null
    return checker.getTypeArguments(type as ts.TypeReference)[element] ?? null
  }

  /** The record a literal `{ written..., ...instance }` builds, keys in the order the object holds them. */
  const recordOf = (literal: ts.ObjectLiteralExpression, sourceOf: (expression: ts.Expression) => ts.Type | null): StandIn | null => {
    const members = new Map<string, ts.Symbol>()
    const written = new Set<string>()
    let standIn: ts.Type | null = null
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        const source = sourceOf(property.expression)
        if (!source || standIn || !isClassInstanceType(source) || containsTypeParameter(checker, source)) return null
        standIn = source
        for (const member of checker.getPropertiesOfType(source)) {
          if (isSpreadDataMember(member)) members.set(member.getName(), member)
        }
        continue
      }
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null
      if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return null
      const symbol = checker.getSymbolAtLocation(property.name)
      if (!symbol) return null
      members.set(property.name.text, symbol)
      written.add(property.name.text)
    }
    if (!standIn) return null
    const classKeys = new Set(checker.getPropertiesOfType(standIn).map((member) => member.getName()))
    const distinguishing = new Set<string>()
    for (const key of written) if (!classKeys.has(key)) distinguishing.add(key)
    for (const member of checker.getPropertiesOfType(standIn)) if (!isSpreadDataMember(member)) distinguishing.add(member.getName())
    const table = new Map<ts.__String, ts.Symbol>()
    for (const [, symbol] of members) table.set(symbol.escapedName, symbol)
    const record = constructing.createAnonymousType!(undefined, table as ts.SymbolTable, [], [], [])
    return { record, standIn, distinguishing }
  }

  /** Whether a narrowing condition reads `node`: an `if`/loop/`?:`/`switch` test, or a type predicate's returned answer. */
  const narrows = (node: ts.Node): boolean => {
    let current = node
    for (;;) {
      const parent = current.parent
      if (!parent) return false
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isTypeOfExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
        (ts.isPropertyAccessExpression(parent) && parent.expression === current) ||
        (ts.isElementAccessExpression(parent) && parent.expression === current)
      ) {
        current = parent
        continue
      }
      if (ts.isBinaryExpression(parent)) {
        switch (parent.operatorToken.kind) {
          case ts.SyntaxKind.AmpersandAmpersandToken:
          case ts.SyntaxKind.BarBarToken:
          case ts.SyntaxKind.QuestionQuestionToken:
          case ts.SyntaxKind.EqualsEqualsEqualsToken:
          case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          case ts.SyntaxKind.EqualsEqualsToken:
          case ts.SyntaxKind.ExclamationEqualsToken:
          case ts.SyntaxKind.InstanceOfKeyword:
          case ts.SyntaxKind.InKeyword:
            current = parent
            continue
          default:
            return false
        }
      }
      if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === current
      if (ts.isForStatement(parent)) return parent.condition === current
      if (ts.isConditionalExpression(parent)) return parent.condition === current
      if (ts.isSwitchStatement(parent)) return parent.expression === current
      if (ts.isCaseClause(parent)) return parent.expression === current
      const returned = ts.isReturnStatement(parent)
        ? functionOwning(parent)
        : ts.isArrowFunction(parent) && parent.body === current
          ? parent
          : null
      if (returned) return returned.type !== undefined && ts.isTypePredicateNode(returned.type)
      return false
    }
  }

  const keyOf = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null => {
    if (ts.isPropertyAccessExpression(access)) return ts.isIdentifier(access.name) ? access.name.text : null
    return ts.isStringLiteralLike(access.argumentExpression) || ts.isNumericLiteral(access.argumentExpression)
      ? access.argumentExpression.text
      : null
  }

  /** The parameter a call argument lands in, through a bound or rest-taking frame's labeled tuple too. */
  const parameterOfArgument = (call: ts.CallExpression | ts.NewExpression, argument: ts.Expression): ts.ParameterDeclaration | null => {
    const argumentsList: readonly ts.Expression[] = call.arguments ?? []
    const index = argumentsList.indexOf(argument)
    if (index < 0 || argumentsList.slice(0, index + 1).some(ts.isSpreadElement)) return null
    const signature = checker.getResolvedSignature(call)
    if (!signature) return null
    const parameters = signature.getParameters()
    const last = parameters[parameters.length - 1]
    const lastDeclaration = last?.valueDeclaration
    const restAt = lastDeclaration && ts.isParameter(lastDeclaration) && lastDeclaration.dotDotDotToken ? parameters.length - 1 : null
    if (restAt === null || index < restAt) {
      const declaration = parameters[index]?.valueDeclaration
      return declaration && ts.isParameter(declaration) && !declaration.dotDotDotToken ? declaration : null
    }
    const rest = checker.getTypeOfSymbol(last!)
    if (!checker.isTupleType(rest)) return null
    const labeled = (rest as ts.TupleTypeReference).target.labeledElementDeclarations?.[index - restAt]
    return labeled && ts.isParameter(labeled) && !labeled.dotDotDotToken ? labeled : null
  }

  /**
   * Follows one seed's record through every union it reaches. `null` when
   * the flow leaves what this can follow; otherwise the union types that
   * must carry the record.
   */
  const follow = (
    seedSymbol: ts.Symbol,
    seedScope: ts.Node,
    standIn: StandIn
  ): { readonly unions: ReadonlySet<ts.Type>; readonly reads: ReadonlySet<ts.Node> } | null => {
    const unions = new Set<ts.Type>()
    const reads = new Set<ts.Node>()
    const cells = new Map<ts.Symbol, ts.Node>()
    const pending: ts.Symbol[] = []
    let poisoned = false
    const poison = (): void => {
      poisoned = true
    }
    const addCell = (symbol: ts.Symbol, scope: ts.Node): void => {
      if (cells.has(symbol)) return
      cells.set(symbol, scope)
      pending.push(symbol)
    }
    /**
     * Records the type a slot or read carries, `false` when the record is not
     * live there. A SLOT stated as the bare class cannot take the record --
     * its carrier is the class -- but a READ narrowed to it can, as a read of
     * its own.
     */
    const carries = (type: ts.Type, read: ts.Node | null): boolean => {
      const members = presentMembersOf(type)
      if (!members.includes(standIn.standIn)) return false
      if (type.isUnion()) unions.add(type)
      else if (read !== null && type === standIn.standIn) reads.add(read)
      else {
        poison()
        return false
      }
      return true
    }
    const observe = (use: ts.Node, key: string | null): void => {
      if (!narrows(use)) return
      if (key === null || standIn.distinguishing.has(key)) poison()
    }
    const track = (expression: ts.Expression): void => {
      if (poisoned || !carries(checker.getTypeAtLocation(expression), expression)) return
      const at = skipTransparent(expression)
      const parent = at.parent
      if (!parent) return
      if (
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) {
        track(parent)
        return
      }
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== at) {
        const declaration = parameterOfArgument(parent, at as ts.Expression)
        const signature = checker.getResolvedSignature(parent)
        if (!declaration) {
          // A value handed where the census cannot see the cell: fine when no
          // statement there names the class -- the conversion at the call is
          // then certification's to install or refuse -- and when the callee
          // cannot narrow the caller's reference through a predicate.
          if (signature && checker.getTypePredicateOfSignature(signature)) poison()
          return
        }
        const slot = checker.getTypeAtLocation(declaration)
        if (!presentMembersOf(slot).includes(standIn.standIn)) {
          if (signature && checker.getTypePredicateOfSignature(signature)) poison()
          return
        }
        const owner = declaration.parent
        const symbol = ts.isIdentifier(declaration.name) ? checker.getSymbolAtLocation(declaration.name) : undefined
        if (!symbol || !isClosedCallable(owner) || containsTypeParameter(checker, slot) || !carries(slot, null)) {
          poison()
          return
        }
        addCell(symbol, owner)
        return
      }
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === at) {
        observe(parent, keyOf(parent))
        return
      }
      if (ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind
        if (operator === ts.SyntaxKind.InstanceOfKeyword) {
          if (parent.left === at) observe(parent, null)
          return
        }
        if (operator === ts.SyntaxKind.InKeyword) {
          if (parent.right === at) observe(parent, ts.isStringLiteralLike(parent.left) ? parent.left.text : null)
          return
        }
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken ||
          (operator === ts.SyntaxKind.CommaToken && parent.right === at)
        ) {
          track(parent)
          return
        }
        if (operator === ts.SyntaxKind.EqualsToken) {
          if (parent.left === at) return
          const target = checker.getSymbolAtLocation(parent.left)
          const declaration = target?.valueDeclaration
          if (
            !ts.isIdentifier(parent.left) ||
            !target ||
            !declaration ||
            !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
          ) {
            poison()
            return
          }
          if (!carries(checker.getTypeOfSymbol(target), null)) return
          addCell(target, functionOwning(declaration) ?? declaration.getSourceFile())
          return
        }
        // Comparison, arithmetic, `typeof x === ...`: the value is observed, not carried.
        return
      }
      if (ts.isConditionalExpression(parent)) {
        if (parent.condition !== at) track(parent)
        return
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === at) {
        const symbol = ts.isIdentifier(parent.name) ? checker.getSymbolAtLocation(parent.name) : undefined
        if (!symbol) {
          poison()
          return
        }
        if (!carries(checker.getTypeOfSymbol(symbol), null)) return
        addCell(symbol, functionOwning(parent) ?? parent.getSourceFile())
        return
      }
      if (
        ts.isTemplateSpan(parent) ||
        ts.isTypeOfExpression(parent) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isExpressionStatement(parent) ||
        ts.isIfStatement(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent) ||
        ts.isSwitchStatement(parent) ||
        ts.isCaseClause(parent) ||
        ts.isSpreadAssignment(parent)
      )
        return
      poison()
    }
    addCell(seedSymbol, seedScope)
    while (pending.length > 0 && !poisoned) {
      const symbol = pending.pop()!
      const scope = cells.get(symbol)!
      if (!carries(checker.getTypeOfSymbol(symbol), null)) {
        poison()
        break
      }
      const visit = (node: ts.Node): void => {
        if (poisoned) return
        if (ts.isTypeNode(node)) return
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
          const parent = node.parent
          const declares = (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node
          const written = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          if (!declares && !written) {
            if (ts.isShorthandPropertyAssignment(parent)) poison()
            else track(node)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(scope)
    }
    return poisoned ? null : { unions, reads }
  }

  const arms = new Map<ts.Type, ts.Type[]>()
  const readArms = new Map<ts.Node, ts.Type[]>()
  const literalRecords = new Map<ts.Node, ts.Type[]>()
  const add = <Key>(table: Map<Key, ts.Type[]>, key: Key, record: ts.Type): void => {
    const held = table.get(key)
    if (!held) table.set(key, [record])
    else if (!held.includes(record)) held.push(record)
  }
  const seed = (declaration: ts.VariableDeclaration): void => {
    if (!declaration.type || !declaration.initializer || !ts.isIdentifier(declaration.name)) return
    const literal = skipParentheses(declaration.initializer)
    if (!ts.isObjectLiteralExpression(literal) || !literal.properties.some(ts.isSpreadAssignment)) return
    const declared = checker.getTypeFromTypeNode(declaration.type)
    if (!declared.isUnion()) return
    const symbol = checker.getSymbolAtLocation(declaration.name)
    const owner = functionOwning(declaration)
    if (!symbol) return
    const records: StandIn[] = []
    const literalType = checker.getTypeAtLocation(literal)
    if ((literalType.flags & ts.TypeFlags.Any) === 0) {
      const record = recordOf(literal, (expression) => checker.getTypeAtLocation(expression))
      if (record) records.push(record)
    } else if (owner) {
      const seen = new Set<ts.Type>()
      for (const call of callsOf.get(owner) ?? []) {
        const record = recordOf(literal, (expression) => spreadSourceAtCall(owner, expression, call))
        if (!record || seen.has(record.standIn)) continue
        seen.add(record.standIn)
        records.push(record)
      }
    }
    for (const record of records) {
      const members = presentMembersOf(declared)
      if (!members.includes(record.standIn)) continue
      if (members.some((member) => !isClassInstanceType(member) && checker.isTypeAssignableTo(record.record, member))) continue
      const followed = follow(symbol, owner ?? declaration.getSourceFile(), record)
      if (process.env['GEA_BINDING_DEBUG'])
        console.error(
          `[RECORD-STAND-IN] ${checker.typeToString(record.standIn)} :: ${
            followed ? [...followed.unions].map((union) => checker.typeToString(union)).join(' ; ') : 'withdrawn'
          }${followed && followed.reads.size > 0 ? ` (+${followed.reads.size} bare read(s))` : ''}`
        )
      if (!followed) continue
      for (const union of followed.unions) add(arms, union, record.record)
      for (const read of followed.reads) {
        add(readArms, read, record.standIn)
        add(readArms, read, record.record)
      }
      add(literalRecords, literal, record.record)
    }
  }
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node)) return
      if (ts.isVariableDeclaration(node)) seed(node)
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }
  if (arms.size === 0 && readArms.size === 0) return emptyRecordStandInArmCensus
  return {
    armsOf: (union) => arms.get(union) ?? null,
    armsAt: (node) => readArms.get(node) ?? null,
    recordsOf: (literal) => literalRecords.get(literal) ?? null
  }
}

const skipParentheses = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? skipParentheses(expression.expression) : expression
