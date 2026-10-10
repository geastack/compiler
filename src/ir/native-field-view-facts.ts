import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeClosureOf, recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import type { ConversionNodeId, ConversionNode } from '../conversion/algebra.js'
import type { IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { NativeCallableFlow } from './callable-class-flow.js'
import { allOperationsOf, type GetOperation, type SetOperation, type IrBody, type IrOperand } from './model.js'
import { nativeFieldViewDynamicValueIsNative, nativeFieldViewPlansOf, type NativeFieldViewPlan } from '../conversion/native-field-view.js'
import type { NativeFieldStorageDomain } from './native-field-view-domains.js'
import type { ProgramConversionRecipe } from './program-conversions.js'
import type { HostNamespaceCensus } from './host-namespace-reads.js'

export interface NativeFieldViewRead {
  readonly receiver: IrValueId
  readonly carrier: string
  readonly key: string
  /** A computed read selects one of these complete, authenticated fixed-key routes. */
  readonly keyDomain?: readonly string[]
  readonly result: string
  /** A source-proven absent descriptor can return undefined without reading a view's placeholder field. */
  readonly originalAbsent?: true
  /**
   * A runtime key with no proven finite set: `keyDomain` is every key a live
   * descriptor names, and any other key reads the original allocation's
   * expando table or an installed Document entry (`absentRoutesOf`).
   */
  readonly openKeys?: true
  readonly sources: readonly { readonly source: Representation; readonly conversion: ConversionNodeId }[]
}

export interface NativeFieldViewWrite {
  readonly receiver: IrValueId
  readonly carrier: string
  readonly key: string
  /** A computed write selects one of these complete, authenticated fixed-key routes. */
  readonly keyDomain?: readonly string[]
  readonly value: IrValueId
  readonly source: string
  readonly targets: readonly { readonly target: Representation | null; readonly conversion: ConversionNodeId | null }[]
}

type FieldFlow = Pick<NativeCallableFlow, 'nativeFieldStorageValues' | 'nativeAccessorStorageValues' | 'nativeFieldMethodValues'> &
  Partial<
    Pick<
      NativeCallableFlow,
      'nativeFieldViewStorageValues' | 'nativeFieldOperationStorageValues' | 'nativeFieldViewOrigins' | 'nativeFieldViewAbsentRoutesOf'
    >
  >

/** Reachability follows exact published receipts, including recipes created by an earlier publication pass. */
export const nativeFieldViewCitationsOf = (operation: import('./model.js').IrOperation): readonly ConversionNodeId[] => [
  ...(operation.kind === 'call' && operation.nativeArrayDescriptorSnapshot ? [operation.nativeArrayDescriptorSnapshot.conversion] : []),
  ...((operation.kind === 'get' || operation.kind === 'set') && operation.nativeDocumentEntry
    ? [
        ...operation.nativeDocumentEntry.views,
        ...(operation.nativeDocumentEntry.arrayEntry?.readers.map((reader) => reader.array) ?? []),
        operation.nativeDocumentEntry.conversion
      ]
    : []),
  ...((operation.kind === 'get' || operation.kind === 'set') && operation.nativeObjectDataSlot
    ? [
        ...operation.nativeObjectDataSlot.read.map((entry) => entry.conversion),
        ...(operation.nativeObjectDataSlot.write ? [operation.nativeObjectDataSlot.write.conversion] : []),
        ...(operation.nativeObjectDataSlot.materialization === undefined ? [] : [operation.nativeObjectDataSlot.materialization])
      ]
    : []),
  ...(operation.kind === 'convert' ? [operation.conversionUse] : []),
  ...(operation.conversionRecipes ?? []).map((recipe) => recipe.conversion),
  ...(operation.kind === 'get' ? (operation.methodValueRecipes ?? []).map((recipe) => recipe.conversion) : []),
  ...(operation.kind === 'call' ? (operation.objectValueConversions ?? []).map((recipe) => recipe.conversion) : []),
  ...(operation.kind === 'call' && operation.nativeDataDefinition
    ? [
        operation.nativeDataDefinition.conversion,
        ...(operation.nativeDataDefinition.materialization === undefined ? [] : [operation.nativeDataDefinition.materialization])
      ]
    : []),
  ...(operation.kind === 'get' ? (operation.nativeFieldViewRead?.sources ?? []).map((recipe) => recipe.conversion) : []),
  ...(operation.kind === 'get-iterator' ? (operation.nativeNextMethodRead?.read.sources ?? []).map((recipe) => recipe.conversion) : []),
  ...(operation.kind === 'construct' && operation.nativeEntryFieldReads
    ? [...operation.nativeEntryFieldReads.key.sources, ...operation.nativeEntryFieldReads.value.sources].map((recipe) => recipe.conversion)
    : []),
  ...(operation.kind === 'iterator-next' || operation.kind === 'iterator-close'
    ? (operation.nativeMethodRead?.read.sources ?? []).map((recipe) => recipe.conversion)
    : []),
  ...(operation.kind === 'set'
    ? (operation.nativeFieldViewWrite?.targets ?? []).flatMap((recipe) => (recipe.conversion === null ? [] : [recipe.conversion]))
    : [])
]

export const nativeFieldViewBodyCitationsOf = (body: IrBody): readonly ConversionNodeId[] => [
  ...[...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)].flatMap(nativeFieldViewCitationsOf)),
  ...(body.iteratorCloseRegions ?? []).flatMap((region) => (region.nativeMethodRead?.read.sources ?? []).map((entry) => entry.conversion))
]

