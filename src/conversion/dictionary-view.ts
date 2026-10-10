import { conversionRequiresSourceGuard, type ConversionCapability, type ConversionNode } from './algebra.js'
import { recipeClosureOf, recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import type { AcceptedConversion } from './structural-plan.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { NativeSelectionRecipe } from './native-selection.js'
import { dynamicWrapperDependenciesOf, dynamicWrapperPlanMatches } from './dynamic-wrapper.js'
import { nativePayloadTransportMatches } from './native-payload-transport.js'
import { nativeFieldViewIdentityTransportOf } from './native-field-view.js'

type Dictionary = Extract<Representation, { kind: 'dictionary' }>

export type DictionaryReadContract =
  | {
      readonly kind: 'dynamic-optional'
      readonly conversion: ConversionNode
      readonly target: Extract<Representation, { kind: 'optional' }>
      readonly present: ConversionNode
      readonly absent: ConversionNode
    }
  | { readonly kind: 'dynamic-absence'; readonly conversion: ConversionNode; readonly absence: 'null' | 'undefined' }
  | { readonly kind: 'dynamic-class'; readonly conversion: ConversionNode; readonly target: Extract<Representation, { kind: 'class-ref' }> }
  | { readonly kind: 'dynamic-payload'; readonly conversion: ConversionNode; readonly target: Representation; readonly tag: string }
  /** A function or construct-frame entry: `conversion` is the selected
   * dynamic -> callable (or constructor) adapter for the reader's own frame
   * (rest slot, physical receiver), so the entry is read exactly as any other
   * dynamic value of that carrier is. */
  | { readonly kind: 'dynamic-callable'; readonly conversion: ConversionNode }
  | { readonly kind: 'native-selection'; readonly conversion: ConversionNode; readonly selection: NativeSelectionRecipe }

/** One mutable object, read through a narrower native entry carrier and written back to its original storage. */
export interface CertifiedDictionaryViewPlan {
  readonly source: Dictionary
  readonly target: Dictionary
  readonly read: ConversionNode
  readonly write: ConversionNode
}

export interface CertifiedReadOnlyDictionaryViewPlan {
  readonly source: Dictionary
  readonly target: Dictionary
  readonly read: ConversionNode
}

export type DictionaryViewStep =
  | { readonly kind: 'conversion'; readonly conversion: ConversionNode }
  | { readonly kind: 'dictionary'; readonly view: CertifiedDictionaryViewPlan }
  | { readonly kind: 'read-only-dictionary'; readonly view: CertifiedReadOnlyDictionaryViewPlan }
  | { readonly kind: 'wrap'; readonly target: Extract<Representation, { kind: 'optional' }>; readonly payload: DictionaryViewStep }
  | {
      readonly kind: 'inject'
      readonly target: Extract<Representation, { kind: 'tagged-union' }>
      readonly index: number
      readonly payload: DictionaryViewStep
    }
  | { readonly kind: 'optional'; readonly present: DictionaryViewStep; readonly absent: DictionaryViewStep }
  | { readonly kind: 'dispatch'; readonly arms: readonly DictionaryViewStep[] }
  /** A dynamic object read as a typed table: `conversion` views it as the
   * open Document it is (`gea::dictionary::aliasOf`), and `payload` views that
   * Document through the typed entry carrier -- the same object, never a copy. */
  | { readonly kind: 'document'; readonly conversion: ConversionNode; readonly payload: DictionaryViewStep }

export interface ComposedDictionaryViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly step: DictionaryViewStep
  readonly dependencies: readonly ConversionNode[]
}

const exact = (source: Representation, target: Representation, accepted: AcceptedConversion): ConversionNode | null => {
  const node = accepted(source, target)
  if (node === null) return null
  if (representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== representationKey(target))
    throw new Error('a dictionary view received a conversion for different carriers')
  return node
}

