import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrBody } from './model.js'
import { stringConstantsOf } from './dead-values.js'

export const callableMemberSlot = (receiver: Representation, key: string): string => JSON.stringify([representationKey(receiver), key])

/** A candidate for a guarded call, never a proof that a field is immutable.
 * The runtime compares the actual thunk before taking the direct path. A
 * different instance, later assignment, accessor, or alias therefore needs no
 * exclusion census: a mismatch executes the original callable unchanged. */
export const callableMemberCandidatesOf = (
  bodies: readonly IrBody[],
  directBindings: ReadonlyMap<DeclarationId, FunctionId>
): ReadonlyMap<string, FunctionId> => {
  const candidates = new Map<string, FunctionId>()
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    const functions = new Map<IrValueId, FunctionId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') functions.set(operation.result.id, operation.functionId)
        if (operation.kind === 'binding-read') {
          const target = directBindings.get(operation.declaration)
          if (target !== undefined) functions.set(operation.result.id, target)
        }
      }
    }
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
        const key = keys.get(operation.key.value)
        const target = functions.get(operation.value.value)
        if (key === undefined || target === undefined) continue
        const slot = callableMemberSlot(operation.receiver.representation, key)
        if (!candidates.has(slot)) candidates.set(slot, target)
      }
    }
  }
  return candidates
}