/** Only exact cited live recipes can require a field-view protocol on a carrier. */
export const nativeFieldViewTargetsOf = (
  bodies: Iterable<IrBody>,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  programConversions?: readonly ProgramConversionRecipe[]
): ReadonlySet<string> => nativeFieldViewTargetSetOf(nativeFieldViewLivePlansOf(bodies, conversions, programConversions))

/** The installed live plans themselves: a consumer reading a view's fields needs each plan's source carriers. */
export const nativeFieldViewLivePlansOf = (
  bodies: Iterable<IrBody>,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  programConversions?: readonly ProgramConversionRecipe[]
): readonly NativeFieldViewPlan[] => {
  const nodes = [...bodies].flatMap((body) => nativeFieldViewBodyCitationsOf(body).map((id) => conversions.nodeById(id)))
  for (const recipe of programConversions ?? [])
    if (conversions.nodeById(recipe.conversion.id) === recipe.conversion) nodes.push(recipe.conversion)
  const admitted = nodes.filter((node): node is ConversionNode => node !== null)
  return nativeFieldViewPlansOf(recipeClosureOf(admitted, conversions.nodeById).values())
}

export const nativeFieldViewTargetSetOf = (plans: readonly NativeFieldViewPlan[]): ReadonlySet<string> =>
  new Set(plans.map((plan) => plan.target.shapeId))

/**
 * Targets whose every live view is an installed Document view. Such a view
 * answers a runtime key itself -- `makeDocumentViewWithOrigin` marks its
 * origin `documentEntries`, and the ordinary native [[Get]]
 * (`nativeDynamicRead`) consults that original Document before any copied
 * field -- so an open key needs no per-key slot route through it.
 */
export const nativeFieldViewDocumentTargetSetOf = (plans: readonly NativeFieldViewPlan[]): ReadonlySet<string> => {
  const document = (plan: NativeFieldViewPlan): boolean =>
    plan.source.kind === 'dictionary' && plan.fields.every((field) => field.declaredAnyEntry === true)
  const other = new Set(plans.filter((plan) => !document(plan)).map((plan) => plan.target.shapeId))
  return new Set(plans.filter((plan) => document(plan) && !other.has(plan.target.shapeId)).map((plan) => plan.target.shapeId))
}

