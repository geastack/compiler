import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { hostMemberOf, type HostSpellings } from '../targets/cpp/host/host-members.js'
import type { IrBody } from './model.js'

/** The exact host row retained by a cell written once from a native member read. */
export interface HostMethodAlias {
  readonly protocol: string
  readonly member: string
}

/**
 * Immutable aliases of host class/namespace methods. The source Get must name
 * an installed host row, and every lowered write to the cell is counted.
 * Capturing a receiver-bearing instance method cannot satisfy this protocol.
 */
export const buildHostMethodAliasIndex = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  hosts: HostSpellings
): ReadonlyMap<DeclarationId, HostMethodAlias> => {
  const classReads = new Set<IrValueId>()
  const constants = new Map<IrValueId, string>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'constant') constants.set(operation.result.id, operation.text)
        if (operation.kind !== 'binding-read') continue
        const storage = placements.get(operation.declaration)?.storage.kind
        if (storage === 'host-class' || storage === 'host-namespace') classReads.add(operation.result.id)
      }
    }
  }
  const methods = new Map<IrValueId, HostMethodAlias>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'get' || !classReads.has(operation.receiver.value)) continue
        const receiver = operation.receiver.representation
        if (receiver.kind !== 'native-handle') continue
        const member = constants.get(operation.key.value)
        if (member === undefined) continue
        const protocol = receiver.native ?? receiver.protocol
        if (hostMemberOf(hosts.members, protocol, member)?.kind !== 'method') continue
        methods.set(operation.result.id, { protocol, member })
      }
    }
  }
  const writeCounts = new Map<DeclarationId, number>()
  const written = new Map<DeclarationId, HostMethodAlias>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'binding-write') continue
        writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
        const alias = methods.get(operation.value.value)
        if (alias) written.set(operation.declaration, alias)
      }
    }
  }
  const aliases = new Map<DeclarationId, HostMethodAlias>()
  for (const [declaration, alias] of written) if (writeCounts.get(declaration) === 1) aliases.set(declaration, alias)
  return aliases
}