/** Reading a view may check or unwrap a value, but may not copy an object into a new shape. */
const preservesReadValue = (capability: ConversionCapability): boolean => {
  switch (capability.kind) {
    case 'identity':
      return true
    case 'atom':
    case 'static':
      if (capability.materializer.dictionaryRead !== undefined)
        return preservesReadValue(capability.materializer.dictionaryRead.conversion.capability)
      if (capability.materializer.documentRecordView !== undefined) return capability.materializer.nativeFieldViewProtocol === 'live'
      if (capability.materializer.nativeArrayView !== undefined) return true
      // A wrapper only tests the absence tag or an arm classifier before its
      // selected payload reader runs; what it hands back is that reader's.
      if (capability.materializer.dynamicWrapper !== undefined)
        return (
          capability.materializer.dynamicWrapper.kind !== 'promise' &&
          dynamicWrapperDependenciesOf(capability.materializer.dynamicWrapper).every((child) => preservesReadValue(child.capability))
        )
      return (
        capability.materializer.recordView === undefined &&
        capability.materializer.recordToArray === undefined &&
        (!capability.materializer.allocates ||
          capability.materializer.nativePayloadTransport === 'preserved' ||
          // A callable carrier allocates its native frame around the SAME
          // function object; the read hands back that function, not a copy.
          capability.materializer.callableIdentityTransport === 'preserved')
      )
    case 'class-family':
      return !capability.materializer.allocates
    case 'optional':
      return preservesReadValue(capability.payload)
    case 'sum':
      return capability.arms.every((arm) => preservesReadValue(arm.capability))
    case 'collection':
      return capability.domain.preservesIdentity
    default:
      return false
  }
}

/**
 * A mutable view needs a total writer as well as its checked reader. A
 * successful narrowing check on a write is insufficient: a wide alias is
 * allowed to store every value of its own carrier. It cannot silently reject
 * or truncate values that the original narrow table has no storage for.
 */
export const dictionaryEntryWriteIsTotal = (node: ConversionNode, resolve?: (id: string) => ConversionNode | null): boolean => {
  if (!recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)) return false
  if ([...recipeClosureOf([node], resolve).values()].some((child) => conversionRequiresSourceGuard(child.capability, resolve))) return false
  if (node.capability.kind === 'identity') return true
  // This is the table's declared any/unknown ENTRY boundary, not an object
  // boxed to obtain a property protocol. The native table itself stays native.
  if (node.target.kind === 'dynamic' && node.target.reason !== 'untyped-callable') return true
  return (
    (node.capability.kind === 'atom' || node.capability.kind === 'static') &&
    node.capability.materializer.nativePayloadTransport === 'preserved'
  )
}

const primitiveCarrier = (value: Representation): boolean =>
  value.kind === 'scalar' || value.kind === 'string' || value.kind === 'symbol' || value.kind === 'null' || value.kind === 'undefined'

/** A payload the enclosing wrapper has already classified: it must hand back
 * the entry's own object, not a rebuilt one. */
const wrappedPayloadIsLive = (node: ConversionNode, resolve: (id: string) => ConversionNode | null): boolean =>
  recipeIsMaterializableWithoutPriorSourceGuard(node, resolve) &&
  preservesReadValue(node.capability) &&
  // A primitive arm has no identity a read could lose: the wrapper's tag test
  // is its whole check, and the unboxed number/string/absence IS the entry.
  (primitiveCarrier(node.target) ||
    nativePayloadTransportMatches(node.source, node.target, node) ||
    nativeFieldViewIdentityTransportOf(node) ||
    dictionaryEntryReadIsLive(node, resolve))

/** An installed optional or union wrapper executes its own source guard (the
 * absence tag, or each arm's classifier), so it is a checked read exactly when
 * every payload it selects is live. A Promise wrapper allocates its future. */
const checkedDynamicWrapperRead = (node: ConversionNode, resolve?: (id: string) => ConversionNode | null): boolean => {
  if (resolve === undefined || !('materializer' in node.capability)) return false
  const plan = node.capability.materializer.dynamicWrapper
  return (
    plan !== undefined &&
    plan.kind !== 'promise' &&
    dynamicWrapperPlanMatches(plan, node.source, node.target, resolve) &&
    dynamicWrapperDependenciesOf(plan).every((child) => wrappedPayloadIsLive(child, resolve))
  )
}