const carrierTargetsAreDocuments = (value: Representation, targets: ReadonlySet<string>, documents: ReadonlySet<string>): boolean => {
  if (value.kind === 'optional' || value.kind === 'borrowed-ref')
    return carrierTargetsAreDocuments(value.kind === 'optional' ? value.payload : value.referent, targets, documents)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => carrierTargetsAreDocuments(arm.value, targets, documents))
  return !('shapeId' in value) || !targets.has(value.shapeId) || documents.has(value.shapeId)
}

/**
 * A runtime-keyed read with no proven finite key set (`parameters[key]` under
 * `for (const key in parameters)`) over Document-only live views. No fixed-key
 * receipt can exist for it, and none is needed: the ordinary native [[Get]]
 * reads the view's original Document entry, and a plain allocation its own
 * slots and sidecar.
 */
export const nativeFieldViewOpenDocumentRead = (
  operation: GetOperation | SetOperation,
  constantKey: string | null | undefined,
  targets: ReadonlySet<string>,
  documents: ReadonlySet<string>
): boolean =>
  operation.kind === 'get' &&
  (constantKey === null || constantKey === undefined) &&
  operation.provenKeyTexts === undefined &&
  documents.size > 0 &&
  carrierTargetsAreDocuments(operation.receiver.representation, targets, documents)

/**
 * A receiver the host census resolved to a namespace PATH is no allocation:
 * `navigator.bluetooth.keyboard` has no object behind it, only spellings for
 * its members. Its checker type can still be the very interface a program
 * literal of the same shape is a live view of (`const BLE: typeof
 * navigator.bluetooth = { keyboard: {...} }`), so the carrier alone would
 * demand a heap-slot receipt for `navigator.bluetooth.keyboard.tap` and render
 * the path itself as a value. The census is the one authority on which
 * values are paths; publication and certification both ask it here.
 */
export const nativeFieldViewOperationNeedsReceipt = (
  operation: GetOperation | SetOperation,
  targets: ReadonlySet<string>,
  hostNamespaces: HostNamespaceCensus | undefined
): boolean =>
  !(hostNamespaces?.reads.has(operation.receiver.value) || hostNamespaces?.values.has(operation.receiver.value)) &&
  nativeFieldViewCarrierNeedsReceipt(operation.receiver.representation, targets)

export const nativeFieldViewCarrierNeedsReceipt = (value: Representation, targets: ReadonlySet<string>): boolean => {
  if (value.kind === 'optional' || value.kind === 'borrowed-ref')
    return nativeFieldViewCarrierNeedsReceipt(value.kind === 'optional' ? value.payload : value.referent, targets)
  if (value.kind === 'tagged-union') return value.arms.some((arm) => nativeFieldViewCarrierNeedsReceipt(arm.value, targets))
  return 'shapeId' in value && 'ownership' in value && value.ownership === 'shared-refcount' && targets.has(value.shapeId)
}

/** The actual allocation slots, rather than a structural alias's covariant declaration. */
const fieldSourcesOf = (
  flow: FieldFlow,
  receiver: IrValueId,
  key: string,
  at?: GetOperation
): readonly Pick<NativeFieldStorageDomain, 'read' | 'checkedRead' | 'originalAbsent' | 'dynamicGet'>[] | null => {
  const actual = at === undefined ? undefined : flow.nativeFieldOperationStorageValues?.get(at)
  if (actual !== undefined) return actual.get(key) ?? null
  const data = flow.nativeFieldStorageValues.get(receiver)?.get(key)
  const accessor = flow.nativeAccessorStorageValues.get(receiver)?.get(key)
  const method = flow.nativeFieldMethodValues.get(receiver)?.get(key)
  if (data && accessor) return null
  const physical = data ?? accessor?.map((entry) => entry.read) ?? (method ? [method] : null)
  const carried = flow.nativeFieldViewStorageValues?.get(receiver)?.get(key)
  // A key no live descriptor names reads each original allocation's expando
  // table or an installed Document's own entry; only a read asks, and its
  // `undefined` route still needs the operation's own prototype-absence proof.
  if (physical === null) return carried ?? (at === undefined ? null : (flow.nativeFieldViewAbsentRoutesOf?.(receiver, key) ?? null))
  // Physical allocation slots are the whole answer where they exist; a union
  // arm's certified absence speaks only for a receiver with none.
  const domains = carried?.some((entry) => entry.originalAbsent === true || entry.dynamicGet === true) ? undefined : carried
  const routes = physical.flatMap((read) => {
    const selected = domains?.filter((entry) => representationKey(entry.read) === representationKey(read))
    return selected?.length ? selected : [{ read }]
  })
  // Heaps name only allocations. A value that arrived through an installed
  // live view (a record parent recast into a class-or-record union)
  // is no heap, so its descriptor routes are reachable beside the physical ones.
  if (domains === undefined || !flow.nativeFieldViewOrigins?.has(receiver)) return routes
  const held = new Set(routes.map((entry) => representationKey(entry.read)))
  return [...routes, ...domains.filter((entry) => !held.has(representationKey(entry.read)))]
}

