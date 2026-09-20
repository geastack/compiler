import type { DeclarationId, IrValueId } from '../../../identity/ids.js'
import type { IrBody } from '../../../ir/model.js'
import type { BindingPlacement } from '../../../projection/bindings.js'
import { hostMemberOf, type HostSpellings } from './host-members.js'

/** A host method a module-level cell holds, so that a call through the cell is the host's own call. */
export interface HostMethodAlias {
  readonly protocol: string
  readonly member: string
}

/**
 * Module-level cells that hold one host method, forever.
 *
 * `var __isArray = Array.isArray` is how test262's propertyHelper -- and any
 * program guarding against a later monkey-patch -- names a builtin. A host
 * method is not a value in this backend: the host states a spelling for the
 * CALL and none for the method on its own (`operandText`'s `host-member-value`
 * refusal), so the initializer had nothing to store and the whole program
 * refused. But the cell is written exactly once, from a `get` of a member the
 * host table lists as a method on a class object or namespace the program
 * never holds as a value either -- so the cell is the alias and nothing but
 * the alias, and a read of it can name the same host member the access did.
 *
 * Written exactly once is the same condition, counted the same way, as
 * `buildDirectCallableIndex`: a later assignment is a second `binding-write`.
 * The receiver is restricted to a class object or a namespace (`host-class` /
 * `host-namespace` placements) because those render no receiver text at all
 * (`nativeHandleMemberText` records `null` for them), which is the one thing a
 * read in ANOTHER body could not reproduce from the write site's operands.
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
