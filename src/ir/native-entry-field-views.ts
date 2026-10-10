import type { NativeFieldViewPlan } from '../conversion/native-field-view.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { ConstructOperation, IrOperand } from './model.js'
import { nativeFieldViewCarrierNeedsReceipt, nativeFieldViewReceiptMatches, type NativeFieldViewRead } from './native-field-view-facts.js'

/** The "0"/"1" reads `new Map(entries)` performs on each entry, through a live view's own routes. */
export interface NativeEntryFieldReads {
  readonly key: NativeFieldViewRead
  readonly value: NativeFieldViewRead
}

interface MapSeed {
  readonly argument: IrOperand
  readonly entry: Representation
  readonly key: Representation
  readonly value: Representation
}

const mapSeedOf = (operation: ConstructOperation): MapSeed | null => {
  const result = operation.result.representation
  const argument = operation.arguments[0]
  if (result.kind !== 'keyed-collection' || result.family !== 'map' || result.value === null || argument === undefined) return null
  const source = argument.representation
  if (source.kind !== 'array-object') return null
  return { argument, entry: source.element, key: result.key, value: result.value }
}

export const nativeEntryFieldReadsRequired = (operation: ConstructOperation, targets: ReadonlySet<string>): boolean => {
  const seed = mapSeedOf(operation)
  return seed !== null && nativeFieldViewCarrierNeedsReceipt(seed.entry, targets)
}

/**
 * A view's read callback answers with its route's own carrier, never the
 * entry's declared one, so each route's carrier is one source to convert from.
 * Only a plain shared record entry is admitted; a route that forwards a
 * descriptor publishes no carrier, and either refuses rather than guesses.
 */
export const nativeEntryFieldReadsOf = (
  operation: ConstructOperation,
  plans: readonly NativeFieldViewPlan[],
  conversions: ConversionCensus
): NativeEntryFieldReads | null => {
  const seed = mapSeedOf(operation)
  if (seed === null || seed.entry.kind !== 'record' || seed.entry.ownership !== 'shared-refcount') return null
  const shapeId = seed.entry.shapeId
  const readOf = (key: '0' | '1', target: Representation): NativeFieldViewRead | null => {
    const sources = new Map<string, NativeFieldViewRead['sources'][number]>()
    for (const plan of plans) {
      if (plan.target.shapeId !== shapeId) continue
      const route = plan.fields.find((field) => field.key === key)
      if (route === undefined || route.descriptorForward === true) return null
      const node = conversions.nodeFor(route.read, target)
      if (!recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById)) return null
      const previous = sources.get(representationKey(route.read))
      if (previous !== undefined && previous.conversion !== node.id) return null
      sources.set(representationKey(route.read), { source: route.read, conversion: node.id })
    }
    if (sources.size === 0) return null
    return {
      receiver: seed.argument.value,
      carrier: representationKey(seed.entry),
      key,
      result: representationKey(target),
      sources: [...sources.values()]
    }
  }
  const key = readOf('0', seed.key)
  const value = readOf('1', seed.value)
  return key === null || value === null ? null : { key, value }
}

export const nativeEntryFieldReadsMatch = (expected: NativeEntryFieldReads | null, actual: NativeEntryFieldReads | undefined): boolean =>
  expected !== null &&
  actual !== undefined &&
  nativeFieldViewReceiptMatches(expected.key, actual.key) &&
  nativeFieldViewReceiptMatches(expected.value, actual.value)