export const nativeFieldViewReadFor = (
  receiver: IrOperand,
  key: string,
  target: Representation,
  flow: FieldFlow,
  conversions: ConversionCensus,
  at?: GetOperation
): NativeFieldViewRead | null => {
  const values = fieldSourcesOf(flow, receiver.value, key, at)
  if (!values?.length) return null
  // An absent arm answers past its own allocation only to `Object.prototype`;
  // the operation's own source fact is what proves that lookup misses too.
  if (values.some((value) => value.originalAbsent === true) && at?.ordinaryObjectPrototypeKeyAbsent !== true) return null
  const sources = new Map<string, NativeFieldViewRead['sources'][number]>()
  for (const { read: source, checkedRead, dynamicGet } of values) {
    // A `dynamic` arm's Value reads through whichever exact leaf already
    // converts that carrier (a Document entry's checked read): one source, one
    // conversion, so the arm and the entry route cannot disagree.
    if (dynamicGet === true && sources.has(representationKey(source))) continue
    const node =
      abiOfCallee(source) !== null && abiOfCallee(target) !== null
        ? (conversions.nativeMethodFor(source, target) ?? conversions.nodeFor(source, target))
        : conversions.nodeFor(source, target)
    const selected =
      (checkedRead === undefined
        ? null
        : representationKey(checkedRead.source) === representationKey(source) &&
            representationKey(checkedRead.target) === representationKey(target)
          ? checkedRead
          : conversions.checkedFieldReadFor(source, target, checkedRead)) ?? node
    if (!recipeIsMaterializableWithoutPriorSourceGuard(selected, conversions.nodeById)) return null
    const previous = sources.get(representationKey(source))
    if (previous !== undefined && previous.conversion !== selected.id) {
      const canonical = documentEntryReadOf(source, target, previous.conversion, selected, checkedRead !== undefined, conversions)
      if (canonical === null) return null
      sources.set(representationKey(source), { source, conversion: canonical })
      continue
    }
    sources.set(representationKey(source), { source, conversion: selected.id })
  }
  return {
    receiver: receiver.value,
    carrier: representationKey(receiver.representation),
    key,
    result: representationKey(target),
    ...(values.some((value) => value.originalAbsent === true) ? { originalAbsent: true as const } : {}),
    sources: [...sources.values()]
  }
}

/**
 * Two Document routes behind one view (an image record viewed both straight
 * off the Document and through an intermediate `{ width?, ... }` view) hand
 * the adapter the same original entry `Value`. Its one exact reader is the
 * canonical checked entry read into the result; another certified reader of
 * that same `Value` into the same carrier (an intermediate's checked read
 * over its wider declared slot) checks no more than it does. Any other
 * disagreement stays refused.
 */
