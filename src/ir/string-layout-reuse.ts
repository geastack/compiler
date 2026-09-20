import type { IrValueId } from '../identity/ids.js'
import { stringConstantsOf } from './dead-values.js'
import type { HoistPlan } from './hoist.js'
import type { GetOperation, IrBody } from './model.js'

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
