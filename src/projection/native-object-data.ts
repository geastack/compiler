import type { OperationId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { NativeObjectDataAllocation, NativeObjectDataSlotSchema } from '../semantics/native-object-data-slots.js'
import { nativeObjectDataSlotSchemasOf } from '../semantics/native-object-data-slots.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import {
  nativeCallableDataCarrierHasStorageIdentity,
  nativeCallableDataValueRepresentationOf,
  storedSourceValueOf
} from '../representation/native-callable-data-storage.js'
import type { NativeOwnAssignmentValue } from '../semantics/native-own-assignment.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'

/** Exact source-owned data storage. Presence and successful installation are
 * runtime descriptor facts, rather than properties inferred from a public
 * structural field's optionality.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectDataStorage {
  readonly schema: NativeObjectDataSlotSchema
  readonly storage: Representation
  readonly writers: readonly { readonly writer: NativeObjectDataSlotSchema['writers'][number]; readonly source: Representation }[]
}

/** The carrier a spread's copy stores for `key`: the source carrier's own
 * field, exactly what `spread-conversions.ts` hands the copy's native store.
 * A source with no static field list (a union, a dictionary) has no single
 * carrier to name here. */
const spreadFieldRepresentationOf = (
  deriver: Pick<RepresentationDeriver, 'deriveStored'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>,
  type: StructuralTypeId,
  key: string
): Representation | null => {
  const carrier = deriver.deriveStored(type)
  const layout =
    carrier.kind === 'record'
      ? carrier
      : carrier.kind === 'native-record-ref' && carrier.native === null
        ? (deriver.layoutOf?.(carrier.shapeId as StructuralTypeId) ?? null)
        : null
  return layout?.kind === 'record' ? (layout.fields.find((field) => field.key === key)?.value ?? null) : null
}

/** The carrier a described bulk source stores for `key`: its own field of
 * that key on every object surface that declares it, which must agree. A
 * nullish arm copies nothing; any other non-record surface names no field. */
export const describedFieldRepresentationOf = (
  deriver: Pick<RepresentationDeriver, 'deriveStored'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>,
  type: StructuralTypeId,
  key: string
): Representation | null => {
  const surfaces = (value: Representation): readonly Representation[] =>
    value.kind === 'optional'
      ? surfaces(value.payload)
      : value.kind === 'tagged-union'
        ? value.arms.flatMap((arm) => surfaces(arm.value))
        : value.kind === 'null' || value.kind === 'undefined'
          ? []
          : [value]
  let found: Representation | null = null
  for (const surface of surfaces(deriver.deriveStored(type))) {
    const layout =
      surface.kind === 'record'
        ? surface
        : surface.kind === 'native-record-ref' && surface.native === null
          ? (deriver.layoutOf?.(surface.shapeId as StructuralTypeId) ?? null)
          : null
    if (layout?.kind !== 'record') return null
    const field = layout.fields.find((one) => one.key === key)?.value
    if (field === undefined) continue
    if (found !== null && representationKey(found) !== representationKey(field)) return null
    found = field
  }
  return found
}

/** The first extension protocol holds one exact native carrier. An alias's
 * asserted field type cannot widen it, and differing actual writers require
 * a separately published storage join rather than a dynamic carrier.
 */