const documentEntryReadOf = (
  source: Representation,
  target: Representation,
  previous: ConversionNodeId,
  selected: ConversionNode,
  checked: boolean,
  conversions: ConversionCensus
): ConversionNodeId | null => {
  if (source.kind !== 'dynamic' || !checked) return null
  const canonical = conversions.dictionaryReadFor(source, target)
  if (canonical === null) return null
  const other = previous === canonical.id ? selected : selected.id === canonical.id ? conversions.nodeById(previous) : null
  return other !== null &&
    other.source.kind === 'dynamic' &&
    representationKey(other.target) === representationKey(target) &&
    recipeIsMaterializableWithoutPriorSourceGuard(other, conversions.nodeById)
    ? canonical.id
    : null
}

export const nativeFieldViewReadOf = (
  operation: GetOperation,
  key: string,
  flow: FieldFlow,
  conversions: ConversionCensus
): NativeFieldViewRead | null =>
  nativeFieldViewReadFor(operation.receiver, key, operation.result.representation, flow, conversions, operation)

/** Every key must have its own complete slot proof before their native leaf carriers are combined. */
export const nativeFieldViewReadSelectionOf = (
  operation: GetOperation,
  keys: readonly string[],
  flow: FieldFlow,
  conversions: ConversionCensus
): NativeFieldViewRead | null => {
  const keyDomain = [...new Set(keys)].sort()
  const reads = keyDomain.map((key) => nativeFieldViewReadOf(operation, key, flow, conversions))
  if (reads.length === 0 || reads.some((read) => read === null || read.originalAbsent === true)) return null
  const sources = new Map<string, NativeFieldViewRead['sources'][number]>()
  for (const read of reads) for (const source of read!.sources) sources.set(representationKey(source.source), source)
  return { ...reads[0]!, keyDomain, sources: [...sources.values()] }
}

/**
 * `for ( const key in values ) values[ key ]` over a live view (a
 * `setValues` over an any-membered options bag): every
 * named key keeps its exact slot routes, and a key outside them reaches only
 * what an unnamed key can -- an expando entry, `undefined`, or an installed
 * Document's own entry -- exactly as the ordinary computed [[Get]] of a native
 * record does.
 */
export const nativeFieldViewOpenReadOf = (
  operation: GetOperation,
  flow: FieldFlow,
  conversions: ConversionCensus
): NativeFieldViewRead | null => {
  if (operation.provenKeyTexts !== undefined) return null
  const named = flow.nativeFieldViewStorageValues?.get(operation.receiver.value)
  const rest = flow.nativeFieldViewAbsentRoutesOf?.(operation.receiver.value, null)
  if (named === undefined || !rest?.length) return null
  const keyDomain = [...named.keys()].sort()
  const fixed = keyDomain.length === 0 ? null : nativeFieldViewReadSelectionOf(operation, keyDomain, flow, conversions)
  if (keyDomain.length > 0 && fixed === null) return null
  const sources = new Map<string, NativeFieldViewRead['sources'][number]>()
  for (const source of fixed?.sources ?? []) sources.set(representationKey(source.source), source)
  for (const route of rest) {
    const node = conversions.nodeFor(route.read, operation.result.representation)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById)) return null
    const previous = sources.get(representationKey(route.read))
    if (previous !== undefined && previous.conversion !== node.id) return null
    sources.set(representationKey(route.read), { source: route.read, conversion: node.id })
  }
  return {
    receiver: operation.receiver.value,
    carrier: representationKey(operation.receiver.representation),
    key: '',
    keyDomain,
    openKeys: true,
    result: representationKey(operation.result.representation),
    sources: [...sources.values()]
  }
}

