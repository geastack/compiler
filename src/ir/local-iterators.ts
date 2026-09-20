import type { IrValueId } from '../identity/ids.js'
import { allOperationsOf, type IrBody } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/** A private protocol cursor never crosses a carrier/ABI boundary or gets copied. */
export const localIteratorValuesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const candidates = new Set<IrValueId>()
  const escapes = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'get-iterator') candidates.add(operation.result.id)
      for (const operand of operandsOfIrOperation(operation)) {
        if (
          (operation.kind === 'iterator-next' || operation.kind === 'iterator-done') &&
          operation.iterator.value === operand.value &&
          (operation.kind !== 'iterator-next' || operation.value === null)
        )
          continue
        escapes.add(operand.value)
      }
    }
  }
  // A cleanup region names the iterator from a nested C++ scope, so it cannot
  // be an inline local cursor at its get-iterator site.
  for (const region of body.iteratorCloseRegions ?? []) candidates.delete(region.iterator.value)
  for (const value of escapes) candidates.delete(value)
  return candidates
}
