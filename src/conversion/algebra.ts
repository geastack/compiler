import type { CallableAbi, Representation, TaggedUnionArm } from '../representation/model.js'
import type { FunctionId } from '../identity/ids.js'
import type { NativeSelectionRecipe } from './native-selection.js'
import type { FamilyMemberKeys } from './record-view.js'
import type { PromiseAdoptionRecipe } from './promise-adoption.js'
import type { CallableViewPlan, CertifiedRecordViewPlan, RecordToArrayPlan } from './structural-plan.js'
import type { NativeMethodResultContract, NativeUnboundMethodContract } from './native-method.js'
import type { CertifiedIteratorObjectViewPlan } from './certified-iterator-object-view.js'
import type { CertifiedIterableObjectViewPlan, CertifiedProtocolIteratorPlan } from './certified-iterator-protocols.js'

/**
 * The closed dynamic-conversion algebra.
 *
 * Turning a dynamic value into a concrete carrier is a capability with an
 * explicit recipe, not a cast. Every node states the domain it accepts, how it
 * decides membership, and how it completes -- and `never` is a first-class
 * answer with a stated reason rather than a gap someone later fills with a
 * `static_cast`.
 *
 * The rule that makes the algebra sound: a classifier's domain must equal its
 * materializer's acceptance domain. A classifier that says yes to values the
 * materializer then rejects turns a type error into a silent wrong answer.
 */

export type ConversionNodeId = string

/** The two abstract operations a compute operand is coerced through before its operator runs (7.1.4 ToNumber, 7.1.17 ToString). */
export type CoercionOperation = 'ToNumber' | 'ToString'

/**
 * A pure membership test. It answers only whether a runtime value is in the
 * domain, and it may not allocate, call user code, or install an exception --
 * a speculative test that throws would make a mismatch observable.
 */
export interface ClassifierContract {
  /** Stable identity of the runtime classifier this capability requires. */
  readonly id: string
  /** The exact domain accepted, stated so a narrower materializer is a defect. */
  readonly domain: string
  /**
   * Callable domains are not a flat partition. A broad Function-tag test
   * overlaps every exact declaration-membership test, and two closed
   * memberships overlap whenever they share a FunctionId. Carrying that set
   * explicitly keeps sum certification from mistaking differently spelled
   * domain strings for disjoint executable predicates.
   */
  readonly callableDomain?: { readonly kind: 'tag' } | { readonly kind: 'membership'; readonly members: readonly FunctionId[] }
  /** The literal-field discriminator a record arm's classifier tests, stated so a printer authenticates it structurally. */
  readonly recordDiscriminator?: Extract<TaggedUnionArm['runtimeDiscriminator'], { readonly kind: 'record-literal' }>
}

/** Whether two executable classifier predicates can accept the same value. */
/** A composite domain (`any-of:a|b`, an arm that is itself a union) is the set of its members; a plain one is a singleton. */
const domainMembersOf = (domain: string): readonly string[] =>
  domain.startsWith('any-of:') ? domain.slice('any-of:'.length).split('|') : [domain]

export const classifierDomainsOverlap = (left: ClassifierContract, right: ClassifierContract): boolean => {
  if (left.domain === right.domain) return true
  const rightMembers = domainMembersOf(right.domain)
  if (domainMembersOf(left.domain).some((member) => rightMembers.includes(member))) return true
  const leftCallable = left.callableDomain
  const rightCallable = right.callableDomain
  if (leftCallable === undefined || rightCallable === undefined) return false
  if (leftCallable.kind === 'tag' || rightCallable.kind === 'tag') return true
  return leftCallable.members.some((member) => rightCallable.members.includes(member))
}

/** Whether two authenticated class-family predicates can accept one allocation. */
export const classRefDomainsOverlap = (
  left: Extract<Representation, { kind: 'class-ref' }>,
  right: Extract<Representation, { kind: 'class-ref' }>
): boolean =>
  left.ownership === right.ownership &&
  (left.declaration === right.declaration || left.ancestors.includes(right.declaration) || right.ancestors.includes(left.declaration))