export const nativeFieldViewWriteOf = (
  operation: SetOperation,
  key: string,
  flow: FieldFlow,
  conversions: ConversionCensus
): NativeFieldViewWrite | null => {
  const actual = flow.nativeFieldOperationStorageValues?.get(operation)
  const data = actual === undefined ? flow.nativeFieldStorageValues.get(operation.receiver.value)?.get(key) : undefined
  const accessor = actual === undefined ? flow.nativeAccessorStorageValues.get(operation.receiver.value)?.get(key) : undefined
  const descriptors = actual === undefined ? flow.nativeFieldViewStorageValues?.get(operation.receiver.value)?.get(key) : actual.get(key)
  if ((data && accessor) || (!data?.length && !accessor?.length && !descriptors?.length)) return null
  // A certified absence is a read route: storing the key on that arm creates
  // an expando property, which no setter-less descriptor route performs.
  if (!data && !accessor && descriptors?.some((entry) => entry.originalAbsent === true || entry.dynamicGet === true)) return null
  const targets = new Map<string, NativeFieldViewWrite['targets'][number]>()
  for (const target of data ?? accessor?.map((entry) => entry.write) ?? descriptors!.map((entry) => entry.write)) {
    if (target === null) {
      targets.set('no-setter', { target, conversion: null })
      continue
    }
    if (target.kind === 'dynamic' && !nativeFieldViewDynamicValueIsNative(operation.value.representation)) {
      const entries = descriptors?.filter((entry) => entry.write !== null && representationKey(entry.write) === representationKey(target))
      if (!entries?.length || entries.some((entry) => entry.declaredAnyEntry !== true)) return null
    }
    const node = conversions.nodeFor(operation.value.representation, target)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById)) return null
    targets.set(representationKey(target), { target, conversion: node.id })
  }
  return {
    receiver: operation.receiver.value,
    carrier: representationKey(operation.receiver.representation),
    key,
    value: operation.value.value,
    source: representationKey(operation.value.representation),
    targets: [...targets.values()]
  }
}

export const nativeFieldViewWriteSelectionOf = (
  operation: SetOperation,
  keys: readonly string[],
  flow: FieldFlow,
  conversions: ConversionCensus
): NativeFieldViewWrite | null => {
  const keyDomain = [...new Set(keys)].sort()
  const writes = keyDomain.map((key) => nativeFieldViewWriteOf(operation, key, flow, conversions))
  if (writes.length === 0 || writes.some((write) => write === null)) return null
  const targets = new Map<string, NativeFieldViewWrite['targets'][number]>()
  for (const write of writes)
    for (const target of write!.targets) targets.set(target.target === null ? 'no-setter' : representationKey(target.target), target)
  return { ...writes[0]!, keyDomain, targets: [...targets.values()] }
}

/** Independent certification recalculates the complete slot set and each canonical leaf. */
export const nativeFieldViewReceiptMatches = (
  expected: NativeFieldViewRead | NativeFieldViewWrite | null,
  actual: NativeFieldViewRead | NativeFieldViewWrite | undefined
): boolean => {
  if (!expected || !actual || expected.receiver !== actual.receiver || expected.carrier !== actual.carrier || expected.key !== actual.key)
    return false
  if (
    (expected.keyDomain === undefined) !== (actual.keyDomain === undefined) ||
    expected.keyDomain?.length !== actual.keyDomain?.length ||
    expected.keyDomain?.some((key, index) => key !== actual.keyDomain?.[index])
  )
    return false
  if ('sources' in expected && 'sources' in actual)
    return (
      expected.originalAbsent === actual.originalAbsent &&
      expected.openKeys === actual.openKeys &&
      expected.result === actual.result &&
      expected.sources.length === actual.sources.length &&
      expected.sources.every((entry, index) => {
        const held = actual.sources[index]!
        return entry.conversion === held.conversion && representationKey(entry.source) === representationKey(held.source)
      })
    )
  if ('targets' in expected && 'targets' in actual)
    return (
      expected.value === actual.value &&
      expected.source === actual.source &&
      expected.targets.length === actual.targets.length &&
      expected.targets.every((entry, index) => {
        const held = actual.targets[index]!
        return (
          entry.conversion === held.conversion &&
          (entry.target === null
            ? held.target === null
            : held.target !== null && representationKey(entry.target) === representationKey(held.target))
        )
      })
    )
  return false
}
