import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { recipeHasNormalResult, recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { dictionaryEntryReadIsLive, dictionaryEntryWriteIsTotal } from './dictionary-view.js'
import { nativeFieldViewDynamicValueIsNative, nativeFieldViewIdentityTransportOf, type NativeFieldViewPlan } from './native-field-view.js'
import { nativePayloadTransportMatches } from './native-payload-transport.js'
import type { AcceptedConversion } from './structural-plan.js'
import { isOpenDocument, representationKey, type Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import { nativeEntryWriterOf, type NativeEntryStoreOptions, type NativeEntryWriter } from './native-entry-writer.js'

export type DocumentFieldWriter = { readonly kind: 'conversion'; readonly conversion: ConversionNode } | NativeEntryWriter

export const documentFieldWriterOf = (
  value: Representation,
  entry: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver,
  store?: NativeEntryStoreOptions
): DocumentFieldWriter | null => {
  if (!nativeDocumentEntryValueIsNative(value)) return resolve ? nativeEntryWriterOf(value, entry, accepted, resolve, store) : null
  const conversion = accepted(value, entry)
  return conversion &&
    representationKey(conversion.source) === representationKey(value) &&
    representationKey(conversion.target) === representationKey(entry) &&
    dictionaryEntryWriteIsTotal(conversion, resolve)
    ? { kind: 'conversion', conversion }
    : null
}

export const documentFieldWriterConversionsOf = (writer: DocumentFieldWriter): readonly ConversionNode[] =>
  writer.kind === 'conversion' ? [writer.conversion] : [writer.stored, writer.observation]

export interface DocumentRecordViewPlan {
  readonly source: Extract<Representation, { kind: 'dictionary' }>
  readonly target: Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' }>
  /**
   * `read` is absent for a field whose value is the view's own record (an
   * `image` field holding another `image`): see `selfReferenceOf`.
   */
  readonly fields: readonly { readonly key: string; readonly read?: ConversionNode; readonly write: DocumentFieldWriter }[]
  readonly nativeFields: NativeFieldViewPlan
  readonly dependencies: readonly ConversionNode[]
}

export type DocumentRecordViewStep =
  | { readonly kind: 'view'; readonly view: DocumentRecordViewPlan }
  | { readonly kind: 'conversion'; readonly conversion: ConversionNode }
  | { readonly kind: 'wrap'; readonly target: Extract<Representation, { kind: 'optional' }>; readonly payload: DocumentRecordViewStep }
  | {
      readonly kind: 'inject'
      readonly target: Extract<Representation, { kind: 'tagged-union' }>
      readonly index: number
      readonly payload: DocumentRecordViewStep
    }
  | { readonly kind: 'optional'; readonly present: DocumentRecordViewStep; readonly absent: ConversionNode }
  | { readonly kind: 'dispatch'; readonly arms: readonly DocumentRecordViewStep[] }
  | { readonly kind: 'document'; readonly conversion: ConversionNode; readonly payload: DocumentRecordViewStep }
  | {
      readonly kind: 'dynamic-optional'
      readonly absence: 'null' | 'undefined'
      readonly present: DocumentRecordViewStep
      readonly absent: ConversionNode
    }

export interface ComposedDocumentRecordViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly step: DocumentRecordViewStep
  readonly nativeFields: readonly NativeFieldViewPlan[]
  readonly dependencies: readonly ConversionNode[]
}

export const containsOpenDocument = (value: Representation): boolean =>
  isOpenDocument(value) ||
  (value.kind === 'optional' && containsOpenDocument(value.payload)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => containsOpenDocument(arm.value)))

/** A live view forwarding plain field reads would skip an accessor. */
const shapeHasNoAccessors = (layouts: RecordLayoutPolicy, shapeId: string): boolean =>
  (layouts.accessorsForShape(shapeId)?.length ?? 0) === 0

/** A structural dynamic load needs the installed future-field protocol. Exact
 * nominal/accessor payload recovery has its separate identity contract. */
export const dynamicRecordLoadNeedsPlan = (value: Representation, layouts: RecordLayoutPolicy): boolean => {
  if (value.kind === 'optional') return dynamicRecordLoadNeedsPlan(value.payload, layouts)
  if (value.kind === 'tagged-union') return value.arms.some((arm) => dynamicRecordLoadNeedsPlan(arm.value, layouts))
  if (value.kind === 'array-object') return dynamicRecordLoadNeedsPlan(value.element, layouts)
  if (value.kind === 'promise') return dynamicRecordLoadNeedsPlan(value.value, layouts)
  if (value.kind === 'record') return value.ownership === 'shared-refcount' && value.accessors.length === 0
  if (value.kind === 'record-with-index') return value.ownership === 'shared-refcount'
  return (
    value.kind === 'native-record-ref' &&
    value.native === null &&
    value.ownership === 'shared-refcount' &&
    shapeHasNoAccessors(layouts, value.shapeId) &&
    layouts.forShape(value.shapeId) !== null
  )
}

