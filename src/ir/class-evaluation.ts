import type { DeclarationId } from '../identity/ids.js'
import { isRegionId } from '../identity/ids.js'
import { cyclicBlocksOf } from './dominance.js'
import type { IrBody } from './model.js'

/**
 * The classes the program evaluates exactly once.
 *
 * A class declaration is an `allocate-constructor` operation, and every
 * evaluation of it mints a fresh `gea::NativeClassMethodState` -- the
 * prototype object, the method identities, the `instanceof` chain -- which is
 * why every instance carries a `gea_method_state` handle to the evaluation
 * that constructed it: two evaluations of one declaration are two classes,
 * and their instances must not answer for each other.
 *
 * When the declaration is evaluated ONCE there is only one such state for the
 * whole program, and a handle per instance says nothing the class itself
 * could not say. `records.ts` then states it once, as a `static` member of
 * the struct, and the construct function fills it in. On
 * `bench/comparison/fixtures/binary_trees.ts` that is eight bytes off every
 * one of a million nodes.
 *
 * "Once" is the operation sitting in a region body -- a module body or a
 * static block, which the language runs a single time -- outside any cyclic
 * block, at the declaration's only allocation site. A class declared inside a
 * function, or inside a top-level loop, is evaluated per call or per
 * iteration and keeps its per-instance handle.
 */
export const singleEvaluationClassesOf = (bodies: readonly IrBody[]): ReadonlySet<DeclarationId> => {
  const once = new Set<DeclarationId>()
  const repeated = new Set<DeclarationId>()
  for (const body of bodies) {
    const region = isRegionId(body.sourceOwner)
    const cyclic = region ? cyclicBlocksOf(body) : null
    for (const [blockId, block] of body.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== 'allocate-constructor') continue
        const { declaration } = operation
        // A second allocation site -- a physical variant of the same body, or
        // a declaration lowered twice -- is a second evaluation as far as this
        // census can tell, so it fails closed.
        if (!region || cyclic!.has(blockId) || once.has(declaration)) repeated.add(declaration)
        else once.add(declaration)
      }
    }
  }
  for (const declaration of repeated) once.delete(declaration)
  return once
}
