import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { sourceBindingWritesAreComplete } from './value-provenance.js'
import { inProgramImportReferencesOf } from './export-importers.js'
import { isModuleExportedDeclaration, isTypePositionReference, runtimeParametersOf } from './targets.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { literalSourcePropertyKeyOf } from './source-property-key.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import { sourceValueSessionOf, type SourceConstructorProxyResultIdentity } from './source-value-session.js'

export interface SourceProxyOperationFrame {
  readonly construction: ts.NewExpression
  readonly trap: string
  /** The actual target operand, never the returned Proxy identity. */
  readonly target: ts.Expression
}

const propertyKey = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : ts.isComputedPropertyName(name)
      ? literalSourcePropertyKeyOf(name.expression)
      : null

const trapNames: ReadonlySet<string> = new Set([
  'get',
  'set',
  'has',
  'deleteProperty',
  'defineProperty',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'setPrototypeOf',
  'isExtensible',
  'preventExtensions',
  'ownKeys',
  'apply',
  'construct'
])

/** A first trap argument supplied by authenticated native Proxy operations.
 * This is deliberately not a source call/constructor frame. The query closes
 * every use of the particular handler allocation; another possible handler at
 * the same construction does not change this allocation's operation target.
 * It makes no claim about target origin, handler results, or other arguments.
 * @semanticCategory generic-primitive
 */
export const sourceProxyOperationFramesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  parameter: ts.ParameterDeclaration
): readonly SourceProxyOperationFrame[] | null => {
  const body = parameter.parent
  if (runtimeParametersOf(body)[0] !== parameter || parameter.initializer || parameter.dotDotDotToken) return null
  if (flow.writesToDeclaration(parameter).some((write) => write.slot === 'whole' && write.edge !== 'call-argument')) return null
  const property = ts.isMethodDeclaration(body)
    ? body
    : (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
        ts.isPropertyAssignment(body.parent) &&
        body.parent.initializer === body
      ? body.parent
      : null
  if (!property || !ts.isObjectLiteralExpression(property.parent)) return null
  const handler = property.parent
  const trap = propertyKey(property.name)
  if (trap === null || !trapNames.has(trap)) return null
  // Accessors, spreads, duplicate traps and detached callable values need
  // their own effect/invocation proof, not a spelling-based exemption.
  const names = new Set<string>()
  for (const member of handler.properties) {
    if (!ts.isMethodDeclaration(member) && !ts.isPropertyAssignment(member)) return null
    const name = propertyKey(member.name)
    if (name === null || !trapNames.has(name) || names.has(name)) return null
    names.add(name)
    const callable = ts.isMethodDeclaration(member) ? member : unwrapErasedExpression(member.initializer)
    if (!ts.isMethodDeclaration(callable) && !ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable)) return null
    if (ts.isFunctionExpression(callable) && callable.name) return null
    let hiddenReceiverUse = false
    const inspect = (node: ts.Node): void => {
      // A native trap receiver is the handler. Calling another trap through
      // `this` or arguments.callee would add a non-native argument route.
      if (
        node.kind === ts.SyntaxKind.ThisKeyword ||
        node.kind === ts.SyntaxKind.SuperKeyword ||
        (ts.isIdentifier(node) && (node.text === 'arguments' || node.text === 'eval'))
      )
        hiddenReceiverUse = true
      ts.forEachChild(node, inspect)
    }
    inspect(callable)
    if (hiddenReceiverUse) return null
  }
  const pending: ts.Expression[] = [handler]
  const visited = new Set<ts.Node>()
  const frames = new Map<ts.NewExpression, SourceProxyOperationFrame>()
  const binding = (declaration: ts.VariableDeclaration): boolean => {
    if (visited.has(declaration)) return true
    visited.add(declaration)
    if (!ts.isIdentifier(declaration.name) || !sourceBindingWritesAreComplete(checker, flow, declaration)) return false
    const imported = isModuleExportedDeclaration(checker, declaration, null) ? inProgramImportReferencesOf(checker, flow, declaration) : []
    if (imported === null) return false
    for (const reference of [...flow.referencesToDeclaration(declaration), ...imported]) {
      if (reference === declaration.name || isTypePositionReference(reference)) continue
      if (!ts.isExpression(reference)) return false
      pending.push(reference)
    }
    return true
  }
  while (pending.length > 0) {
    const expression = pending.pop()!
    const reference = outermostErasureOf(expression)
    if (visited.has(reference)) continue
    visited.add(reference)
    const parent = reference.parent
    if (!parent) return null
    if (ts.isVariableDeclaration(parent) && parent.initializer === reference) {
      if (!binding(parent)) return null
      continue
    }
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === reference || parent.whenFalse === reference)) {
      pending.push(parent)
      continue
    }
    if (ts.isReturnStatement(parent) && parent.expression === reference) {
      let owner: ts.Node | undefined = parent.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      if (!owner || !ts.isFunctionLike(owner)) return null
      // An unentered source getter/export cannot hand this handler outside
      // the stated program. Entered factories need full return-use transport.
      const callers = sourceValueSessionOf(checker, flow).callerSitesOf(owner as ts.SignatureDeclaration)
      if (callers === null || callers.length !== 0) return null
      continue
    }
    if (ts.isNewExpression(parent) && parent.arguments?.length === 2 && parent.arguments[1] === reference) {
      const [target] = parent.arguments
      if (!target || ts.isSpreadElement(target)) return null
      const callee = unwrapErasedExpression(parent.expression)
      const symbol = checker.getSymbolAtLocation(callee)
      const declaration = checker.getResolvedSignature(parent)?.getDeclaration()
      const owner = declaration?.parent
      if (
        !ts.isIdentifier(callee) ||
        callee.text !== 'Proxy' ||
        !symbol?.valueDeclaration?.getSourceFile().hasNoDefaultLib ||
        !owner ||
        !ts.isInterfaceDeclaration(owner) ||
        owner.name.text !== 'ProxyConstructor' ||
        !owner.getSourceFile().hasNoDefaultLib ||
        deferredIntrinsicProtocolLedgerOf(flow)?.requireStandardGlobalBinding('Proxy', parent) !== true
      )
        return null
      frames.set(parent, { construction: parent, trap, target })
      continue
    }
    // Property reads can expose the trap as an ordinary callable; writes can
    // replace it. Unknown calls/exports and all other consumers remain open.
    return null
  }
  return [...frames.values()]
}

