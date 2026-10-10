import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { isGlobalObjectConstructor } from '../derived-expression-type.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { literalSourcePropertyKeyOf } from './source-property-key.js'
import { sourceCallableObjectOf, sourceDataInstallationPrecedes, type SourceCallableObject } from './source-callable-own-data.js'
import { callableCompletionSummaryOf } from './callable-completions.js'
import { symbolIsStandardLibraryMutator } from '../host-effect-contracts.js'
import type { SourceInvocationFact } from './invocation-facts.js'

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression

const keyOf = (access: Access): string | null =>
  ts.isPropertyAccessExpression(access) ? access.name.text : literalSourcePropertyKeyOf(access.argumentExpression)

const memberOf = (
  checker: ts.TypeChecker,
  access: Access
): { readonly owner: ts.Symbol; readonly member: ts.Symbol; readonly key: string } | null => {
  const receiver = unwrapErasedExpression(access.expression)
  if (!ts.isIdentifier(receiver) || receiver.text !== 'Object') return null
  const owner = checker.getSymbolAtLocation(receiver)
  const canonical = checker.resolveName('Object', access, ts.SymbolFlags.Value, false)
  const key = keyOf(access)
  if (
    owner === undefined ||
    owner !== canonical ||
    key === null ||
    !owner.valueDeclaration?.getSourceFile().hasNoDefaultLib ||
    !isGlobalObjectConstructor(checker, receiver, checker.getTypeAtLocation(receiver))
  )
    return null
  const member = checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(owner, receiver), key)
  // Standard Object static methods are own writable data properties. A
  // property declaration, augmentation, accessor or inherited key is outside
  // this protocol, even when it has a callable checker type.
  if (
    !member?.declarations?.length ||
    !member.declarations.every(
      (declaration) =>
        ts.isMethodSignature(declaration) &&
        declaration.getSourceFile().hasNoDefaultLib &&
        ts.isInterfaceDeclaration(declaration.parent) &&
        declaration.parent.name.text === 'ObjectConstructor'
    )
  )
    return null
  return { owner, member, key }
}

/** Candidate ownership is independent from successful closure: a failed
 * installation must not fall back to the original library callable.
 */
export const sourceIntrinsicMemberMayBeWrittenOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, access: Access): boolean => {
  const selected = memberOf(checker, access)
  return selected !== null && selected.member.declarations!.some((declaration) => flow.writesToDeclaration(declaration).length > 0)
}

/** A source replacement of one canonical Object namespace data member.
 * The joint session owns payload use and frame closure; this leaf authenticates
 * the store, normal lookup, complete namespace mentions and final protocol.
 * @semanticCategory generic-primitive
 */
export interface SourceIntrinsicMemberDataWrite {
  readonly site: ts.BinaryExpression
  readonly installation: Access
  readonly value: ts.Expression
  readonly body: SourceCallableObject
  readonly reads: readonly Access[]
}

export const sourceIntrinsicMemberDataWriteOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  access: Access
): SourceIntrinsicMemberDataWrite | null => {
  const selected = memberOf(checker, access)
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (selected === null || ledger === null) return null
  const writes = new Set(selected.member.declarations!.flatMap((declaration) => flow.writesToDeclaration(declaration)))
  for (const write of flow.writesToSymbol(selected.member)) writes.add(write)
  if (writes.size !== 1) return null
  const write = [...writes][0]!
  const installed = write.propertyAccess
  const site = write.site
  if (
    installed === null ||
    memberOf(checker, installed)?.owner !== selected.owner ||
    keyOf(installed) !== selected.key ||
    write.value === null ||
    !['property-assignment', 'index-assignment'].includes(write.edge) ||
    !ts.isBinaryExpression(site) ||
    site.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    site.left !== installed ||
    site.right !== write.value
  )
    return null
  const body = sourceCallableObjectOf(checker, flow, write.value)
  if (
    body === null ||
    callableCompletionSummaryOf(flow, body)?.execution !== 'sync' ||
    flow.receiverReferencesToDeclaration(body).length > 0
  )
    return null
  if (flow.writesToSymbol(selected.owner).some((one) => one.slot === 'whole')) return null
  // Symbol attribution is not a complete negative inventory: an erased
  // global-object path can still reach this namespace, and an unrelated
  // unknown write could invoke a setter. This first slice keeps all other
  // addressed property writes open until a positive receiver/descriptor
  // separation proof is available from the joint session.
  for (const other of flow.allWrites) {
    if (other.propertyAccess === null) continue
    // The shared index records the same store once for the member cell and
    // once for the receiver's member slot. Both cite this exact operation.
    if (other.site === site && other.propertyAccess === installed && other.value === write.value && other.edge === write.edge) continue
    return null
  }

  const reads: Access[] = []
  const references = new Set([
    ...flow.referencesToSymbol(selected.owner),
    ...flow.referencesToDeclaration(selected.owner.valueDeclaration!)
  ])
  for (const reference of references) {
    const receiver = unwrapErasedExpression(reference)
    const parent = receiver.parent
    if ((!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) || parent.expression !== receiver) return null
    const own = memberOf(checker, parent)
    if (own === null || own.owner !== selected.owner) return null
    if (parent === installed) continue
    const invocation = parent.parent
    if (!ts.isCallExpression(invocation) || invocation.expression !== parent || invocation.arguments.some(ts.isSpreadElement)) return null
    if (own.key === selected.key) {
      if (!sourceDataInstallationPrecedes(site, parent)) return null
      reads.push(parent)
    } else if (!ledger.requireMember('Object', own.key, parent)) return null
  }
  if (reads.length === 0 || (access !== installed && !reads.includes(access))) return null
  for (const invocation of flow.calls) {
    if (!ts.isCallExpression(invocation.call)) continue
    const callee = unwrapErasedExpression(invocation.operands.callee)
    if (reads.includes(callee as Access)) continue
    if (!symbolIsStandardLibraryMutator(checker.getSymbolAtLocation(callee))) continue
    // Only an intact integrity entry on a positively different allocation
    // is harmless here. Reflection/bulk/forwarding mutations stay refused;
    // the shared mutator inventory covers aliases and explicit-this frames.
    if ((!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) || invocation.operands.explicitThis) return null
    const entry = memberOf(checker, callee)
    const argument = invocation.operands.args[0]
    if (entry === null || !['freeze', 'seal', 'preventExtensions'].includes(entry.key) || argument === undefined) return null
    const target = unwrapErasedExpression(argument)
    const fresh =
      ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target) || sourceCallableObjectOf(checker, flow, target) !== null
    const scalar =
      ts.isLiteralExpression(target) ||
      target.kind === ts.SyntaxKind.TrueKeyword ||
      target.kind === ts.SyntaxKind.FalseKeyword ||
      target.kind === ts.SyntaxKind.NullKeyword
    if ((!fresh && !scalar) || !ledger.requireMember('Object', entry.key, callee)) return null
  }
  // The intentionally overwritten member is not declared intact. These are
  // separate binding/prototype obligations, so opaque exposure or an unknown
  // alias mutation still revokes the source proof in the final census.
  if (!ledger.requireMember('Object', 'prototype', site)) return null
  for (const intrinsic of ['Object', 'Function'] as const)
    if (!ledger.requirePrototypeKeys(intrinsic, { names: [selected.key, '__proto__'] }, site)) return null
  return { site, installation: installed, value: write.value, body, reads }
}

/** The installed payload and the complete admitted invocation frame must
 * agree before a mutation census can treat this replaced entry as source
 * code. Its original library signature is deliberately not an input. */
export const sourceIntrinsicMemberInvocationOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  fact: SourceInvocationFact
): SourceIntrinsicMemberDataWrite | null => {
  const call = fact.call
  const callee = unwrapErasedExpression(call.expression)
  if (
    (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) ||
    fact.operands.kind !== 'call' ||
    fact.operands.explicitThis ||
    fact.operands.dispatch.kind !== 'member' ||
    fact.operands.callee !== callee ||
    fact.operands.receiver !== callee.expression ||
    fact.operands.args.length !== call.arguments.length ||
    fact.operands.args.some((argument, index) => argument !== call.arguments[index]) ||
    fact.frames.length !== 1
  )
    return null
  const installed = sourceIntrinsicMemberDataWriteOf(checker, flow, callee)
  const frame = fact.frames[0]!
  return installed !== null &&
    installed.reads.includes(callee) &&
    frame.body === installed.body &&
    frame.layout.call === call &&
    frame.layout.body === installed.body &&
    frame.layout.operands === fact.operands &&
    frame.receiverUses.length === 0 &&
    frame.forwarding.kind === 'values'
    ? installed
    : null
}