export const dictionaryEntryReadIsLive = (node: ConversionNode, resolve?: (id: string) => ConversionNode | null): boolean => {
  if (!recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)) return false
  // A by-value record (`representation/value-records.ts`) is one the whole
  // program never writes, never compares by identity, and holds only
  // primitives, so its checked product copy IS the entry's value: there is no
  // identity or later write for a copy to lose.
  if (node.target.kind === 'record' && node.target.ownership === 'owned' && node.capability.kind === 'product') return true
  if (!preservesReadValue(node.capability)) return false
  const needsCheck =
    (node.source.kind === 'dynamic' && node.target.kind !== 'dynamic') || conversionRequiresSourceGuard(node.capability, resolve)
  return (
    !needsCheck ||
    // A union read out of a declared-any entry classifies the entry against
    // every arm and refuses one no arm admits: the sum is its own check, and
    // `preservesReadValue` already proved no arm copies.
    (node.source.kind === 'dynamic' && node.capability.kind === 'sum') ||
    checkedDynamicWrapperRead(node, resolve) ||
    ('materializer' in node.capability &&
      (node.capability.materializer.dictionaryRead !== undefined ||
        node.capability.materializer.documentRecordView !== undefined ||
        node.capability.materializer.nativeArrayView !== undefined))
  )
}

/** Two shared tables of one non-symbol key whose entry carriers differ: the
 * only pair a dictionary view (mutable or read-only) can stand between. */
const viewableDictionaryPair = (
  source: Representation,
  target: Representation
): { readonly source: Dictionary; readonly target: Dictionary } | null =>
  source.kind === 'dictionary' &&
  target.kind === 'dictionary' &&
  source.key === target.key &&
  source.key !== 'symbol' &&
  source.ownership === 'shared-refcount' &&
  target.ownership === 'shared-refcount' &&
  source.recursive === undefined &&
  target.recursive === undefined &&
  representationKey(source.value) !== representationKey(target.value)
    ? { source, target }
    : null

/** Both deferred operations cite their exact complete recipes before certification. */
export const dictionaryViewPlan = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: (id: string) => ConversionNode | null,
  readAccepted: AcceptedConversion = accepted
): CertifiedDictionaryViewPlan | null => {
  const pair = viewableDictionaryPair(source, target)
  if (pair === null) return null
  const read = exact(pair.source.value, pair.target.value, readAccepted)
  const write = exact(pair.target.value, pair.source.value, accepted)
  return read !== null && write !== null && dictionaryEntryReadIsLive(read, resolve) && dictionaryEntryWriteIsTotal(write, resolve)
    ? { ...pair, read, write }
    : null
}

/** The source may retain mutable aliases, while this view exposes only reads. */
export const readOnlyDictionaryViewPlan = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: (id: string) => ConversionNode | null,
  readAccepted: AcceptedConversion = accepted
): CertifiedReadOnlyDictionaryViewPlan | null => {
  const pair = viewableDictionaryPair(source, target)
  if (pair === null) return null
  const read = exact(pair.source.value, pair.target.value, readAccepted)
  return read !== null && dictionaryEntryReadIsLive(read, resolve) ? { ...pair, read } : null
}

const dictionariesOf = (value: Representation): readonly Dictionary[] =>
  value.kind === 'dictionary'
    ? [value]
    : value.kind === 'optional'
      ? dictionariesOf(value.payload)
      : value.kind === 'tagged-union'
        ? value.arms.flatMap((arm) => dictionariesOf(arm.value))
        : []