/** A checked conversion. It reports match, mismatch, or a pre-existing abrupt completion. */
export interface MaterializerContract {
  /** This selected recipe has no normal result. Dead control-flow arms may
   * render it, but it cannot authenticate storage for a live source value. */
  readonly normalCompletion?: 'never'
  /** Native physical-this forwarding, with lazy exact Function ABI boundaries. */
  readonly nativeLogicalReceiver?: import('./native-logical-receiver.js').NativeLogicalReceiverRecipe
  /** Exact primitive boxing retains the ECMAScript value while changing its physical envelope. */
  readonly primitiveIdentityTransport?: 'preserved'
  /** Completion transfer selected before certification, including payload-free promise states. */
  readonly promiseAdoption?: PromiseAdoptionRecipe
  /** Selected dynamic wrapper payloads, including deferred promise completion readers. */
  readonly dynamicWrapper?: import('./dynamic-wrapper.js').DynamicWrapperPlan
  /** Element callbacks retain their exact source Array storage and native entry holders. */
  readonly nativeArrayView?: import('./array-view.js').NativeArrayViewPlan
  /** Copied original descriptors retain native storage and defer public field projections. */
  readonly nativeDescriptorSnapshot?: import('./native-descriptor-snapshot.js').NativeDescriptorSnapshotPlan
  /** Exact nested recipes whose capabilities must also be certified. */
  readonly dependencies?: readonly ConversionNode[]
  readonly recordView?: CertifiedRecordViewPlan
  readonly documentRecordView?: import('./document-record-view.js').ComposedDocumentRecordViewPlan
  /** The renderer retains live native field routes; a sealed layout plan alone does not assert alias transport. */
  readonly nativeFieldViewProtocol?: 'live'
  readonly recordToArray?: RecordToArrayPlan
  readonly callableView?: CallableViewPlan
  readonly callablePayload?: import('./structural-plan.js').CallablePayloadPlan
  readonly iteratorObjectView?: CertifiedIteratorObjectViewPlan
  readonly iterableObjectView?: CertifiedIterableObjectViewPlan
  readonly protocolIterator?: CertifiedProtocolIteratorPlan
  readonly dictionaryView?: import('./dictionary-view.js').ComposedDictionaryViewPlan
  readonly dictionaryRead?: import('./dictionary-view.js').DictionaryReadContract
  readonly readOnlyDictionary?: import('./dictionary-view.js').ComposedDictionaryViewPlan
  readonly nativeObjectSample?: import('./native-object-sample.js').NativeObjectSamplePlan
  readonly nativeMethod?: NativeUnboundMethodContract
  readonly nativeMethodResult?: NativeMethodResultContract
  /** Replays only the failure of this exact selected field tag reader on a disjoint native primitive. */
  readonly checkedNativeFieldRead?: { readonly checked: ConversionNode }
  /** An asserted record's per-class origin loads (`nodes.ts`'s `assertedViewFor`). */
  readonly assertedView?: import('./nodes.js').AssertedViewPlan
  /**
   * The materializer loads ONE arm of a sum: `guarded-load` reads the arm a
   * tag test selected, `native-sum` the alternative a native selection chose.
   * Either trusts a narrowing to have excluded every other arm.
   */
  readonly armSelection?: 'guarded-load' | 'native-sum'
  /**
   * How a dynamic source is read: `unbox-tag` checks the box's primitive tag
   * (`boxTag`), `unbox-payload` its exact native payload type,
   * `dynamic-carrier-in` adapts a boxed callable, `dynamic-constructor-in` a
   * boxed constructor (its result read by `constructedResult`), and
   * `promise-from-dynamic` adopts a boxed promise.
   */
  readonly wrapperKind?: 'unbox-tag' | 'unbox-payload' | 'dynamic-carrier-in' | 'dynamic-constructor-in' | 'promise-from-dynamic'
  /** The census's own reader of what `new` through the box returned, at the construct frame's result carrier. */
  readonly constructedResult?: ConversionNode
  /** The primitive tag an `unbox-tag` read checks. */
  readonly boxTag?: string
  readonly id: string
  /** The registry offers this static recipe only after a sealed structural recipe has declined. */
  readonly staticRecipeFallback?: true
  /** The domain the materializer actually accepts; must equal the classifier's. */
  readonly domain: string
  /** Whether the conversion can allocate, which is an ownership fact. */
  readonly allocates: boolean
  /** A classifier must prove the source lies in this narrower domain; it is not a total store home. */
  readonly requiresSourceGuard?: true
  /** This materializer performs that domain check before exposing a native payload. */
  readonly executesSourceGuard?: true
  /** Explicit proof that this recipe transfers native storage without invoking or publishing its dynamic field protocol. */
  readonly nativeFieldProtocol?: 'unused'
  /** An accessor-bearing native payload is recovered exactly, without rebuilding its environments or observing a getter. */
  readonly nativeAccessorPayload?: 'preserved'
  /**
   * The recipe reads no field protocol of its OPERAND, but converts some of
   * the operand's parts on the way: each carrier listed needs the reflection
   * an unknown conversion of that carrier would. A rebuilt record view names
   * its per-field conversions here (`recordViewResidualReflection`).
   */
  readonly residualReflection?: readonly Representation[]
  /** Every normal result only selects, wraps or unwraps native payloads;
   * normalCompletion separately excludes recipes that cannot store a value. */
  readonly nativePayloadTransport?: 'preserved'
  /** Every resulting native class reference still names an input object (or absence); no fresh field aliases are materialized. */
  readonly nativeClassReferenceIdentity?: 'preserved'
  /** A compiler-generated native entry adapter; its body invokes the source convention without dynamic field transport. */
  readonly callableAdapter?: { readonly from: CallableAbi; readonly to: CallableAbi }
  /** The native ABI view shares the source ECMAScript Function identity. */
  readonly callableIdentityTransport?: 'preserved'
  /** Selection steps sealed by the conversion authority, consumed without reclassifying arms in the target. */
  readonly nativeSelection?: NativeSelectionRecipe
}

