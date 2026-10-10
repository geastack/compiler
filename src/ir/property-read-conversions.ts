import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import {
  classMemberOf,
  declaredRecordFieldOf,
  propertyReadResultRepresentationOf,
  recordAccessorsOfShape,
  recordFieldsOfShape
} from '../projection/fields.js'
import { virtualDispatchKey } from '../projection/dispatch.js'
import { nativeExpandoSidecarOf } from '../projection/native-expando.js'
import { regexpFieldStorageOf } from '../projection/regexp-fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type RecordField, type Representation } from '../representation/model.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import { nativeIntrinsicMemberOf } from '../representation/prototype-domains.js'
import { nativeDataPropertyOf } from '../representation/native-data-properties.js'
import { nativeNumericIndexOf } from '../representation/numeric-index.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { taggedUnionArmsAreDictionariesOrNativeSidecar, taggedUnionArmsHaveNativeSidecar } from './certify/property-access-keys.js'
import type { GetOperation } from './model.js'
import type { OperationConversionInput } from './operation-conversions.js'
import { nativePrototypeMethodOf } from './native-prototype-calls.js'
import { disjointNativeRecordIndexOf } from './native-record-index.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

const leavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? leavesOf(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => leavesOf(arm.value))
      : [value]

/** The fixed-field route retained for synthetic reads with no sealed key recipe. */
export const compatibilityFieldReadSourcesOf = (operation: GetOperation, deriver: RepresentationDeriver): readonly RecordField[] => {
  if (
    operation.typedComputedRead !== undefined ||
    operation.result.representation.kind !== 'tagged-union' ||
    operation.key.representation.kind !== 'string'
  )
    return []
  const receiver = operation.receiver.representation
  if (receiver.kind === 'record' || receiver.kind === 'record-with-index') return receiver.fields
  if (receiver.kind === 'class-ref' || (receiver.kind === 'native-record-ref' && receiver.native === null))
    return recordFieldsOfShape(deriver, receiver.shapeId) ?? []
  return []
}

/** Property results produced by getter bodies and ordinary native property tables. */
export const propertyReadConversionInputsOf = (
  operation: GetOperation,
  keyText: string | null,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi> = new Map(),
  virtualAbis: ReadonlyMap<string, CallableAbi> = new Map(),
  wellKnownSymbols: ReadonlyMap<DeclarationId, string> = new Map()
): readonly OperationConversionInput[] => {
  if (operation.normalResult === 'undefined') return []
  const inputs = new Map<string, OperationConversionInput>()
  const result = operation.result.representation
  const add = (source: Representation): void => {
    if (representationKey(source) === representationKey(result)) return
    inputs.set(representationKey(source), { role: 'field-read', source, target: result })
  }
  const receiver = operation.receiver.representation
  const unionReceiver = receiver.kind === 'tagged-union'
  if (receiver.kind === 'dynamic' && result.kind !== 'dynamic') add(dynamic)
  const fixed = keyText === null ? compatibilityFieldReadSourcesOf(operation, deriver) : []
  for (const field of fixed) add(field.value)
  if (
    keyText === null &&
    leavesOf(receiver).some((leaf) => leaf.kind !== 'dictionary' && leaf.kind !== 'null' && leaf.kind !== 'undefined') &&
    (taggedUnionArmsHaveNativeSidecar(receiver) || taggedUnionArmsAreDictionariesOrNativeSidecar(receiver))
  )
    add(dynamic)
  for (const leaf of leavesOf(receiver)) {
    if (leaf.kind === 'typed-array' && keyText !== null && canonicalIndexLiteral(keyText) !== null) {
      add({ kind: 'scalar', domain: 'number' })
      continue
    }
    if (keyText === null && operation.key.representation.kind === 'scalar' && operation.key.representation.domain === 'number') {
      const indexed = nativeNumericIndexOf(leaf, (id) => deriver.layoutOf(id))
      if (indexed !== null) {
        if (leaf.kind === 'typed-array') add(indexed.value)
        continue
      }
    }
    if (unionReceiver && keyText !== null && leaf.kind === 'dictionary' && leaf.key === 'string' && leaf.value.kind === 'dynamic')
      add(leaf.value)
    if (keyText !== null) {
      const virtual = leaf.kind === 'class-ref' ? virtualAbis.get(virtualDispatchKey(leaf.declaration, keyText, 'get')) : undefined
      const physical = virtual?.result ?? propertyReadResultRepresentationOf(deriver, classes, abis, leaf, keyText)
      if (physical !== null) add(physical)
      const member = leaf.kind === 'class-ref' ? classMemberOf(classes, leaf.declaration, keyText) : null
      if (unionReceiver && (member === null || member.kind === 'field')) {
        const field = declaredRecordFieldOf(deriver, leaf, keyText, classes)
        if (field !== null) add(field.value)
      }
    }
    // A selected native index is already served by its exact entry carrier.
    // Treating its numeric text as an undeclared expando invents a boxed
    // source even when the record's physical sidecar stores a native Ref.
    if (disjointNativeRecordIndexOf(deriver, leaf, operation.key.representation, keyText ?? undefined) !== null) continue
    if (!nativeExpandoSidecarOf(leaf) || fixed.length > 0 || operation.typedComputedRead !== undefined) continue
    if (
      !unionReceiver &&
      leaf.kind !== 'record' &&
      leaf.kind !== 'record-with-index' &&
      leaf.kind !== 'native-record-ref' &&
      leaf.kind !== 'class-ref' &&
      leaf.kind !== 'array-object'
    )
      continue
    if (keyText === null) {
      add(dynamic)
      continue
    }
    // A native field, accessor, or intrinsic member is served before the
    // expando fallback; it cannot acquire a dynamic result by its kind alone.
    if (
      objectPrototypeMemberNames.has(keyText) ||
      nativeIntrinsicMemberOf(leaf, keyText) ||
      nativeDataPropertyOf(leaf, keyText, wellKnownSymbols) !== null ||
      regexpFieldStorageOf(leaf, keyText) !== null ||
      nativePrototypeMethodOf(leaf, keyText) !== null
    )
      continue
    if (declaredRecordFieldOf(deriver, leaf, keyText, classes) !== null) continue
    if (leaf.kind === 'class-ref') {
      if (classMemberOf(classes, leaf.declaration, keyText) !== null) continue
      if (operation.absentClassArms?.includes(leaf.declaration)) continue
    }
    if (
      (leaf.kind === 'record' || leaf.kind === 'native-record-ref') &&
      recordAccessorsOfShape(deriver, leaf.shapeId)?.some((accessor) => accessor.key === keyText)
    )
      continue
    if (leaf.kind === 'record' && result.kind === 'undefined') continue
    add(dynamic)
  }
  return [...inputs.values()]
}
