import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * A private static type predicate's `unknown` parameter, restated as the type
 * its callers actually pass.
 *
 * `private static is(value: unknown): value is Ident` exists to TEST a value,
 * so its parameter is `unknown`, and `unknown` is the dynamic carrier: every
 * caller boxes its argument into a `gea::Value` and a callable object is built
 * per call. When the method is `private`, every reference to it is inside the
 * class's own file; if each is a direct call whose argument the checker types
 * without `any`, the parameter only ever receives those types, and the same
 * body over their union narrows exactly as it narrowed `unknown`. An
 * `Ident.is(input)` called only with typed arguments is the shape.
 *
 * Fail-closed: the box stays unless ALL of these hold.
 * - a `private static` method of a class declaration, with a body, not
 *   overloaded, with a written `p is T` predicate naming an annotated,
 *   non-rest, non-optional parameter declared exactly `unknown`;
 * - every reference to the member in the program is the callee of a plain call
 *   whose argument at that position is a non-spread expression the checker
 *   types as neither `any`, `unknown` nor `never`; an unresolved access, a
 *   string-literal element access of its name, or a computed key over an
 *   untyped receiver withdraws it (an unknown caller);
 * - the parameter is only TESTED in the body (`typeof`, `in`, comparisons,
 *   property reads); handing it to a call, storing it, returning it or
 *   spreading it is a dynamic sink and withdraws it;
 * - the union of the argument types and the predicate's own type is writable
 *   as an annotation.
 */

interface Candidate {
  readonly method: ts.MethodDeclaration
  readonly parameter: ts.ParameterDeclaration
  readonly index: number
  readonly predicateType: ts.Type
  readonly calls: ts.CallExpression[]
  viable: boolean
}

const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean =>
  ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false

const isTopType = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0

const testedParameterOf = (
  checker: ts.TypeChecker,
  method: ts.MethodDeclaration
): { readonly parameter: ts.ParameterDeclaration; readonly index: number; readonly predicateType: ts.Type } | null => {
  const predicate = method.type
  if (
    !predicate ||
    !ts.isTypePredicateNode(predicate) ||
    predicate.assertsModifier ||
    !ts.isIdentifier(predicate.parameterName) ||
    !predicate.type
  )
    return null
  const name = predicate.parameterName.text
  const index = method.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)
  const parameter = method.parameters[index]
  if (!parameter || !parameter.type || parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) return null
  if (parameter.type.kind !== ts.SyntaxKind.UnknownKeyword) return null
  return { parameter, index, predicateType: checker.getTypeFromTypeNode(predicate.type) }
}

/** Whether every read of the parameter in the body only tests it. */
const onlyTested = (
  checker: ts.TypeChecker,
  candidate: { readonly method: ts.MethodDeclaration; readonly parameter: ts.ParameterDeclaration }
): boolean => {
  const symbol = checker.getSymbolAtLocation(candidate.parameter.name)
  if (!symbol || !candidate.method.body) return false
  let tested = true
  const visit = (node: ts.Node): void => {
    if (!tested) return
    if (ts.isIdentifier(node) && node !== candidate.parameter.name && checker.getSymbolAtLocation(node) === symbol) {
      const parent = node.parent
      const ok =
        ts.isTypeOfExpression(parent) ||
        (ts.isBinaryExpression(parent) &&
          (parent.operatorToken.kind === ts.SyntaxKind.InKeyword ||
            parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) ||
        (ts.isPropertyAccessExpression(parent) && parent.expression === node)
      // A predicate body returns booleans built from tests; the parameter as a
      // whole value (call argument, return, store, spread) is a sink.
      if (!ok) tested = false
    }
    ts.forEachChild(node, visit)
  }
  visit(candidate.method.body)
  return tested
}

const candidatesIn = (checker: ts.TypeChecker, file: ts.SourceFile): ReadonlyMap<ts.Symbol, Candidate> => {
  const found = new Map<ts.Symbol, Candidate>()
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name) || member.typeParameters) continue
        if (!hasModifier(member, ts.SyntaxKind.PrivateKeyword) || !hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue
        const symbol = checker.getSymbolAtLocation(member.name)
        if (!symbol || symbol.declarations?.length !== 1) continue
        const tested = testedParameterOf(checker, member)
        if (tested && onlyTested(checker, { method: member, parameter: tested.parameter }))
          found.set(symbol, { method: member, ...tested, calls: [], viable: true })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const calleeCallOf = (node: ts.PropertyAccessExpression): ts.CallExpression | undefined =>
  ts.isCallExpression(node.parent) &&
  node.parent.expression === node &&
  node.parent.questionDotToken === undefined &&
  node.questionDotToken === undefined
    ? node.parent
    : undefined

export const knownCallerPredicateParameters = (program: ts.Program, checker: ts.TypeChecker): ReadonlyMap<string, string> => {
  const candidates = new Map<ts.Symbol, Candidate>()
  const byName = new Map<string, Candidate[]>()
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue
    for (const [symbol, candidate] of candidatesIn(checker, file)) {
      candidates.set(symbol, candidate)
      const name = (candidate.method.name as ts.Identifier).text
      byName.set(name, [...(byName.get(name) ?? []), candidate])
    }
  }
  if (candidates.size === 0) return new Map()

  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && !ts.isPrivateIdentifier(node.name)) {
        const named = byName.get(node.name.text)
        if (named) {
          const symbol = checker.getSymbolAtLocation(node.name)
          const owner = symbol ? candidates.get(symbol) : undefined
          if (owner) {
            const call = calleeCallOf(node)
            const argument = call?.arguments[owner.index]
            if (
              !call ||
              argument === undefined ||
              call.arguments.slice(0, owner.index + 1).some(ts.isSpreadElement) ||
              isTopType(checker.getTypeAtLocation(argument))
            )
              owner.viable = false
            else owner.calls.push(call)
          } else if (symbol === undefined) {
            for (const candidate of named) candidate.viable = false
          }
        }
      } else if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression
        if (ts.isStringLiteralLike(key)) {
          for (const candidate of byName.get(key.text) ?? []) candidate.viable = false
        } else if (!ts.isNumericLiteral(key) && isTopType(checker.getTypeAtLocation(node.expression))) {
          for (const candidate of candidates.values()) candidate.viable = false
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  const edits = new Map<ts.SourceFile, { readonly at: number; readonly end: number; readonly text: string }[]>()
  for (const candidate of candidates.values()) {
    if (!candidate.viable || candidate.calls.length === 0) continue
    const types = [
      ...candidate.calls.map((call) => checker.getTypeAtLocation(call.arguments[candidate.index] as ts.Expression)),
      candidate.predicateType
    ]
    // The predicate's own type joins the union: a predicate must narrow to a subtype of its parameter.
    const text = [...new Set(types.map((type) => checker.typeToString(type, candidate.method, ts.TypeFormatFlags.NoTruncation)))]
    if (text.some((spelling) => spelling.includes('import(') || spelling.includes('typeof '))) continue
    const file = candidate.method.getSourceFile()
    const list = edits.get(file) ?? []
    list.push({ at: candidate.parameter.type!.getStart(file), end: candidate.parameter.type!.end, text: text.join(' | ') })
    edits.set(file, list)
  }

  const rewritten = new Map<string, string>()
  for (const [file, list] of edits) {
    let text = file.text
    for (const edit of [...list].sort((left, right) => right.at - left.at))
      text = `${text.slice(0, edit.at)}${edit.text}${text.slice(edit.end)}`
    rewritten.set(resolve(file.fileName), text)
  }
  return rewritten
}