export interface ConversionField {
  readonly key: string
  readonly required: boolean
  readonly capability: ConversionCapability
}

export interface ConversionArm {
  readonly tag: string
  readonly classifier: ClassifierContract
  readonly capability: ConversionCapability
}

/** The domain of a collection conversion, which is narrower than `IsArray`. */
export interface CollectionDomain {
  readonly classifier: ClassifierContract
  /** Exotic members excluded from the domain, reported rather than silently dropped. */
  readonly excluded: readonly string[]
  /** Holes and present-`undefined` are different and must both survive. */
  readonly preservesHoles: boolean
  /** The converted value must keep the source Array's identity, not copy it. */
  readonly preservesIdentity: boolean
}

export type ConversionCapability =
  /** No conversion exists. The reason is part of the answer. */
  | { readonly kind: 'never'; readonly reason: string }
  /** Source and target are the same carrier; nothing happens. */
  | { readonly kind: 'identity' }
  | { readonly kind: 'atom'; readonly classifier: ClassifierContract; readonly materializer: MaterializerContract }
  /**
   * An ECMAScript abstract operation whose domain is the whole source carrier.
   *
   * Unlike `atom`, this is not a speculative membership test followed by a
   * load. `ToString` may run user code through `@@toPrimitive` or an ordinary
   * object's methods and may complete abruptly, so pretending it has a pure
   * classifier would let the classifier/materializer contract lie about the
   * language operation it represents.
   */
  | { readonly kind: 'coercion'; readonly operation: CoercionOperation; readonly materializer: MaterializerContract }
  /**
   * A conversion the two carriers decide between themselves, with no value
   * to classify: an upcast, a callable's prefix-dropping constructor, a
   * record recast, a promise whose payload converts. The materializer names
   * the recipe by id -- the same id the printer's chain runs under -- and
   * `allocates` is its only runtime fact. Distinct from `atom` because there
   * is no classifier: nothing about the source value can fail the test, so
   * a classifier here would be an invented predicate over a settled fact.
   */
  | { readonly kind: 'static'; readonly materializer: MaterializerContract }
  /**
   * A base class-ref handle narrowed to a union of its own descendant
   * classes (`instanceof Circle || instanceof Square || instanceof Triangle`
   * proving a `Ref<Shape>` is one of the three). Distinct from `atom`
   * because its recipe -- `targets/cpp/emit-narrowing.ts`'s
   * `classFamilyLoadText` -- orders a most-specific-first cascade over
   * `ctx.classes`, the whole-program class table. The chain every other
   * `atom` renders through (`convertedValueText`) is deliberately
   * ctx-free, so a pair like this one that needs the class table cannot
   * be an `atom`: the printer must dispatch on this kind instead of
   * re-deriving the recipe from the chain.
   */
  | { readonly kind: 'class-family'; readonly materializer: MaterializerContract }
  | { readonly kind: 'optional'; readonly payload: ConversionCapability; readonly absenceTag: string }
  | { readonly kind: 'product'; readonly fields: readonly ConversionField[]; readonly materializer: MaterializerContract }
  | { readonly kind: 'collection'; readonly element: ConversionCapability; readonly domain: CollectionDomain }
  | { readonly kind: 'sum'; readonly arms: readonly ConversionArm[] }
  /** A cycle, referring to a node that must exist and must not itself be materializer-free. */
  | { readonly kind: 'recursive-ref'; readonly node: ConversionNodeId }