/** Existing declared dynamic values (including thrown JS values) retain that
 * boundary; synthetic callable erasure never licenses an entry store. */
export const nativeDocumentEntryValueIsNative = (value: Representation): boolean =>
  value.kind === 'optional'
    ? nativeDocumentEntryValueIsNative(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.every((arm) => nativeDocumentEntryValueIsNative(arm.value))
      : value.kind === 'dynamic'
        ? value.reason !== 'untyped-callable'
        : nativeFieldViewDynamicValueIsNative(value)

/**
 * A field whose value is the view's own record, or that record or absent.
 *
 * Its read is the conversion being derived: a record may hold an `image`
 * whose own `image` is the same record, so reading it from a Document
 * needs this very view, and asking for it while it is being minted can only
 * answer "no finite proof". A view reads an entry when the program reads the
 * field, not when the view is made, so the entry is wrapped then -- one view
 * per access, which is also what keeps a cyclic Document finite. The plan
 * leaves the read to the field's carriers, resolved when it is used.
 */
const selfReferenceOf = (target: Representation, value: Representation): boolean => {
  const own = representationKey(target)
  return representationKey(value) === own || (value.kind === 'optional' && representationKey(value.payload) === own)
}

/** A fixed native field view delegates future reads and writes to the original declared-any entries. */
export const documentRecordViewPlanOf = (
  source: Representation,
  target: Representation,
  layouts: RecordLayoutPolicy,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve?: ConversionNodeResolver,
  store?: NativeEntryStoreOptions
): DocumentRecordViewPlan | null => {
  if (!isOpenDocument(source) || source.kind !== 'dictionary' || source.recursive !== undefined) return null
  if (
    (target.kind !== 'record' && target.kind !== 'record-with-index' && target.kind !== 'native-record-ref') ||
    target.ownership !== 'shared-refcount'
  )
    return null
  if (target.kind === 'native-record-ref' && (target.native !== null || target.recursive)) return null
  if (target.kind === 'record' && target.accessors.length !== 0) return null
  const indexes = target.kind === 'record-with-index' ? target.indexes : layouts.indexesForShape(target.shapeId)
  if (
    indexes.length !== 0 &&
    (indexes.length !== 1 ||
      indexes[0]!.key !== 'string' ||
      indexes[0]!.value.kind !== 'dynamic' ||
      indexes[0]!.value.reason !== 'declared-any-never-narrowed' ||
      source.value.kind !== 'dynamic' ||
      source.value.reason !== 'declared-any-never-narrowed')
  )
    return null
  if (!shapeHasNoAccessors(layouts, target.shapeId)) return null
  const resolved =
    target.kind === 'record' || target.kind === 'record-with-index'
      ? target.fields
      : indexes.length !== 0
        ? layouts.forShape(target.shapeId)
        : layouts.plainFieldsForShape?.(target.shapeId)
  // A declared symbol member is a key like any other here: every adapter
  // delegates by PropertyKey to the original Document, whose symbol entries
  // live in its own expando, and the emitter names the symbol by the marker
  // its declaration registered (a module-private symbol key on a recursed-into
  // document).
  if (!resolved) return null
  const fields: Array<DocumentRecordViewPlan['fields'][number]> = []
  for (const field of resolved) {
    const read = readAccepted(source.value, field.value)
    const write = documentFieldWriterOf(field.value, source.value, accepted, resolve, store)
    if (!read && write && selfReferenceOf(target, field.value)) {
      fields.push({ key: field.key, write })
      continue
    }
    if (!read || !write) return null
    // A named native entry holder does not claim a numeric array storage
    // lane: a Document read as a tuple may be an Array, and an index store
    // lands in that Array's own element lane. Only a store that checks the
    // lane (`laneChecked`) owns a numeric key; any other is refused here.
    if (write.kind === 'native-entry' && write.laneChecked !== true && canonicalIndexLiteral(field.key) !== null) return null
    if (
      representationKey(read.source) !== representationKey(source.value) ||
      representationKey(read.target) !== representationKey(field.value)
    )
      throw new Error('a document field view received a conversion for different carriers')
    if (!dictionaryEntryReadIsLive(read, resolve)) return null
    fields.push({ key: field.key, read, write })
  }
  return {
    source,
    target,
    fields,
    dependencies: fields.flatMap((field) => [...(field.read ? [field.read] : []), ...documentFieldWriterConversionsOf(field.write)]),
    nativeFields: {
      source,
      target,
      fields: fields.flatMap((field) => [
        {
          key: field.key,
          read: source.value,
          write: source.value,
          ...(field.read ? { checkedRead: field.read } : {}),
          declaredAnyEntry: true as const
        },
        ...(field.write.kind === 'native-entry'
          ? [{ key: field.key, read: field.write.stored.source, write: field.write.stored.target, declaredAnyEntry: true as const }]
          : [])
      ])
    }
  }
}

/** Wrappers retain every live source arm and cite their own exact absence conversions. */
export const composedDocumentRecordViewPlanOf = (
  source: Representation,
  target: Representation,
  layouts: RecordLayoutPolicy,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve?: ConversionNodeResolver,
  store?: NativeEntryStoreOptions
): ComposedDocumentRecordViewPlan | null => {
  if (!containsOpenDocument(source) && (source.kind !== 'dynamic' || source.reason === 'untyped-callable')) return null
  const fields: NativeFieldViewPlan[] = []
  const dependencies = new Map<string, ConversionNode>()
  const build = (from: Representation, into: Representation): DocumentRecordViewStep | null => {
    if (from.kind === 'dynamic') {
      if (into.kind === 'optional') {
        const present = build(from, into.payload)
        const absent = accepted({ kind: into.absence }, into)
        if (!present || !absent || !recipeIsMaterializableWithoutPriorSourceGuard(absent, resolve)) return null
        dependencies.set(absent.id, absent)
        return { kind: 'dynamic-optional', absence: into.absence, present, absent }
      }
      if (into.kind !== 'record' && into.kind !== 'record-with-index' && into.kind !== 'native-record-ref') return null
      const document: Representation = {
        kind: 'dictionary',
        key: 'string',
        ownership: 'shared-refcount',
        value: from
      }
      const conversion = accepted(from, document)
      if (!conversion || !recipeIsMaterializableWithoutPriorSourceGuard(conversion, resolve)) return null
      const payload = build(document, into)
      if (!payload) return null
      dependencies.set(conversion.id, conversion)
      return { kind: 'document', conversion, payload }
    }
    if (from.kind === 'optional') {
      const present = build(from.payload, into)
      const absent = accepted({ kind: from.absence }, into)
      if (!present || !absent || !recipeIsMaterializableWithoutPriorSourceGuard(absent, resolve)) return null
      dependencies.set(absent.id, absent)
      return { kind: 'optional', present, absent }
    }
    if (from.kind === 'tagged-union') {
      const arms = from.arms.map((arm) => build(arm.value, into))
      return arms.some((arm) => arm === null) ? null : { kind: 'dispatch', arms: arms as DocumentRecordViewStep[] }
    }
    if (into.kind === 'optional') {
      const payload = build(from, into.payload)
      return payload === null ? null : { kind: 'wrap', target: into, payload }
    }
    if (into.kind === 'tagged-union' && containsOpenDocument(from)) {
      const candidates = into.arms.flatMap((arm, index) => {
        const view = documentRecordViewPlanOf(from, arm.value, layouts, accepted, readAccepted, resolve, store)
        return view === null ? [] : [{ index, view }]
      })
      if (candidates.length !== 1) return null
      const selected = candidates[0]!
      fields.push(selected.view.nativeFields)
      for (const node of selected.view.dependencies) dependencies.set(node.id, node)
      return { kind: 'inject', target: into, index: selected.index, payload: { kind: 'view', view: selected.view } }
    }
    const view = documentRecordViewPlanOf(from, into, layouts, accepted, readAccepted, resolve, store)
    if (view !== null) {
      fields.push(view.nativeFields)
      for (const node of view.dependencies) dependencies.set(node.id, node)
      return { kind: 'view', view }
    }
    if (containsOpenDocument(from)) return null
    const conversion = accepted(from, into)
    if (
      !conversion ||
      !recipeIsMaterializableWithoutPriorSourceGuard(conversion, resolve) ||
      (!nativePayloadTransportMatches(from, into, conversion) && !nativeFieldViewIdentityTransportOf(conversion))
    )
      return null
    dependencies.set(conversion.id, conversion)
    return { kind: 'conversion', conversion }
  }
  const step = build(source, target)
  return step === null || fields.length === 0
    ? null
    : { source, target, step, nativeFields: fields, dependencies: [...dependencies.values()] }
}

/** Every normal object path of this exact converter installs Document entry callbacks.
 * An ordinary native arm cannot acquire that protocol from a sibling view.
 */
export const nativeDocumentEntryViewOf = (node: ConversionNode, resolve?: ConversionNodeResolver): Representation | null => {
  let capability = node.capability
  while (capability.kind === 'optional') capability = capability.payload
  if (!('materializer' in capability) || !capability.materializer.documentRecordView) return null
  const entries = new Map<string, Representation>()
  const visit = (step: DocumentRecordViewStep): boolean => {
    switch (step.kind) {
      case 'view': {
        const entry = step.view.source.value
        if (entry.kind !== 'dynamic' || entry.reason !== 'declared-any-never-narrowed') return false
        entries.set(representationKey(entry), entry)
        return true
      }
      case 'document':
      case 'wrap':
      case 'inject':
        return visit(step.payload)
      case 'optional':
      case 'dynamic-optional':
        return visit(step.present)
      case 'dispatch':
        return step.arms.every(visit)
      case 'conversion':
        return (
          step.conversion.source.kind === 'undefined' ||
          step.conversion.source.kind === 'null' ||
          !recipeHasNormalResult(step.conversion, resolve)
        )
    }
  }
  return visit(capability.materializer.documentRecordView.step) && entries.size === 1 ? [...entries.values()][0]! : null
}