export const nativeObjectDataStorageOf = (
  schema: NativeObjectDataSlotSchema,
  deriver: Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>
): NativeObjectDataStorage | null => {
  if (schema.blockers.length !== 0 || schema.writers.length === 0 || schema.key === '__proto__') return null
  const writers: NativeObjectDataStorage['writers'][number][] = []
  const bulkValueRepresentationOf = (value: NativeOwnAssignmentValue): Representation | null =>
    storedSourceValueOf(deriver, { callable: value.source.kind === 'function' ? value.source.callable : null, type: value.type })
  for (const writer of schema.writers) {
    if (writer.spreadSource !== undefined) {
      const source = spreadFieldRepresentationOf(deriver, writer.spreadSource.type, schema.key)
      if (!source || !nativeCallableDataCarrierHasStorageIdentity(source)) return null
      writers.push({ writer, source })
      continue
    }
    const mutation = writer.mutation
    const operation = mutation.operation
    const dataDefinition =
      operation.family === 'property' && operation.internalMethod === 'define-own-property' && operation.descriptor !== null
    const ordinarySet =
      operation.family === 'property' && operation.internalMethod === 'set' && operation.ordinaryObjectDataWriteAbsent === true
    const reflectSet =
      operation.family === 'invocation' && operation.intrinsicMutation === 'reflect-set' && operation.ordinaryObjectDataWriteAbsent === true
    if (
      mutation.copiedSlot !== undefined &&
      operation.family === 'invocation' &&
      operation.intrinsicMutation === 'object-assign' &&
      operation.nativeOwnAssignment?.prototype === 'ordinary-intact-absent'
    ) {
      if (mutation.copiedSlot.described === true) {
        const source = describedFieldRepresentationOf(deriver, mutation.copiedSlot.source.type, schema.key)
        if (!source || !nativeCallableDataCarrierHasStorageIdentity(source)) return null
        writers.push({ writer, source })
        continue
      }
      if (mutation.copiedSlot.values.length === 0) return null
      for (const value of mutation.copiedSlot.values) {
        const source = bulkValueRepresentationOf(value)
        if (!source || !nativeCallableDataCarrierHasStorageIdentity(source)) return null
        writers.push({ writer, source })
      }
      continue
    }
    if (!writer.value || (!dataDefinition && !ordinarySet && !reflectSet)) return null
    const source = nativeCallableDataValueRepresentationOf(writer.value, deriver)
    if (!source || !nativeCallableDataCarrierHasStorageIdentity(source)) return null
    writers.push({ writer, source })
  }
  const storage = writers[0]!.source
  if (writers.some(({ source }) => representationKey(source) !== representationKey(storage))) return null
  // The local semantic origin map intentionally does not invent parameter
  // aliases. When the source session closes that domain, its complete slot
  // inputs must agree with this storage too, including writes in the called
  // body and values copied by other assignments to the same allocation.
  if (schema.storedValues !== undefined)
    for (const value of schema.storedValues) {
      const source = bulkValueRepresentationOf(value)
      if (!source || !nativeCallableDataCarrierHasStorageIdentity(source) || representationKey(source) !== representationKey(storage))
        return null
    }
  return { schema, storage, writers }
}

/** The consumers that reach an allocation's own properties only through its
 * dynamic own-property table: a bulk copy from an open source writing keys it
 * cannot name, and unknown code holding the object. None of them changes a
 * descriptor's attributes or the prototype. */
const dynamicTableBlockers: ReadonlySet<NativeObjectDataSlotSchema['blockers'][number]['kind']> = new Set([
  'unknown-key',
  'exposure',
  'open-alias'
])

/** A key such consumers can also write or read shares their one storage: the
 * object's dynamic own-property table, the descriptor an open `Object.assign`
 * writes. A typed store still installs its own native carrier there, but
 * every installed descriptor must then carry its Value materializer, and no
 * reader may assume the carrier, since the open writers store Values under
 * the same key. `null` when the key has no such table storage. */
export const nativeObjectDataTableStorageOf = (
  schema: NativeObjectDataSlotSchema,
  deriver: Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>
): NativeObjectDataStorage | null =>
  schema.blockers.length === 0 || schema.blockers.some((blocker) => !dynamicTableBlockers.has(blocker.kind))
    ? null
    : ((storage) => (storage === null ? null : { ...storage, schema }))(nativeObjectDataStorageOf({ ...schema, blockers: [] }, deriver))

/** Descriptor-object aliases and structural receiver aliases use the same
 * canonical allocation census. No shape-wide row grants source identity.
 */
