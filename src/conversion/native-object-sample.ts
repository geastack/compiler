import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'

/** One current native field is sampled from its actual allocation storage.
 * A required target still checks absence at runtime; its declaration is not
 * a proof that the source installed that property.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectSampleField {
  readonly field: RecordField
  readonly from: 'held' | 'extension'
  readonly storage: Representation
  readonly presence: 'proven' | 'optional'
  readonly present: ConversionNode
  readonly absent: ConversionNode | null
}

/** This plan is contextual to a source-owned slot schema. An ordinary
 * structural record pair cannot infer the type of an identity sidecar.
 * Shared destinations continue to use the live view protocol, never a copy.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectSamplePlan {
  readonly source: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
  readonly target: Extract<Representation, { kind: 'record' }>
  readonly fields: readonly NativeObjectSampleField[]
}

export const nativeObjectSamplePlanOf = (
  source: Representation,
  target: Representation,
  fields: readonly NativeObjectSampleField[],
  resolve: ConversionNodeResolver
): NativeObjectSamplePlan | null => {
  const holdsUndefined = (value: Representation): boolean =>
    value.kind === 'undefined' ||
    (value.kind === 'optional' && (value.absence === 'undefined' || holdsUndefined(value.payload))) ||
    (value.kind === 'tagged-union' && value.arms.some((arm) => holdsUndefined(arm.value))) ||
    value.kind === 'dynamic'
  if (
    (source.kind !== 'record' && source.kind !== 'native-record-ref') ||
    source.ownership !== 'shared-refcount' ||
    (source.kind === 'native-record-ref' && source.native !== null) ||
    target.kind !== 'record' ||
    target.ownership !== 'owned' ||
    target.accessors.length !== 0 ||
    target.fields.length !== fields.length ||
    new Set(fields.map(({ field }) => field.key)).size !== fields.length
  )
    return null
  for (const [index, entry] of fields.entries()) {
    const expected = target.fields[index]
    if (
      expected === undefined ||
      expected.key !== entry.field.key ||
      expected.required !== entry.field.required ||
      representationKey(expected.value) !== representationKey(entry.field.value) ||
      representationKey(entry.present.source) !== representationKey(entry.storage) ||
      representationKey(entry.present.target) !== representationKey(expected.value) ||
      !recipeIsMaterializableWithoutPriorSourceGuard(entry.present, resolve) ||
      (entry.presence === 'proven'
        ? entry.absent !== null
        : entry.absent === null ||
          expected.required ||
          !holdsUndefined(expected.value) ||
          entry.absent.source.kind !== 'undefined' ||
          representationKey(entry.absent.target) !== representationKey(expected.value) ||
          !recipeIsMaterializableWithoutPriorSourceGuard(entry.absent, resolve))
    )
      return null
  }
  return { source, target, fields }
}
