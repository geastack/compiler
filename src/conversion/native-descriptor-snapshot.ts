import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import type { NativeFieldViewPlan } from './native-field-view.js'
import { recipeHasNormalResult, recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'

/** A descriptor owns a copied native property record. Its public fields are
 * read later, independently of the array whose descriptor was captured.
 */
export interface NativeDescriptorSnapshotField {
  readonly field: RecordField
  readonly reads: readonly ConversionNode[]
  /** The copied getter/setter holder stays native. This is descriptor
   * forwarding only; it publishes no typed Function read convention. */
  readonly retainedAccessor?: true
}

export interface NativeDescriptorSnapshotPlan {
  readonly source: Extract<Representation, { kind: 'optional' }>
  readonly target: Extract<Representation, { kind: 'optional' }>
  readonly fields: readonly NativeDescriptorSnapshotField[]
  readonly originalAny: boolean
  readonly nativeFields: NativeFieldViewPlan
  readonly dependencies: readonly ConversionNode[]
}

/** This contextual plan is selected only by the authenticated capture and
 * its closed-use proof. A matching public descriptor layout is insufficient.
 */
export const nativeDescriptorSnapshotPlanOf = (
  source: Representation,
  target: Representation,
  fields: readonly NativeDescriptorSnapshotField[],
  originalAny: boolean,
  resolve: ConversionNodeResolver
): NativeDescriptorSnapshotPlan | null => {
  if (
    source.kind !== 'optional' ||
    source.absence !== 'undefined' ||
    source.payload.kind !== 'native-record-ref' ||
    source.payload.native !== 'gea::NativeDescriptorSnapshot' ||
    source.payload.ownership !== 'shared-refcount' ||
    target.kind !== 'optional' ||
    target.absence !== 'undefined' ||
    (target.payload.kind !== 'record' && target.payload.kind !== 'native-record-ref') ||
    target.payload.ownership !== 'shared-refcount' ||
    (target.payload.kind === 'record' && (target.payload.accessors.length !== 0 || fields.length !== target.payload.fields.length)) ||
    (target.payload.kind === 'native-record-ref' && target.payload.native !== null)
  )
    return null
  const dependencies = new Map<string, ConversionNode>()
  for (const [index, entry] of fields.entries()) {
    const field = target.payload.kind === 'record' ? target.payload.fields[index] : entry.field
    if (
      !field ||
      field.key !== entry.field.key ||
      field.required !== entry.field.required ||
      representationKey(field.value) !== representationKey(entry.field.value) ||
      !['value', 'writable', 'enumerable', 'configurable', 'get', 'set'].includes(field.key)
    )
      return null
    if (entry.retainedAccessor) {
      if (!['get', 'set'].includes(field.key) || entry.reads.length !== 0) return null
      continue
    }
    if (['get', 'set'].includes(field.key) || entry.reads.length === 0) return null
    const sources = new Set<string>()
    for (const read of entry.reads) {
      if (
        resolve(read.id) !== read ||
        representationKey(read.target) !== representationKey(field.value) ||
        sources.has(representationKey(read.source)) ||
        !recipeHasNormalResult(read, resolve) ||
        !recipeIsMaterializableWithoutPriorSourceGuard(read, resolve) ||
        (read.source.kind === 'dynamic' &&
          (!originalAny || (read.source.reason !== 'declared-any-never-narrowed' && read.source.reason !== 'unasserted-json-parse')))
      )
        return null
      sources.add(representationKey(read.source))
      dependencies.set(read.id, read)
    }
  }
  return {
    source,
    target,
    fields,
    originalAny,
    nativeFields: {
      source: source.payload,
      target: target.payload,
      fields: fields.flatMap<NativeFieldViewPlan['fields'][number]>((entry) =>
        entry.retainedAccessor
          ? [{ key: entry.field.key, read: entry.field.value, write: null, descriptorForward: true as const }]
          : entry.reads.map((read) => ({
              key: entry.field.key,
              read: read.source,
              write: null,
              checkedRead: read
            }))
      )
    },
    dependencies: [...dependencies.values()]
  }
}

export const nativeDescriptorSnapshotPlanMatches = (plan: NativeDescriptorSnapshotPlan, resolve: ConversionNodeResolver): boolean => {
  const replay = nativeDescriptorSnapshotPlanOf(plan.source, plan.target, plan.fields, plan.originalAny, resolve)
  return (
    replay !== null &&
    replay.dependencies.length === plan.dependencies.length &&
    replay.dependencies.every((child, index) => child === plan.dependencies[index]) &&
    JSON.stringify(replay.nativeFields) === JSON.stringify(plan.nativeFields)
  )
}
