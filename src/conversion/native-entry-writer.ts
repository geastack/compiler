import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { conversionRequiresSourceGuard } from './algebra.js'
import { dictionaryEntryWriteIsTotal } from './dictionary-view.js'
import { recipeClosureOf, recipeHasNormalResult } from './recipe-closure.js'
import type { AcceptedConversion } from './structural-plan.js'
import { representationKey, type Representation } from '../representation/model.js'

export interface NativeEntryWriter {
  readonly kind: 'native-entry'
  /** The native holder stores this identity; observation is a separate boundary. */
  readonly stored: ConversionNode
  readonly observation: ConversionNode
  /** The store executes the runtime element-lane check
   * (`requireNativeEntryFitsArrayLane`): written by index into an Array, the
   * entry lands only in a lane that holds its carrier, and is a TypeError at
   * the store otherwise. Only such a writer may own a numeric key. */
  readonly laneChecked?: true
}

export interface NativeEntryStoreOptions {
  /** The target's native-entry store checks an Array owner's element lane. */
  readonly laneChecked?: true
}

/** A genuine declared-any entry can retain a native replacement without
 * executing its dynamic observer to obtain a storage value. */
export const nativeEntryWriterOf = (
  value: Representation,
  entry: Representation,
  accepted: AcceptedConversion,
  resolve: ConversionNodeResolver,
  options?: NativeEntryStoreOptions
): NativeEntryWriter | null => {
  // `opt-in-fallback` is also the result carrier of the runtime's own internal
  // operations (`ir/internal-operation-conversions.ts`): a Value the runtime
  // produced, entries included, exactly as a declared `any` holds one.
  if (
    entry.kind !== 'dynamic' ||
    (entry.reason !== 'declared-any-never-narrowed' && entry.reason !== 'unasserted-json-parse' && entry.reason !== 'opt-in-fallback')
  )
    return null
  const stored = accepted(value, value)
  const observation = accepted(value, entry)
  if (
    !stored ||
    !observation ||
    resolve(stored.id) !== stored ||
    resolve(observation.id) !== observation ||
    representationKey(stored.source) !== representationKey(value) ||
    representationKey(stored.target) !== representationKey(value) ||
    representationKey(observation.source) !== representationKey(value) ||
    representationKey(observation.target) !== representationKey(entry) ||
    stored.capability.kind !== 'identity' ||
    !recipeHasNormalResult(observation, resolve) ||
    !dictionaryEntryWriteIsTotal(observation, resolve) ||
    [...recipeClosureOf([observation], resolve).values()].some((node) => conversionRequiresSourceGuard(node.capability, resolve))
  )
    return null
  return options?.laneChecked
    ? { kind: 'native-entry', stored, observation, laneChecked: true }
    : { kind: 'native-entry', stored, observation }
}