export type ConversionNodeResolver = (id: ConversionNodeId) => ConversionNode | null

const guardRequiredOf = (
  capability: ConversionCapability,
  resolve: ConversionNodeResolver | undefined,
  prior: boolean,
  visiting: Set<ConversionNodeId>
): boolean => {
  const materializerNeedsGuard = (materializer: MaterializerContract): boolean =>
    materializer.requiresSourceGuard === true && (!prior || materializer.executesSourceGuard !== true)
  const child = (capability: ConversionCapability): boolean => guardRequiredOf(capability, resolve, prior, visiting)
  switch (capability.kind) {
    case 'atom':
    case 'static':
    case 'coercion':
    case 'class-family':
      return materializerNeedsGuard(capability.materializer)
    case 'optional':
      return child(capability.payload)
    case 'product':
      return materializerNeedsGuard(capability.materializer) || capability.fields.some((field) => child(field.capability))
    case 'sum':
      return capability.arms.some((arm) => child(arm.capability))
    case 'collection':
      return child(capability.element)
    case 'recursive-ref': {
      const node = resolve?.(capability.node) ?? null
      if (node === null || node.capability.kind === 'never' || node.capability.kind === 'recursive-ref') return true
      if (visiting.has(node.id)) return false
      visiting.add(node.id)
      try {
        return child(node.capability)
      } finally {
        visiting.delete(node.id)
      }
    }
    default:
      return false
  }
}

/** Composite eager conversions retain every immediate payload guard, including authenticated recursive references. */
export const conversionRequiresSourceGuard = (capability: ConversionCapability, resolve?: ConversionNodeResolver): boolean =>
  guardRequiredOf(capability, resolve, false, new Set())

/** A future callback cannot reuse a control-flow proof about the value that constructed it. */
export const conversionNeedsPriorSourceGuard = (capability: ConversionCapability, resolve?: ConversionNodeResolver): boolean =>
  guardRequiredOf(capability, resolve, true, new Set())

/** One node of a conversion graph, with the exact carriers it converts between. */
export interface ConversionNode {
  readonly id: ConversionNodeId
  readonly source: Representation
  readonly target: Representation
  readonly capability: ConversionCapability
  /**
   * The family members the conversion site named, for a node minted by
   * `nodes.ts`'s `familyMemberViewFor` and no other: the one fact beside the
   * two carriers its record view is planned from, carried so the printer
   * renders the plan the census admitted rather than the pair's own.
   */
  readonly familyMembers?: FamilyMemberKeys
}

export const never = (reason: string): ConversionCapability => ({ kind: 'never', reason })

export const isNever = (capability: ConversionCapability): boolean => capability.kind === 'never'

/**
 * Whether a capability can actually run.
 *
 * A `sum` whose arms are all `never` cannot; neither can an `optional` whose
 * payload cannot. Reporting those as usable is how a conversion boundary ends
 * up default-constructing the first arm.
 */
export const isMaterializable = (capability: ConversionCapability): boolean => {
  switch (capability.kind) {
    case 'never':
      return false
    case 'identity':
    case 'atom':
    case 'coercion':
    case 'static':
    case 'class-family':
    case 'recursive-ref':
      return true
    case 'optional':
      return isMaterializable(capability.payload)
    case 'product':
      return capability.fields.every((field) => isMaterializable(field.capability))
    case 'collection':
      return isMaterializable(capability.element)
    case 'sum':
      return capability.arms.length > 0 && capability.arms.every((arm) => isMaterializable(arm.capability))
  }
}

