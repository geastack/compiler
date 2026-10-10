import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeBufferMethodDescriptorOf } from '../conversion/native-buffer-method.js'
import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from '../representation/native-logical-receiver.js'
import { hostReceiverProtocolOf } from '../representation/host-templates.js'
import { hostMemberOf, type HostSpellings } from '../targets/cpp/host/host-members.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import type { BindCallableOperation, GetOperation, IrBody, IrOperation } from './model.js'
import { genericNativeLogicalReceiverOf } from './call-entry.js'

/** A public nil ABI is insufficient: every possible source body must independently ignore logical this. */
export const nativeLogicalReceiverAdmitted = (
  operation: Extract<IrOperation, { kind: 'call' }> | BindCallableOperation,
  ignoresReceiver: ReadonlySet<IrValueId>
): boolean => {
  const receiver = genericNativeLogicalReceiverOf(operation)
  return (
    receiver === null ||
    nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(receiver.representation)) ||
    ignoresReceiver.has(operation.kind === 'call' ? operation.callee.value : operation.source.value)
  )
}

export const hostReadIgnoresLogicalReceiver = (operation: GetOperation, hosts: HostSpellings, keyText?: string | null): boolean => {
  const ignores = (protocol: string, member: string): boolean => {
    const row = hostMemberOf(hosts.members, protocol, member)
    return row?.kind === 'property' && row.store === null && row.logicalReceiver === 'ignored'
  }
  const binding = operation.hostMethod
  if (binding) return ignores(binding.protocol, binding.member)
  if (keyText === null || keyText === undefined) return false
  const matches = (receiver: Representation): boolean => {
    if (receiver.kind === 'optional') return matches(receiver.payload)
    if (receiver.kind === 'borrowed-ref') return matches(receiver.referent)
    if (receiver.kind === 'tagged-union') return receiver.arms.length > 0 && receiver.arms.every((arm) => matches(arm.value))
    const host = hostReceiverProtocolOf(receiver)
    return host !== null && ignores(host.protocol, keyText)
  }
  return matches(operation.receiver.representation)
}

export const bufferReadNeedsLogicalReceiver = (operation: GetOperation, keyText: string | null): boolean => {
  if (keyText === null) return false
  const matches = (receiver: Representation): boolean =>
    receiver.kind === 'optional'
      ? matches(receiver.payload)
      : receiver.kind === 'borrowed-ref'
        ? matches(receiver.referent)
        : receiver.kind === 'tagged-union'
          ? receiver.arms.some((arm) => matches(arm.value))
          : nativeBufferMethodDescriptorOf(receiver, keyText, operation.result.representation) !== null
  return matches(operation.receiver.representation)
}

const rewrite = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  operation: (operation: IrOperation) => IrOperation
): ReadonlyMap<PhysicalBodyId, IrBody> =>
  new Map(
    [...bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            { ...block, operations: block.operations.map((value) => operation(value) as typeof value) }
          ])
        )
      }
    ])
  )

/** Close receiver irrelevance before shaking decides which operands require runtime values. */
export const publishLogicalReceivers = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  deriver: RepresentationDeriver,
  hosts: HostSpellings
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const keyTexts = new Map<string, string>()
  for (const body of bodies.values())
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'constant' && operation.literal === 'string') keyTexts.set(operation.result.id, operation.text)
  const marked = rewrite(bodies, (operation) => {
    if (operation.kind !== 'get') return operation
    if (hostReadIgnoresLogicalReceiver(operation, hosts, keyTexts.get(operation.key.value) ?? null))
      return { ...operation, logicalReceiver: 'ignored' }
    if (bufferReadNeedsLogicalReceiver(operation, keyTexts.get(operation.key.value) ?? null))
      return { ...operation, logicalReceiver: 'native' }
    return operation
  })
  const ignored = nativeCallableFlowOf(
    [...marked.values()],
    placements,
    classes,
    conversions,
    undefined,
    deriver
  ).ignoredLogicalReceiverValues
  const physicalBodies = new Map<string, IrBody[]>()
  for (const body of marked.values()) {
    const source = String(body.sourceOwner)
    const variants = physicalBodies.get(source) ?? []
    variants.push(body)
    physicalBodies.set(source, variants)
  }
  const directTargetIgnoresReceiver = (operation: Extract<IrOperation, { kind: 'call' }>): boolean => {
    if (operation.target?.kind !== 'direct') return false
    const variants = physicalBodies.get(String(operation.target.functionId))
    return variants !== undefined && variants.length > 0 && variants.every(nativeBodyIgnoresLogicalReceiver)
  }
  return rewrite(marked, (operation) => {
    if (
      operation.kind !== 'call' ||
      !operation.thisArgument ||
      (!ignored.has(operation.callee.value) && !directTargetIgnoresReceiver(operation))
    )
      return operation
    const { thisArgument, ...withoutReceiver } = operation
    return withoutReceiver
  })
}