export const nativeObjectDataStorageAt = (
  graph: SemanticGraph,
  operationId: OperationId,
  key: string,
  deriver: Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>
): NativeObjectDataStorage | null => {
  const operation = graph.operations.get(operationId)
  if (!operation) return null
  const receiver = operation.family === 'property' ? operandOf(operation, 'receiver') : operandOf(operation, 'argument', 0)
  if (receiver?.source.kind !== 'result') return null
  const census = nativeObjectDataSlotSchemasOf(graph)
  const allocation = census.origins.get(receiver.source.result)
  const schema = allocation && census.schemas.get(allocation.id)?.get(key)
  return schema ? nativeObjectDataStorageOf(schema, deriver) : null
}

/** A new key is separate from an allocation's existing data/accessor layout.
 * This is a source allocation fact, not absence inferred from an alias type.
 */
export const nativeObjectDataExtensionAt = (
  graph: SemanticGraph,
  operationId: OperationId,
  key: string,
  deriver: Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'> & Partial<Pick<RepresentationDeriver, 'layoutOf'>>
): NativeObjectDataStorage | null => {
  const storage = nativeObjectDataStorageAt(graph, operationId, key, deriver)
  return storage && nativeObjectDataExtensionSchemaAt(graph, operationId, key) !== null ? storage : null
}

/** A blocked writer/consumer cannot make a typed extension fall back to Value. */
export const nativeObjectDataExtensionSchemaAt = (
  graph: SemanticGraph,
  operationId: OperationId,
  key: string
): NativeObjectDataSlotSchema | null => {
  const operation = graph.operations.get(operationId)
  const receiver = operation?.family === 'property' ? operandOf(operation, 'receiver') : undefined
  if (receiver?.source.kind !== 'result') return null
  const census = nativeObjectDataSlotSchemasOf(graph)
  const allocation = census.origins.get(receiver.source.result)
  return allocation ? nativeObjectDataExtensionSchemaFor(graph, allocation, key) : null
}

/** The same question asked of one allocation directly: an aliased receiver
 * in a callee frame may hold several, and each answers for itself. */
export const nativeObjectDataExtensionSchemaFor = (
  graph: SemanticGraph,
  allocation: NativeObjectDataAllocation,
  key: string
): NativeObjectDataSlotSchema | null => {
  const census = nativeObjectDataSlotSchemasOf(graph)
  const schema = census.schemas.get(allocation.id)?.get(key)
  if (!schema) return null
  // An inherited builtin read with no own writer is a prototype operation,
  // not installation of a new native data slot. Actual own shadows retain
  // their complete writer/schema requirement below.
  const installsOwnData = schema.writers.some(
    ({ mutation }) => ['set', 'reflect-set', 'define-own-property'].includes(mutation.kind) || mutation.copiedSlot !== undefined
  )
  // An original absent read has no native extension to install or observe.
  // Its separate allocation/prototype-absence receipt remains mandatory in
  // the field-view authority, including for optional public fields.
  if (!installsOwnData && (objectPrototypeMemberNames.has(key) || schema.blockers.length === 0)) return null
  const initialType =
    schema.allocation.family === 'allocation' ? schema.allocation.shape : (resultOf(schema.allocation, 'value')?.type ?? null)
  if (initialType === null) return null
  let type: StructuralTypeId = initialType
  const seen = new Set<StructuralTypeId>()
  while (!seen.has(type)) {
    seen.add(type)
    const shape = graph.structuralTypes.get(type)?.shape
    if ((shape?.kind === 'object-anchor' || shape?.kind === 'declared') && shape.body !== null) {
      type = shape.body
      continue
    }
    // An ambient any result states no own slots on this separately proven
    // empty allocation. A published native dictionary/index result, however,
    // owns its entry protocol and follows the same exclusion as a literal.
    if (schema.allocation.family === 'invocation' && shape?.kind === 'primitive' && shape.primitive === 'any') return schema
    return shape?.kind === 'object' &&
      shape.index.length === 0 &&
      !shape.members.some((member) => member.key.kind !== 'symbol' && String(member.key.value) === key)
      ? schema
      : null
  }
  return null
}
