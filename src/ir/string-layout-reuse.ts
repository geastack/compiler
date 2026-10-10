import type { IrValueId } from '../identity/ids.js'
import { stringConstantsOf } from './dead-values.js'
import { dominatorTreeOf } from './dominance.js'
import type { HoistPlan } from './hoist.js'
import type { GetOperation, IrBlockId, IrBody } from './model.js'

export interface SharedStringLayout {
  readonly ordinal: number
  readonly initialize: boolean
}

/** Share the scan only among reads already proved invariant and relocated to
 * the same preheader. Binding identities are interchangeable only when their
 * reads occur in that same relocation list: a matching declaration elsewhere
 * could observe a different value. This consumes the hoist proof instead of
 * inventing another alias or callback-effect analysis. */
export const sharedStringLayoutsOf = (
  body: IrBody,
  hoists: HoistPlan,
  excluded: ReadonlySet<IrValueId>
): ReadonlyMap<IrValueId, SharedStringLayout> => {
  const layouts = new Map<IrValueId, SharedStringLayout>()
  const keys = stringConstantsOf(body)
  let ordinal = 0
  for (const operations of hoists.into.values()) {
    const receivers = new Map<IrValueId, string>()
    for (const operation of operations) {
      if (operation.kind === 'binding-read') receivers.set(operation.result.id, `binding:${operation.declaration}`)
    }
    const groups = new Map<string, GetOperation[]>()
    for (const operation of operations) {
      if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'string' || excluded.has(operation.result.id)) continue
      const key = keys.get(operation.key.value)
      if (key !== 'length' && key !== 'charCodeAt') continue
      const identity = receivers.get(operation.receiver.value) ?? `value:${operation.receiver.value}`
      const group = groups.get(identity) ?? []
      group.push(operation)
      groups.set(identity, group)
    }
    for (const group of groups.values()) {
      if (group.length < 2 || !group.some((operation) => keys.get(operation.key.value) === 'charCodeAt')) continue
      for (const [index, operation] of group.entries()) {
        layouts.set(operation.result.id, { ordinal, initialize: index === 0 })
      }
      ordinal++
    }
  }
  return layouts
}

/**
 * The same sharing for reads that never left their block: a run of
 * `s.charCodeAt(k)` over one stable formal in straight-line code -- a hex
 * decoder reading 24 characters of its parameter in a row -- paid
 * the UTF-16 layout scan of the whole string at every read, because the
 * per-call `charCodeAt` classifies the string before indexing it. The
 * receiver's identity is the one `string-length-reuse.ts` already trusts
 * (`stableStringReceiversOf`): a read of a formal the policy proved stable,
 * the SSA parameter itself, or a read of a private cell's single dominating
 * write. Nothing else -- a local a closure may write, a value a call may
 * replace -- is grouped. The first read of a group that dominates a later one
 * initializes the layout; a read no earlier member dominates starts a group
 * of its own, so the initializer always runs before every read that uses it.
 * Groups of one are left alone: one scan is what the plain call does.
 */
export const straightLineStringLayoutsOf = (
  body: IrBody,
  receivers: ReadonlyMap<IrValueId, string>,
  excluded: ReadonlySet<IrValueId>,
  firstOrdinal: number
): ReadonlyMap<IrValueId, SharedStringLayout> => {
  const layouts = new Map<IrValueId, SharedStringLayout>()
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return layouts
  const keys = stringConstantsOf(body)
  const dominance = dominatorTreeOf(body)
  let ordinal = firstOrdinal
  const groups = new Map<string, { block: IrBlockId; ordinal: number; members: GetOperation[] }[]>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'string' || excluded.has(operation.result.id)) continue
      const key = keys.get(operation.key.value)
      if (key !== 'length' && key !== 'charCodeAt') continue
      const identity = receivers.get(operation.receiver.value)
      if (identity === undefined) continue
      const open = groups.get(identity) ?? []
      const dominating = open.find((group) => dominance.dominates(group.block, blockId))
      if (dominating) dominating.members.push(operation)
      else {
        open.push({ block: blockId, ordinal: ordinal++, members: [operation] })
        groups.set(identity, open)
      }
    }
  }
  for (const open of groups.values()) {
    for (const group of open) {
      if (group.members.length < 2 || !group.members.some((operation) => keys.get(operation.key.value) === 'charCodeAt')) continue
      for (const [index, operation] of group.members.entries()) {
        layouts.set(operation.result.id, { ordinal: group.ordinal, initialize: index === 0 })
      }
    }
  }
  return layouts
}