/**
 * Whether running this conversion keeps both of its sides in native storage.
 *
 * This is NOT `isMaterializable`, which asks whether a recipe exists at all. It
 * asks the narrower question a closure proof needs: does anything on this edge
 * have to become a `gea::Value` on the way across. `nativeFieldProtocol:
 * 'unused'` is the recipe's OWN explicit proof of that, and the kinds that name
 * a materializer answer with it directly.
 *
 * The composite kinds have no recipe of their own to prove anything about -- an
 * `optional` adds an absence tag, a `sum` selects an arm, a `collection`
 * converts elements, a `product` converts fields -- so each carries the proof
 * of its parts, and `product` carries its own as well because it also
 * allocates the target.
 *
 * `coercion` is excluded by construction rather than by conservatism: its own
 * documentation is that `ToString` "may run user code through `@@toPrimitive`",
 * which is precisely the dynamic boundary this predicate exists to detect. A
 * `recursive-ref` names a node this function was not handed, and refusing is
 * the only safe answer for a predicate whose `true` grants closure.
 */
export const transfersNativeStorage = (capability: ConversionCapability): boolean => {
  switch (capability.kind) {
    case 'identity':
      return true
    case 'never':
    case 'coercion':
    case 'recursive-ref':
      return false
    case 'atom':
    case 'static':
    case 'class-family':
      return capability.materializer.nativeFieldProtocol === 'unused'
    case 'product':
      return (
        capability.materializer.nativeFieldProtocol === 'unused' &&
        capability.fields.every((field) => transfersNativeStorage(field.capability))
      )
    case 'optional':
      return transfersNativeStorage(capability.payload)
    case 'collection':
      return transfersNativeStorage(capability.element)
    case 'sum':
      return capability.arms.length > 0 && capability.arms.every((arm) => transfersNativeStorage(arm.capability))
  }
}

/**
 * Fail closed when a capability's parts do not agree.
 *
 * Each check corresponds to a way a conversion can look correct and behave
 * incorrectly: a classifier broader than its materializer accepts values that
 * then fail; a sum with duplicate tags resolves by position; a recursive
 * reference to a missing node never terminates.
 */
// Only membership is asked of `nodes`, so a caller can hand a view over the
// tables it already holds instead of copying every id into a fresh Set.
export const validateCapability = (
  capability: ConversionCapability,
  nodes: Pick<ReadonlySet<ConversionNodeId>, 'has'>,
  path = 'root'
): void => {
  switch (capability.kind) {
    case 'never':
    case 'identity':
      return
    case 'atom':
      if (capability.classifier.domain !== capability.materializer.domain) {
        throw new Error(
          `conversion at ${path}: classifier domain "${capability.classifier.domain}" ` +
            `does not equal materializer domain "${capability.materializer.domain}"`
        )
      }
      return
    case 'coercion':
    case 'static':
    // No classifier to check against a materializer domain -- like `static`,
    // the printer dispatches on the kind itself rather than on a speculative
    // membership test (see the kind's own doc comment in the union above).
    case 'class-family':
      return
    case 'optional':
      validateCapability(capability.payload, nodes, `${path}.payload`)
      return
    case 'product': {
      const seen = new Set<string>()
      for (const field of capability.fields) {
        if (seen.has(field.key)) throw new Error(`conversion at ${path}: duplicate product field "${field.key}"`)
        seen.add(field.key)
        validateCapability(field.capability, nodes, `${path}.${field.key}`)
      }
      return
    }
    case 'collection':
      validateCapability(capability.element, nodes, `${path}[]`)
      return
    case 'sum': {
      const seen = new Set<string>()
      for (const arm of capability.arms) {
        if (seen.has(arm.tag)) throw new Error(`conversion at ${path}: duplicate sum tag "${arm.tag}"`)
        seen.add(arm.tag)
        validateCapability(arm.capability, nodes, `${path}#${arm.tag}`)
      }
      if (
        capability.arms.some((arm, index) =>
          capability.arms.slice(index + 1).some((other) => classifierDomainsOverlap(arm.classifier, other.classifier))
        )
      ) {
        throw new Error(`conversion at ${path}: sum arms share a runtime domain and are therefore not pairwise disjoint`)
      }
      return
    }
    case 'recursive-ref':
      if (!nodes.has(capability.node)) throw new Error(`conversion at ${path}: recursive reference to unknown node ${capability.node}`)
      return
  }
}