/** One native [[Get]] entry. The receiver is the returned Proxy, while the
 * target is the distinct construction operand recorded by its result frame.
 * This names the real trap and operation roles; it does NOT answer the trap's
 * completion, a target descriptor, or an eventual callable's logical this.
 * @semanticCategory generic-primitive
 */
export interface SourceProxyGetOperation {
  readonly operation: ts.PropertyAccessExpression | ts.ElementAccessExpression
  readonly context: SourceConstructorProxyResultIdentity
  readonly body: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction
  readonly key: string
  readonly receiver: ts.NewExpression
}

/** Direct-new property reads are the first exact operation-entry domain.
 * Aliased results, symbols, optional access and absent/inherited traps need
 * their own source transport/descriptor proof and refuse here. No declared
 * class member is substituted for a Proxy trap's answer.
 * @semanticCategory generic-primitive
 */
export const sourceProxyGetOperationsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  operation: ts.PropertyAccessExpression | ts.ElementAccessExpression
): readonly SourceProxyGetOperation[] | null => {
  if (operation.questionDotToken) return null
  const construction = unwrapErasedExpression(operation.expression)
  const key = ts.isPropertyAccessExpression(operation) ? operation.name.text : literalSourcePropertyKeyOf(operation.argumentExpression)
  if (!ts.isNewExpression(construction) || key === null) return null
  const contexts = sourceValueSessionOf(checker, flow).constructorProxyResultIdentitiesOf(construction)
  if (!contexts?.length) return null
  const answer: SourceProxyGetOperation[] = []
  for (const context of contexts) {
    for (const handler of context.handlers) {
      if (!ts.isObjectLiteralExpression(handler)) return null
      const member = handler.properties.find(
        (candidate) => (ts.isMethodDeclaration(candidate) || ts.isPropertyAssignment(candidate)) && propertyKey(candidate.name) === 'get'
      )
      const body =
        member && ts.isMethodDeclaration(member)
          ? member
          : member && ts.isPropertyAssignment(member)
            ? unwrapErasedExpression(member.initializer)
            : null
      if (!body || (!ts.isMethodDeclaration(body) && !ts.isArrowFunction(body) && !ts.isFunctionExpression(body))) return null
      const first = runtimeParametersOf(body)[0]
      if (!first) return null
      const entries = sourceProxyOperationFramesOf(checker, flow, first)
      if (!entries?.some((entry) => entry.trap === 'get' && entry.construction === context.result)) return null
      answer.push({ operation, context, body, key, receiver: context.result })
    }
  }
  return answer.length ? answer : null
}