/** Wrapper/sum homes are chosen here, before certification, rather than by an entry callback. */
export const composedDictionaryViewPlan = (
  source: Representation,
  target: Representation,
  mode: 'mutable' | 'read-only',
  accepted: AcceptedConversion,
  resolve?: (id: string) => ConversionNode | null,
  readAccepted: AcceptedConversion = accepted
): ComposedDictionaryViewPlan | null => {
  const documentSource = source.kind === 'dynamic' && source.reason !== 'untyped-callable' && target.kind === 'dictionary'
  if (!documentSource && !dictionariesOf(source).some((from) => dictionariesOf(target).some((into) => from.key === into.key))) return null
  const pending = new Set<string>()
  const build = (from: Representation, into: Representation): DictionaryViewStep | null => {
    const pair = `${representationKey(from)}->${representationKey(into)}`
    if (pending.has(pair)) return null
    pending.add(pair)
    try {
      if (from.kind === 'dynamic' && from.reason !== 'untyped-callable' && into.kind === 'dictionary' && into.key === 'string') {
        if (mode !== 'mutable') return null
        const document: Representation = { kind: 'dictionary', key: 'string', ownership: 'shared-refcount', value: from }
        if (representationKey(document) === representationKey(into)) return null
        const conversion = exact(from, document, accepted)
        if (conversion === null || !recipeIsMaterializableWithoutPriorSourceGuard(conversion, resolve)) return null
        // Each entry is read through the census's own dynamic -> entry load
        // (a record entry's live Document view), not the checked-entry
        // contract a table of this program's own boxes uses: an entry of the
        // viewed object is whatever that object holds, never this carrier's
        // exact payload.
        const view = dictionaryViewPlan(document, into, accepted, resolve, accepted)
        return view === null ? null : { kind: 'document', conversion, payload: { kind: 'dictionary', view } }
      }
      if (from.kind === 'dictionary' && into.kind === 'dictionary' && representationKey(from) !== representationKey(into)) {
        const view =
          mode === 'mutable'
            ? dictionaryViewPlan(from, into, accepted, resolve, readAccepted)
            : readOnlyDictionaryViewPlan(from, into, accepted, resolve, readAccepted)
        return view === null
          ? null
          : mode === 'mutable'
            ? { kind: 'dictionary', view: view as CertifiedDictionaryViewPlan }
            : { kind: 'read-only-dictionary', view }
      }
      const ordinary = exact(from, into, accepted)
      // A self-checking subset load still rejects live source arms. A view
      // must account for every wrapper/arm here; its entry reader owns any
      // later value check. Otherwise subtype reduction at a merge can discard
      // the narrow dictionary instead of viewing it through the wider table.
      if (
        ordinary !== null &&
        recipeIsMaterializableWithoutPriorSourceGuard(ordinary, resolve) &&
        [...recipeClosureOf([ordinary], resolve).values()].every((node) => !conversionRequiresSourceGuard(node.capability, resolve))
      )
        return { kind: 'conversion', conversion: ordinary }
      if (from.kind === 'optional') {
        const present = build(from.payload, into)
        const absent = build({ kind: from.absence }, into)
        return present !== null && absent !== null ? { kind: 'optional', present, absent } : null
      }
      if (from.kind === 'tagged-union') {
        const arms = from.arms.map((arm) => build(arm.value, into))
        return arms.every((arm): arm is DictionaryViewStep => arm !== null) ? { kind: 'dispatch', arms } : null
      }
      if (into.kind === 'optional') {
        const payload = build(from, into.payload)
        return payload === null ? null : { kind: 'wrap', target: into, payload }
      }
      if (into.kind === 'tagged-union') {
        const homes = into.arms.flatMap((arm, index) => {
          const payload = build(from, arm.value)
          return payload === null ? [] : [{ index, payload }]
        })
        return homes.length === 1 ? { kind: 'inject', target: into, ...homes[0]! } : null
      }
      return null
    } finally {
      pending.delete(pair)
    }
  }
  const step = build(source, target)
  if (step === null) return null
  let views = 0
  const dependencies = new Map<string, ConversionNode>()
  const cite = (node: ConversionNode): void => {
    const known = dependencies.get(node.id)
    if (known !== undefined && known !== node) throw new Error(`dictionary view has conflicting citations for ${node.id}`)
    dependencies.set(node.id, node)
  }
  const walk = (step: DictionaryViewStep): void => {
    switch (step.kind) {
      case 'conversion':
        cite(step.conversion)
        return
      case 'dictionary':
        ++views
        cite(step.view.read)
        cite(step.view.write)
        return
      case 'read-only-dictionary':
        ++views
        cite(step.view.read)
        return
      case 'document':
        cite(step.conversion)
        walk(step.payload)
        return
      case 'wrap':
      case 'inject':
        walk(step.payload)
        return
      case 'optional':
        walk(step.present)
        walk(step.absent)
        return
      case 'dispatch':
        for (const arm of step.arms) walk(arm)
    }
  }
  walk(step)
  return views === 0 ? null : { source, target, step, dependencies: [...dependencies.values()] }
}
