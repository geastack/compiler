import ts from 'typescript'
import type { NativeIterableProvider } from '../../../plugins/native-iterable-providers.js'
import type { ValueFlowIndex } from './model.js'
import { sourceBindingValuesOf } from './value-provenance.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { closedValueOriginAuthorityOf } from './callable-reach.js'
import { closedScriptScopeOf, statedModuleSetOf } from './targets.js'
import { unwrapErasedExpression } from '../producers/erasure.js'

/** Exact source inventory, not a provider's assertion of method immutability.
 * @semanticCategory generic-primitive
 */
export interface SourceNativeIterableIntegrity {
  readonly source: ts.Expression
  readonly provider: NativeIterableProvider
  readonly writes: readonly ts.Node[]
  readonly calls: readonly (ts.CallExpression | ts.NewExpression)[]
}

/** A closed first domain: unknown receivers and opaque consumers remain
 * possible mutation routes. Narrow annotations cannot erase actual alias
 * inputs; source value transport is consulted before native carrier facts.
 */
export const sourceNativeIterableIntegrityOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  source: ts.Expression,
  provider: NativeIterableProvider,
  nativeCarrierOf: (type: ts.Type, at: ts.Node) => string | null,
  readOnlyCalls: ReadonlySet<ts.CallExpression | ts.NewExpression>
): SourceNativeIterableIntegrity | null => {
  if (!statedModuleSetOf(flow) && !closedScriptScopeOf(flow)) return null
  if (nativeCarrierOf(checker.getTypeAtLocation(unwrapErasedExpression(source)), source) !== provider.receiverNative) return null
  const session = sourceValueSessionOf(checker, flow)
  const pending = new Set<ts.Expression>()
  const answers = new Map<ts.Expression, boolean>()
  const mayReach = (input: ts.Expression): boolean => {
    const node = unwrapErasedExpression(input)
    if (answers.has(node)) return answers.get(node)!
    if (pending.has(node)) return true
    pending.add(node)
    let answer = true
    const through = (values: readonly ts.Expression[] | null): boolean => values === null || values.some(mayReach)
    try {
      if (ts.isIdentifier(node)) {
        const declaration = flow.targetOf(node)?.declaration
        if (declaration && ts.isVariableDeclaration(declaration)) {
          answer = through(sourceBindingValuesOf(checker, flow, declaration))
          return answer
        }
        if (declaration && ts.isParameter(declaration)) {
          answer = through(session.parameterSourceExpressionsOf(declaration))
          return answer
        }
      }
      if (ts.isConditionalExpression(node)) {
        answer = mayReach(node.whenTrue) || mayReach(node.whenFalse)
        return answer
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const values = closedValueOriginAuthorityOf(checker, flow, node).fieldValuesOf(node)
        if (values !== null) {
          answer = through(values)
          return answer
        }
        return true
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isIdentifier(node)) return true
      if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
        answer = false
        return false
      }
      const type = checker.getTypeAtLocation(node)
      if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true
      if (
        (type.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.ESSymbolLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Never)) !==
        0
      ) {
        answer = false
        return false
      }
      // A stated unrelated native type is not an allocation-disjointness
      // witness. An assertion or user getter could have supplied that type.
      return true
    } catch {
      // An origin query that cannot close is not evidence of disjointness.
      return true
    } finally {
      pending.delete(node)
      answers.set(node, answer)
    }
  }
  // A property read can invoke an ambient/source accessor without a syntactic
  // call site. Only closed source data origins or the already authenticated
  // consumer member may bypass this first-domain refusal.
  const writeSites = new Set(flow.allWrites.map((write) => write.propertyAccess))
  const consumerMembers = new Set([...readOnlyCalls].map((call) => unwrapErasedExpression(call.expression)))
  for (const access of flow.propertyAccesses) {
    if (ts.findAncestor(access, (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) continue
    if (consumerMembers.has(access) || writeSites.has(access)) continue
    const values = closedValueOriginAuthorityOf(checker, flow, access).fieldValuesOf(access)
    if (values === null) return null
  }
  const writes: ts.Node[] = []
  for (const write of flow.allWrites) {
    if (!write.propertyAccess) continue
    writes.push(write.site)
    if (mayReach(write.propertyAccess.expression)) return null
  }
  const calls: (ts.CallExpression | ts.NewExpression)[] = []
  for (const site of flow.calls) {
    calls.push(site.call)
    if (readOnlyCalls.has(site.call)) continue
    if (ts.isCallExpression(site.call)) {
      const targets = session.invocationTargetsOf(site.call)
      if (targets?.length && targets.every((target) => !target.getSourceFile().isDeclarationFile)) continue
    }
    // A foreign call can discover a retained collection through a container,
    // closure, global or prototype, even with no direct collection operand.
    // Only an independently authenticated effect contract can admit it.
    return null
  }
  return { source, provider, writes, calls }
}
