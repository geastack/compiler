import type { ClassifierMaterializerPair, CoercionOperation, ConversionRuntimeRegistry } from '../../conversion/registry.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from '../../representation/native-logical-receiver.js'
import { coercionText } from './emit-coercion.js'
import {
  classRefTransportKind,
  constructorFamilyUpcastMembers,
  constructorUpcastMember,
  nativeRecordBaseTransportKind
} from './class-ref-transport.js'
import type {
  ClassifierContract,
  CollectionDomain,
  ConversionNode,
  ConversionNodeResolver,
  MaterializerContract
} from '../../conversion/algebra.js'
import { callablePayloadPlan, callableViewPlan, certifiedRecordViewPlan, recordToArrayPlan } from '../../conversion/structural-plan.js'
import { recipeClosureOf } from '../../conversion/recipe-closure.js'
import { nativeFieldViewPlanIsLive } from '../../conversion/native-field-view.js'
import { promiseAdoptionPlanOf } from '../../conversion/promise-adoption.js'
import { composedDictionaryViewPlan } from '../../conversion/dictionary-view.js'
import {
  nativeArrayViewBasePlanOf,
  nativeArrayViewSourceIsBoxed,
  nativeArrayViewWithObservation,
  nativeArrayViewWithOwnerObservation
} from '../../conversion/array-view.js'
import { composedDocumentRecordViewPlanOf } from '../../conversion/document-record-view.js'
import { certifiedIteratorObjectViewPlan } from '../../conversion/certified-iterator-object-view.js'
import { chainFieldProtocolUnused, chainPayloadNeedsSourceGuard, nativeSumNarrowingTransports } from './native-narrowing-transport.js'
import {
  classRefDomainsOverlap,
  classifierDomainsOverlap,
  conversionNeedsPriorSourceGuard,
  conversionRequiresSourceGuard,
  transfersNativeStorage
} from '../../conversion/algebra.js'
import { emptyConversionRegistry, narrowingReachesTarget, narrowsToDescendantClassUnion } from '../../conversion/build.js'
import type { CallableAbi, Representation, TaggedUnionArm } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { defaultRecordLayoutPolicy } from '../../representation/policies.js'
import {
  abiKey,
  arrayExtensionKey,
  representationKey,
  carriesUndefined,
  containsUnresolved,
  isOpenDocument
} from '../../representation/model.js'
import {
  isSpellable,
  callableObjectAbi,
  resultAdapterTransportOf,
  adaptsConstructorIntoDispatch,
  boxDiscriminantsOfArm,
  type BoxDiscriminant,
  conversionRecipeOf,
  boxedAssertionText,
  classDocumentViewText,
  documentViewable,
  dropsAllParametersIntoResultArm,
  dropsUnboundParameters,
  dynamicTagFor,
  promisePayloadConvertible,
  rebasesRestOverLeadingParameters,
  CONSTRUCTOR_STATIC_VIEW,
  constructorStaticViewAdmitted,
  DYNAMIC_DICTIONARY_TO_NAMED_RECORD,
  dynamicDictionaryToNamedRecordAdmitted,
  indexedRecordCastableToDictionary,
  indexedRecordDictionaryArmOf,
  indexedRecordViewOf,
  INDEXED_RECORD_INTO_DICTIONARY_ARM,
  INDEXED_RECORD_TO_DICTIONARY,
  recordCastableToDictionary,
  recordRecastCrossesDynamic,
  recordsRecastable,
  sameArrayUpToExtension,
  sumIntoPayloadText,
  widensResultIntoArm,
  resultAdaptedCallableText,
  tryCandidateText,
  VIEW_ADAPTED_CALLABLE,
  CHECKED_ARM_NARROWING,
  checkedArmNarrowingText
} from './emit-narrowing.js'
import { NATIVE_SUM_CLASSIFIER, NATIVE_SUM_MATERIALIZER, nativeSumPlan, nativeSumPreservesPayload } from '../../conversion/native-sum.js'
import { NATIVE_REFERENCE_ABSENCE, nativeReferenceAbsenceOf } from '../../conversion/native-absence.js'
import {
  nativeSelectionGuardContractOf,
  nativeSelectionPreservesPayload,
  nativeSelectionRecipeOf,
  nativeSubsetSelectionRecipeOf,
  nativeTotalSelectionRecipeOf,
  type NativeSelectionRecipe
} from '../../conversion/native-selection.js'
import { nativeClassReferenceIdentityOf } from '../../conversion/native-class-reference.js'
import { certifiedIterableObjectViewPlan, certifiedProtocolIteratorPlan } from '../../conversion/certified-iterator-protocols.js'
import {
  isRecordViewTarget,
  ownedRecordMaterializationPlan,
  recordViewDispatchesArms,
  recordViewResidualReflection,
  recordViewUsesOnlyDirectFields,
  type FamilyMemberKeys,
  type RecordViewPlan
} from '../../conversion/record-view.js'
import { cppStringObjectNativeType } from './regexp-types.js'
import { viewPlanFor } from './emit-record-view.js'
import { FAMILY_MEMBER_VIEW_MATERIALIZER } from '../../conversion/nodes.js'
import { PROTOCOL_ITERATOR, protocolIteratorPlanFor } from './emit-protocol-iterator.js'
import { ITERABLE_OBJECT_VIEW, iterableObjectViewPlanFor } from './emit-iterable-object-view.js'
import { ITERATOR_OBJECT_VIEW, iteratorObjectViewPlanFor } from './emit-iterator-object-view.js'
import { CONSTRUCTOR_DISPATCH_FAMILY, CONSTRUCTOR_IDENTITY_FAMILY } from './emit-constructor-identity-family.js'
import { proxyArmWithoutHome } from '../../representation/proxy-carriers.js'
import { samePhysicalCarrier } from '../../representation/physical-carrier.js'
import { constructorDispatchFamilyPlan, constructorIdentityFamilyPlan } from '../../conversion/constructor-identity-family.js'

/** Called only after the native converting-constructor predicate has selected this pair. */
const nativeClassPresence = (value: Representation): boolean => {
  if (value.kind === 'class-ref' || value.kind === 'null' || value.kind === 'undefined') return true
  if (value.kind === 'optional') return nativeClassPresence(value.payload)
  return value.kind === 'tagged-union' && value.arms.every((arm) => nativeClassPresence(arm.value))
}

const nativeCallableTransport = (source: Representation, target: Representation) => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  return from === null || to === null
    ? {}
    : { nativeFieldProtocol: 'unused' as const, callableAdapter: { from, to }, callableIdentityTransport: 'preserved' as const }
}

const nativeSumConversion = (source: Representation, target: Representation): ClassifierMaterializerPair | null => {
  const plan = nativeSumPlan(source, target)
  if (plan === null) return null
  const domain = `sum-widen:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: NATIVE_SUM_CLASSIFIER, domain },
    materializer: {
      id: NATIVE_SUM_MATERIALIZER,
      domain,
      allocates: false,
      nativeFieldProtocol: 'unused',
      ...(nativeSumPreservesPayload(plan) ? { nativePayloadTransport: 'preserved' as const } : {}),
      ...nativeClassReferenceIdentityOf(source, target)
    }
  }
}

const nativeSelectionConversion = (
  source: Representation,
  target: Representation,
  nativeSelection: NativeSelectionRecipe
): ClassifierMaterializerPair => {
  const domain = `native-selection:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: 'gea::native-sum::selected-alternative', domain },
    materializer: {
      id: 'gea::native-sum::select',
      domain,
      allocates: false,
      armSelection: 'native-sum',
      nativeFieldProtocol: 'unused',
      ...(nativeSelectionPreservesPayload(nativeSelection) ? { nativePayloadTransport: 'preserved' as const } : {}),
      nativeSelection,
      ...nativeSelectionGuardContractOf(nativeSelection),
      ...nativeClassReferenceIdentityOf(source, target)
    }
  }
}

/**
 * What this backend can actually convert, stated as a registry the conversion
 * graph asks rather than assumes.
 *
 * Most entries are `null`, and that is the honest answer rather than a
 * placeholder. Conversion *from* the dynamic carrier -- classifying a boxed
 * value and materializing a concrete one out of it -- needs the box to be able
 * to say what it holds and to hand the payload back, and an entry is installed
 * here only where a primitive that really does both is already built.
 *
 * This paragraph used to say `gea::Value` could do neither, and that it was
 * storage and a tag and deliberately nothing more. The second half is right
 * about the part that matters -- a box has no dynamic OPERATIONS, no call, no
 * arithmetic, no coercion, which is what keeps a program that reads an
 * `unknown` refused while one that merely carries an unread one compiles. The
 * first half was wrong, and wrong in a way that hid four working primitives
 * behind a blanket claim: `Value::box` records
 * `payloadTypeTagFor<std::decay_t<T>>()` for every payload it stores, so a box
 * can name its payload's exact C++ type, and `gea::detail::unboxAs` hands that
 * payload back after checking both the tag and that type. Reporting a payload
 * is not the same capability as operating on one, and only the second is
 * deliberately absent.
 *
 * So the discipline this file keeps is not "install almost nothing". It is:
 * install exactly where a real classifier and a real materializer exist and
 * their domains are disjoint, and refuse everywhere else WITH THE REASON, so
 * that a later reader can tell an unimplemented entry from an impossible one.
 * A blanket claim cannot make that distinction, which is how the class-ref
 * entry below came to be missing for as long as it was while both directions
 * of its round trip sat built and unused.
 *
 * The one entry that is installed is the narrowing unwrap, and it is installed
 * because it is genuinely built. `gea::Optional<T>` (gea_runtime.h) is a
 * presence flag plus an always-constructed payload, with `has_value()` as the
 * pure membership test and `operator*` as the load. Both are real operations on
 * a real type, and `emitBindingRead` renders exactly them.
 *
 * What licenses the unwrap is the checker's own narrowing, not a proof this
 * backend re-derives: inside `if (tag)` TypeScript has already established that
 * the cell holds a value, and re-testing it here would be a second authority
 * answering a settled question -- and would need somewhere to go when it
 * disagreed, which a load has not got. The payload is always constructed, so a
 * narrowing that was somehow wrong reads a default-constructed value rather
 * than stepping off the end of anything; deterministic, and still wrong, which
 * is the right place for the consequence of an unsound narrowing to land.
 */
/**
 * The exact-tag read out of a box, for the three carriers whose payload C++
 * type the carrier itself names.
 *
 * `gea::detail::unboxValue` (gea_runtime.h) checks the box's tag AND the C++
 * type of its payload and aborts by name when either disagrees, so this is an
 * exact tag test and never a coercion -- which is the discipline
 * `ConversionRuntimeRegistry` puts on these three entries specifically. What
 * licenses it is the same thing that licenses the narrowing unwrap below: the
 * program stated the type (`a as unknown as string`) and the checker erased
 * the statement, so the only thing left to do at runtime is read the payload
 * and refuse loudly if it is not there.
 *
 * `emit-narrowing.ts`'s `unboxedLoadText` renders this same
 * `unboxValue<T>` load, and it renders it for every tag that has a payload to
 * read rather than only for these three -- which is why `classRefMaterializer`
 * below can be installed without touching the emitter at all.
 */
/**
 * Whether a carrier can be boxed into `gea::Value`.
 *
 * `dynamicTagFor` answers for a carrier that HAS one JavaScript type. A sum
 * does not -- which type it is depends on which arm is live, or on whether an
 * optional is present at all -- so the question recurses through both sum
 * carriers, exactly as `emit-narrowing.ts`'s `widenedStoreText` recurses when
 * it RENDERS the store. Asked as one predicate rather than restated per
 * branch, because the branch that restated it read only one level and refused
 * `tagged-union(record | optional(callable))`: a middleware-composition
 * function builds that carrier for its handler, and the render was ready for it.
 */
const boxable = (representation: Representation): boolean => {
  // Already a box. `dynamicTagFor` answers `null` for it -- a box holds
  // whichever tag its value carries, not one fixed tag -- and reading that as
  // "cannot be boxed" refused a composed handler typed
  // `tagged-union(dynamic | optional(callable))`, whose first arm is one.
  if (representation.kind === 'dynamic') return true
  if (representation.kind === 'optional') return boxable(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => boxable(arm.value))
  return dynamicTagFor(representation) !== null
}

const exactTagRead = (tag: string): ClassifierMaterializerPair => ({
  classifier: { id: 'gea::Value::tag', domain: `tag:${tag}` },
  materializer: { id: 'gea::detail::unboxValue', domain: `tag:${tag}`, allocates: false, wrapperKind: 'unbox-tag', boxTag: tag }
})

/**
 * A derived class-ref stored into a base class-ref cell.
 *
 * `gea::Ref<T>` declares a converting constructor from `gea::Ref<Other>` gated
 * on `std::is_convertible_v<Other*, T*>` (`gea_runtime.h`), and `records.ts`
 * emits `struct D : B` for a class that states a base -- so the C++ base
 * subobject the conversion needs is exactly the one the struct already has.
 * Nothing is rendered for it: the emitter's ordinary store text is the
 * conversion, the same way the `CallableObject` converting constructors above
 * are performed by naming the target type.
 *
 * Only in the ancestor direction, and only between two classes with the same
 * ownership. A base written into a derived cell is a downcast the language
 * does not perform implicitly either, and two carriers of the same class under
 * different ownership are different physical things (`gea::Ref<T>` and a `T`
 * by value), not a heritage question at all.
 */
const upcastsToBase = (source: Representation, target: Representation): boolean => classRefTransportKind(source, target) === 'upcast'

/**
 * The exact mirror: a BASE class-ref read at one of its descendants, which is
 * what `instanceof` narrows and what `upcastsToBase` above cannot express.
 *
 * `node.visit( part => { if ( part instanceof Derived ) part.flag = true } )`
 * is the shape, and it is the one `instanceof` exists for -- the
 * handle is declared at the base and the guard proves the object is a
 * descendant. Nothing had ever PROPOSED the pair (`conversion/build.ts`'s
 * class-ref loop asked only `widening`), so the reads past the guard carried
 * two unmet obligations and the program could not certify.
 *
 * `gea::host::downcastClassRef` (gea_runtime.h) is the load: `staticCast` plus
 * a `static_assert` that the heritage this function checks really holds in the
 * emitted structs. The physical layout classifier reads the handle's allocated
 * type. JavaScript `instanceof` additionally observes prototype ancestry;
 * layout selection must not discard a prototype object merely because it is
 * not an instance of its own constructor.
 */
const downcastsToDerived = (source: Representation, target: Representation): boolean =>
  classRefTransportKind(source, target) === 'downcast' || nativeRecordBaseTransportKind(source, target) === 'downcast'

/** Exactly one class arm inside `target` accepts `source` by inheritance. */
const hasSingleClassUpcastHome = (source: Representation, target: Representation): boolean => {
  // A class extending the intrinsic `Error` reaches an `Error` arm by the same
  // pointer upcast a bare `Error` slot takes: a program hands its own error
  // subclass to an `(err?: Error | null)` callback.
  if (upcastsToBase(source, target) || (target.kind !== source.kind && nativeRecordBaseTransportKind(source, target) === 'upcast'))
    return true
  if (target.kind === 'optional') return hasSingleClassUpcastHome(source, target.payload)
  if (target.kind !== 'tagged-union') return false
  return target.arms.filter((arm) => hasSingleClassUpcastHome(source, arm.value)).length === 1
}

/** The checked dynamic-call adapter shape currently installed by the runtime registry. */
/**
 * A choice among generic functions into a superset of the same choice: the
 * tag is remapped (`emit-narrowing.ts`'s `genericFunctionSetWideningText`).
 * One pair for every direction a store, a merge or a recast asks it in --
 * the index space is the target's, whichever way the plan phrased the step.
 */
const genericFunctionSetPair = (source: Representation, target: Representation): ClassifierMaterializerPair | null => {
  if (target.kind !== 'generic-function-set') return null
  if (source.kind === 'generic-function-set') {
    if (!source.members.every((member) => target.members.includes(member))) return null
  } else if (
    // A member's own name, read as the callable its cell holds, into the
    // one-member set it denotes: index 0, whatever the callable is.
    !(
      (source.kind === 'function' ||
        source.kind === 'function-family' ||
        source.kind === 'function-value-family' ||
        source.kind === 'function-value-dispatch') &&
      target.members.length === 1
    )
  ) {
    return null
  }
  const domain = `generic-function-set:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: 'generic-function-set::index', domain },
    materializer: { id: 'generic-function-set::remap', domain, allocates: false, nativeFieldProtocol: 'unused' }
  }
}

/**
 * A declaration/family callable and an evaluated callable dispatch differ in
 * authentication, not in their stored frame.  This is intentionally narrower
 * than an adapter: each formal, its passing ownership, receiver, rest slot,
 * and result must share the representation model's exact ABI identity.
 */
/**
 * Any callable stored where a function IDENTITY is declared -- the carrier of
 * `(...args: never[]) => R`.
 *
 * `gea::CallableObject` already holds a `Ref<FunctionObjectIdentity>` beside
 * its thunk, so this reads a field rather than building anything; the accessor
 * mints the identity on first read for a callable that has not been asked
 * before, which is why it is declared as allocating. `gea::ConstructorObject`
 * carries no such field, so the constructor-only carriers are not offered and
 * keep their refusal. Kept in step with `emit-narrowing.ts`'s
 * `callableIdentityText`, which renders exactly this pair.
 */
const callableIdentityPair = (source: Representation, target: Representation): ClassifierMaterializerPair | null => {
  if (target.kind !== 'callable-identity') return null
  const spellsCallableObject =
    source.kind === 'function' ||
    source.kind === 'function-family' ||
    source.kind === 'function-value-family' ||
    source.kind === 'function-value-dispatch' ||
    source.kind === 'function-and-constructor'
  if (!spellsCallableObject) return null
  const domain = `callable-identity:${representationKey(source)}`
  return {
    classifier: { id: 'gea::CallableObject::functionObjectIdentity', domain },
    materializer: { id: 'gea::CallableObject::functionObjectIdentity', domain, allocates: true }
  }
}

/**
 * A call-only function object entering a slot that also names its
 * `[[Construct]]` -- `Factory as typeof Factory & (new (v: number) => T)`.
 *
 * The call halves must be the SAME frame, not merely compatible ones: an
 * adapted frame is a different function object, and what this pair claims is
 * that the value survives unchanged -- same environment, same
 * `FunctionObjectIdentity`, one own-property table. The only thing added is
 * the construct entry, and `emit-narrowing.ts`'s `callableConstructEntryText`
 * renders it as a lookup by the value's own invoke pointer, against the table
 * `translation-unit.ts` publishes beside each construct thunk. So the pair is
 * admissible on the frames alone: whether THIS function object has such an
 * entry is a fact only the value carries, and a value that does not refuses by
 * name at run time rather than constructing through another body.
 */
const callableConstructEntryPair = (source: Representation, target: Representation): ClassifierMaterializerPair | null => {
  if (target.kind !== 'function-and-constructor') return null
  const call =
    source.kind === 'function' ||
    source.kind === 'function-family' ||
    source.kind === 'function-value-family' ||
    source.kind === 'function-value-dispatch'
      ? source.abi
      : null
  if (call === null || abiKey(call) !== abiKey(target.call)) return null
  const domain = `callable-construct-entry:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: 'gea::CallableObject::identity', domain },
    materializer: { id: 'gea::withConstructEntry', domain, allocates: false }
  }
}

const exactFunctionDispatchPair = (source: Representation, target: Representation): ClassifierMaterializerPair | null => {
  if (target.kind !== 'function-value-dispatch') return null
  if (
    source.kind !== 'function' &&
    source.kind !== 'function-family' &&
    source.kind !== 'function-value-family' &&
    source.kind !== 'function-value-dispatch'
  ) {
    return null
  }
  if (abiKey(source.abi) !== abiKey(target.abi)) return null
  const domain = `callable-exact-dispatch:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: 'gea::CallableObject::identity', domain },
    materializer: { id: 'gea::CallableObject::identity', domain, allocates: false }
  }
}

/** The executable classifier used by both dynamic sums and callable-carrier admission. */
const cppTaggedUnionArmClassifier = (arm: TaggedUnionArm): ClassifierContract | null => {
  let discriminants: ReturnType<typeof boxDiscriminantsOfArm>
  try {
    discriminants = boxDiscriminantsOfArm(arm)
  } catch {
    return null
  }
  if (discriminants === null || discriminants.length === 0) return null
  if (arm.runtimeDiscriminator.kind === 'record-literal') {
    return {
      id: 'gea::detail::dynamicRecordDiscriminator',
      domain: `record-literal:${JSON.stringify(arm.runtimeDiscriminator)}`,
      recordDiscriminator: arm.runtimeDiscriminator
    }
  }
  if (arm.runtimeDiscriminator.kind === 'callable-tag') {
    return {
      id: 'gea::Value::tag',
      domain: 'tag:Function',
      callableDomain: { kind: 'tag' }
    }
  }
  // An arm that is itself a union -- `T | undefined | null` whose present
  // arm holds `string | number` -- is classified by the disjunction of its
  // members' tests: the box holds this arm when any member's test accepts
  // it, and it is disjoint from another arm when no member's domain meets
  // that arm's (`algebra.ts`'s `classifierDomainsOverlap` reads the
  // composite). Callable memberships are not a flat partition, so an arm
  // mixing them in stays unclassified, as it always was.
  if (discriminants.length > 1) {
    if (discriminants.some((entry) => entry.callableMembers !== null)) return null
    const domains = [...new Set(discriminants.map(boxDiscriminantDomainOf))].sort()
    return { id: 'gea::Value::tagAnyOf', domain: `any-of:${domains.join('|')}` }
  }
  const discriminant = discriminants[0]!
  if (discriminant.callableMembers !== null) {
    return {
      id: 'gea::Value::callableDeclarationIdentity',
      domain: `callable-membership:${[...discriminant.callableMembers].sort().join('+')}`,
      callableDomain: { kind: 'membership', members: [...discriminant.callableMembers].sort() }
    }
  }
  if (discriminant.nominal !== null) {
    return { id: 'gea::detail::classIdentityExtends', domain: boxDiscriminantDomainOf(discriminant) }
  }
  if (discriminant.payload !== null) {
    return { id: 'gea::Value::tag+payloadType', domain: boxDiscriminantDomainOf(discriminant) }
  }
  return { id: 'gea::Value::tag', domain: boxDiscriminantDomainOf(discriminant) }
}

/** The runtime domain one box discriminant accepts, spelled the way `classifierDomainsOverlap` compares it. */
const boxDiscriminantDomainOf = (discriminant: BoxDiscriminant): string =>
  discriminant.nominal !== null
    ? `class-family:${discriminant.nominal}`
    : discriminant.payload !== null
      ? `tag-payload:${discriminant.tag}:${discriminant.payload}`
      : `tag:${discriminant.tag}`

/** The exact Representation-side mirror of callable-runtime carrier support. */
const dynamicCarrierSupported = (representation: Representation, seen = new Set<Representation>()): boolean => {
  if (seen.has(representation)) return true
  const nested = new Set(seen).add(representation)
  switch (representation.kind) {
    case 'dynamic':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
      return true
    case 'scalar':
      return representation.domain === 'number' || representation.domain === 'boolean'
    case 'optional':
      // Callable Optional<T> has one deliberately narrow runtime ABI:
      // absence is Undefined. The Representation retains which source tag
      // absence means, so nullable forms fail preflight while the exact
      // undefined form can use that ABI without accepting Null by accident.
      return representation.absence === 'undefined' && dynamicCarrierSupported(representation.payload, nested)
    case 'tagged-union': {
      if (!representation.arms.every((arm) => dynamicCarrierSupported(arm.value, nested))) return false
      for (let left = 0; left < representation.arms.length; left++) {
        const leftValue = representation.arms[left]!.value
        if (leftValue.kind !== 'class-ref') continue
        for (let right = left + 1; right < representation.arms.length; right++) {
          const rightValue = representation.arms[right]!.value
          if (rightValue.kind === 'class-ref' && classRefDomainsOverlap(leftValue, rightValue)) return false
        }
      }
      const classifiers = representation.arms.map(cppTaggedUnionArmClassifier)
      if (classifiers.some((classifier) => classifier === null)) return false
      const installed = classifiers as ClassifierContract[]
      return !installed.some((classifier, index) => installed.slice(index + 1).some((other) => classifierDomainsOverlap(classifier, other)))
    }
    case 'array-object':
    case 'class-ref':
    case 'record-with-index':
    case 'native-record-ref':
    // One `gea::Ref<gea::TypedArray<E>>`, authenticated off its allocation
    // header like any other counted handle.
    case 'typed-array':
      return representation.ownership === 'shared-refcount'
    // An owned record crosses by value, checked by exact payload type
    // (`DynamicCarrier<T>` for a `NativeFieldTable` struct).
    case 'record':
      return representation.ownership === 'shared-refcount' || representation.ownership === 'owned'
    case 'promise':
      return dynamicCarrierSupported(representation.value, nested)
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return dynamicCallableAbiSupported(representation.abi, nested)
    case 'void':
      return true
    default:
      return false
  }
}

const dynamicCallableAbiSupported = (
  abi: CallableAbi,
  seen = new Set<Representation>(),
  argument: (value: Representation, seen: Set<Representation>) => boolean = dynamicCarrierSupported
): boolean => {
  if (abi.receiver !== null && !dynamicCarrierSupported(abi.receiver, seen)) return false
  if (abi.result.kind !== 'void' && !dynamicCarrierSupported(abi.result, seen)) return false
  if (!abi.parameters.every((parameter) => argument(parameter.value, seen))) return false
  if (abi.restFrom === null) return true
  const rest = abi.parameters[abi.restFrom]?.value
  if (abi.restFrom !== abi.parameters.length - 1 || rest === undefined) return false
  if (rest.kind === 'array-object') return rest.ownership === 'shared-refcount' && dynamicCarrierSupported(rest.element, seen)
  return dynamicRestTupleSupported(rest, seen)
}

/**
 * A rest slot carried as a closed tuple record, not an Array: a function that
 * forwards `arguments` to a fixed-arity call (a wrapper written as
 * `function f() { target.f( ...arguments ) }`) lowers
 * its argument list to a record whose own keys are the canonical indexes. The
 * runtime's `DynamicRestArgument<Ref<T>>` spreads its present index keys in
 * order and packs incoming arguments by index, through the record's own field
 * table -- so the record must be nothing but those index slots.
 */
const dynamicRestTupleSupported = (rest: Representation, seen: Set<Representation>): boolean =>
  rest.kind === 'record' &&
  rest.ownership === 'shared-refcount' &&
  rest.accessors.length === 0 &&
  rest.fields.every((field, index) => field.key === String(index) && dynamicCarrierSupported(field.value, seen))

/**
 * What a checked adapter over a dynamic function does with an argument: it
 * only boxes it OUT (`adapt` in gea_runtime.h); only the result is read back
 * in. A union argument therefore needs every arm boxable, which is exactly
 * `DynamicCallableCarrier<TaggedUnion>::supported` -- not the disjoint arm
 * classifiers that reading one back from a Value needs. A property-bag
 * `update(object, key, value)` takes `value` as the union of everything the
 * bag holds -- itself a union nested inside the absences -- whose class arms
 * share a family, beside typed string-keyed tables.
 */
const dynamicArgumentCarrierSupported = (representation: Representation, seen: Set<Representation>): boolean =>
  representation.kind === 'tagged-union'
    ? representation.arms.every((arm) => dynamicArgumentCarrierSupported(arm.value, seen))
    : // A typed `Record<string, V>` table boxes out as itself
      // (`DynamicCarrier<Ref<T>>::out`); only reading one back in needs the
      // entry-checking view a bare frame position has no recipe for.
      (representation.kind === 'dictionary' && representation.ownership === 'shared-refcount') ||
      dynamicCarrierSupported(representation, seen)

const dynamicCallablePair = (target: Extract<Representation, { kind: 'function-value-dispatch' }>): ClassifierMaterializerPair => {
  const domain = `dynamic-callable:${representationKey(target)}`
  return {
    classifier: { id: 'gea::Value::tag', domain },
    materializer: {
      id: 'gea::detail::DynamicCarrier::in',
      domain,
      allocates: true,
      callableIdentityTransport: 'preserved',
      wrapperKind: 'dynamic-carrier-in'
    }
  }
}

// A reader's physical receiver uses its separately sealed native factory.
// Positional/result Optional carriers retain the ordinary dynamic-frame
// restrictions; the factory alone supplies null/undefined receiver policy.
const dynamicCallableReadAbiSupported = (abi: CallableAbi): boolean =>
  dynamicCallableAbiSupported({ ...abi, receiver: null }, new Set(), dynamicArgumentCarrierSupported) &&
  (abi.receiver === null || nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(abi.receiver)))

type NativeNarrowingContract = Pick<MaterializerContract, 'nativeFieldProtocol' | 'nativePayloadTransport' | 'requiresSourceGuard'>

/** Record/array construction immediately performs every cited payload conversion. */
const sourceGuardsOf = (
  nodes: readonly ConversionNode[],
  resolve?: ConversionNodeResolver
): Pick<MaterializerContract, 'requiresSourceGuard' | 'executesSourceGuard'> => {
  if (!nodes.some((node) => conversionRequiresSourceGuard(node.capability, resolve))) return {}
  return {
    requiresSourceGuard: true,
    ...(!nodes.some((node) => conversionNeedsPriorSourceGuard(node.capability, resolve)) ? { executesSourceGuard: true as const } : {})
  }
}

/**
 * A shared class handle among a sum's arms, at a record-shaped target it
 * reaches by neither the chain nor the structural view.
 *
 * Nothing in the program proves that arm dead: an interface-typed slot holds
 * whatever object the program put there (`semantics/interface-implementors.ts`),
 * and a class this cannot view as the record is still a value the slot can be
 * handed -- `const x: SomeInterface | null = Ctor ? new Ctor() : createOther()`,
 * where the other class carries class-typed fields and a promise the view
 * cannot rebuild. Selecting the record arm
 * there read the class instance's bytes as the record and crashed at launch,
 * certified. A record arm beside the exact one is the opposite case: a record
 * the view cannot rebuild as the target is not assignable to it either, so the
 * checker's own narrowing is what put the pair here, and the selection stands.
 *
 * Asked by every table that could answer the pair -- `narrowing`,
 * `structuralRecipe` and `staticRecipe` -- so the census refuses it outright
 * rather than one table declining and the next selecting.
 */
const classArmWithoutHome = (layouts: RecordLayoutPolicy, source: Representation, target: Representation): boolean => {
  const union = source.kind === 'optional' ? source.payload : source
  const selected = target.kind === 'optional' ? target.payload : target
  if (union.kind !== 'tagged-union' || !isRecordViewTarget(selected)) return false
  const key = representationKey(selected)
  return union.arms.some(
    ({ value }) =>
      value.kind === 'class-ref' &&
      value.ownership === 'shared-refcount' &&
      representationKey(value) !== key &&
      conversionRecipeOf(value, selected)?.renders !== true &&
      viewPlanFor(layouts, value, selected) === null
  )
}

export const createCppConversionRegistry = (layouts: RecordLayoutPolicy = defaultRecordLayoutPolicy): ConversionRuntimeRegistry => {
  // A sum narrowing's contract is composed from the contracts this same
  // registry states for its leaf pairs (`native-narrowing-transport.ts`), so
  // the tables are handed a view of the finished registry.
  const registry: ConversionRuntimeRegistry = cppConversionTables(
    layouts,
    (source, target) =>
      nativeSumNarrowingTransports(registry, source, target) ? { nativeFieldProtocol: 'unused', nativePayloadTransport: 'preserved' } : {},
    (source, payload) => ({
      ...(chainFieldProtocolUnused(registry, source, payload) ? { nativeFieldProtocol: 'unused' as const } : {}),
      ...(chainPayloadNeedsSourceGuard(registry, source, payload) ? { requiresSourceGuard: true as const } : {})
    })
  )
  return registry
}

/**
 * The registry's per-pair claim, as `recordViewUsesOnlyDirectFields` asks it
 * of a held field converted into the view's carrier. A recursive record
 * (`Filter<T>` holds `Filter<T>[]`) revisits its own pair; the claim is
 * coinductive, so a pair already being asked answers `true` and every other
 * obligation on the cycle is still asked in its own frame.
 */
const heldPairsInProgress = new Set<string>()
const heldPairUnusedOf =
  (wrapped: (source: Representation, payload: Representation) => NativeNarrowingContract) =>
  (from: Representation, to: Representation): boolean => {
    const pair = `${representationKey(from)}->${representationKey(to)}`
    if (heldPairsInProgress.has(pair)) return true
    heldPairsInProgress.add(pair)
    try {
      return wrapped(from, to).nativeFieldProtocol === 'unused'
    } finally {
      heldPairsInProgress.delete(pair)
    }
  }

const cppConversionTables = (
  layouts: RecordLayoutPolicy,
  nativeNarrowing: (source: Representation, target: Representation) => NativeNarrowingContract,
  nativeWrappedPayload: (source: Representation, payload: Representation) => NativeNarrowingContract
): ConversionRuntimeRegistry => {
  // A rebuilt view's claim: native when every read is direct, otherwise the
  // per-field conversions it still performs (`recordViewResidualReflection`).
  const viewProtocolOf = (plan: RecordViewPlan): Pick<MaterializerContract, 'nativeFieldProtocol' | 'residualReflection'> => {
    const heldUnused = heldPairUnusedOf(nativeWrappedPayload)
    if (recordViewUsesOnlyDirectFields(plan, heldUnused)) return { nativeFieldProtocol: 'unused' }
    const residual = recordViewResidualReflection(plan, heldUnused)
    return residual === null ? {} : { residualReflection: residual }
  }
  return {
    ...emptyConversionRegistry,
    stringMaterializer: () => exactTagRead('String'),
    /**
     * `gea::Symbol` out of a box is the same exact-tag read as a string: the
     * printer's `unboxedLoadText` spells it `unboxValue<gea::Symbol>(v,
     * Tag::Symbol, ...)` off `dynamicTagFor`'s own `symbol -> 'Symbol'` row.
     * The registry left this `null` while the printer rendered it, so a
     * `typeof x === 'symbol'` narrowing certified nothing (no installed exact
     * symbol-tag materializer) on a program the printer had always emitted --
     * the census/printer disagreement Phase 2.3's emission gate exists to
     * surface, found on `symbol-description.runtime.js`.
     */
    symbolMaterializer: () => exactTagRead('Symbol'),
    scalarMaterializer: (domain) =>
      domain === 'number'
        ? exactTagRead('Number')
        : domain === 'boolean'
          ? exactTagRead('Boolean')
          : domain === 'bigint'
            ? exactTagRead('BigInt')
            : null,
    /**
     * `undefined` out of a box: `exactTagRead` above cannot serve this either,
     * for the identical reason `gea::detail::unboxUndefinedValue`
     * (gea_runtime.h) exists instead of reusing `unboxValue<T>` -- there is no
     * payload, so no `T` to have recorded a `payloadTypeTagFor` for. The tag
     * alone is the whole check; a mismatch aborts by name, exactly the same
     * refusal discipline as every other exact-tag read in this registry.
     */
    undefinedMaterializer: () => ({
      classifier: { id: 'gea::Value::tag', domain: 'tag:Undefined' },
      materializer: { id: 'gea::detail::unboxUndefinedValue', domain: 'tag:Undefined', allocates: false }
    }),
    /**
     * A bare `Function` is intentionally dynamic: it promises `[[Call]]`, but
     * no static parameter or result types. The runtime's
     * `DynamicCarrier<CallableObject<R(A...)>>::in` is the checked bridge from
     * that boundary. It verifies `Tag::Function`, preserves an exact-ABI value
     * directly when possible, and otherwise returns a callable adapter that
     * boxes the target ABI's arguments, invokes the source box, and checks the
     * returned value as `R`.
     *
     * Install only the ABI presently proved end to end: a receiver-less,
     * fixed-arity numeric comparator whose arguments are themselves dynamic
     * values -- the shape of a public `Function | null` sort hook. Broadening the
     * predicate requires matching `DynamicCarrier<T>::supported` for every new
     * parameter/result carrier; guessing there would move an honest preflight
     * refusal into a C++ template failure.
     */
    functionValueDispatchMaterializer: (abi) => {
      const target = { kind: 'function-value-dispatch' as const, abi }
      return dynamicCallableReadAbiSupported(abi) ? dynamicCallablePair(target) : null
    },
    /**
     * `DynamicCarrier<ConstructorObject<R(A...)>>::readWith`: an exact payload
     * is the constructor itself; any other box is constructed through
     * `Value::construct`, which throws the language's `TypeError` for a value
     * with no `[[Construct]]`, and the object it returns is read by the
     * census's own reader (`constructedResult`, nodes.ts). Only a frame with
     * no receiver and no rest slot is a construct frame `readWith` adapts, and
     * each argument only boxes out, as the callable adapter's do.
     */
    constructorValueDispatchMaterializer: (abi) => {
      if (abi.receiver !== null || abi.restFrom !== null || abi.argumentsFrame !== undefined || abi.overloadJoined) return null
      if (abi.result.kind === 'void' || !abi.parameters.every((parameter) => dynamicArgumentCarrierSupported(parameter.value, new Set())))
        return null
      const domain = `dynamic-constructor:${representationKey({ kind: 'constructor-value-dispatch', abi })}`
      return {
        classifier: { id: 'gea::Value::tag', domain },
        // An adapted read shares one environment per Function object, which is
        // a constructor's identity, so every read hands back the same one.
        materializer: {
          id: 'gea::detail::DynamicCarrier::readWith',
          domain,
          allocates: true,
          callableIdentityTransport: 'preserved',
          wrapperKind: 'dynamic-constructor-in'
        }
      }
    },
    functionMaterializer: (functionId, abi) => {
      if (!dynamicCallableReadAbiSupported(abi)) return null
      const domain = `dynamic-callable-identity:${functionId}:${representationKey({ kind: 'function', functionId, abi })}`
      return {
        classifier: { id: 'gea::Value::callableDeclarationIdentity', domain },
        materializer: {
          id: 'gea::detail::DynamicCarrier::in',
          domain,
          allocates: true,
          callableIdentityTransport: 'preserved',
          wrapperKind: 'dynamic-carrier-in'
        }
      }
    },
    /**
     * `null` out of a box: the exact sibling of `undefinedMaterializer` above,
     * and absent for as long as it was on a premise that was simply false.
     *
     * `conversion/derive.ts` asks this hook and, with nothing installed,
     * answers `never('the runtime does not distinguish null with an exact
     * tag')`. The runtime distinguishes it precisely: `Value::Tag::Null` is its
     * own enumerator, `dynamicTagFor` already WRITES it on the boxing side, and
     * `DynamicCarrier<std::nullptr_t>::accepts` already tests it. What was
     * missing was only the read.
     *
     * `null` has no PAYLOAD, which is not the same as having no VALUE -- its
     * carrier is `std::nullptr_t`, whose one inhabitant is `nullptr` -- so this
     * is the identical verify-then-produce `undefined` gets, never a payload
     * load. `gea::detail::unboxNullValue`.
     *
     * The cost of its absence was not one conversion: `deriveTaggedUnion`
     * derives one arm at a time and a single `never` arm makes the whole sum
     * `never`, so EVERY nullable tagged-union read out of a box was refused.
     */
    nullMaterializer: () => ({
      classifier: { id: 'gea::Value::tag', domain: 'tag:Null' },
      materializer: { id: 'gea::detail::unboxNullValue', domain: 'tag:Null', allocates: false }
    }),
    /**
     * `gea::Optional<T>` records only presence/absence, with no memory of which
     * JavaScript absent value a caller meant -- so the runtime TAG that marks a
     * dynamic value's own absence is the only place that fact still lives, and
     * this backend already writes `Tag::Null`/`Tag::Undefined` for exactly those
     * two on the boxing side (`dynamicTagFor`). Reading the two spellings apart
     * is just naming that same pair back for the unboxing side.
     */
    optionalAbsenceTag: (absence) => (absence === 'null' ? 'gea::Value::Tag::Null' : 'gea::Value::Tag::Undefined'),
    /**
     * Reading a class instance back out of a box, discriminated by the payload's
     * own recorded C++ type rather than by its tag.
     *
     * The tag cannot do this job, and the header above overstates the case by
     * concluding from that that the box cannot do it at all. Both the limit and
     * the overstatement are specific: `Tag::Object` is shared by a record, a
     * class instance, an array and a host handle (`dynamicTagFor`), so a
     * `tag:Object` domain would not be disjoint across those four and `as<T>()`
     * over it would be a `static_pointer_cast` to whichever type the reader
     * happened to name. What actually discriminates is `payloadType()`:
     * `Value::box` records `payloadTypeTagFor<std::decay_t<T>>()` for EVERY
     * payload it stores -- one program-wide address per C++ type, `typeid`
     * without RTTI -- and `gea::detail::unboxAs` compares the tag AND that
     * address, refusing by name when either disagrees. That is a real classifier
     * over a really-stored fact, which is why the domain below is keyed on the
     * class identity and not on the tag.
     *
     * Both halves of the round trip were already built and only this entry was
     * missing: `dynamicTagFor` boxes `class-ref`, and `unboxedLoadText` renders
     * `unboxValue<T>` for every tag except the three with no payload to read.
     * `dynamicTagFor`'s own comment writes this same argument out for
     * `typed-array`, which reached the identical conclusion by the identical
     * route.
     *
     * Only `shared-refcount` is installed. The other two are refused with a
     * reason rather than left for later, because for each of them the refusal is
     * the correct permanent answer as the runtime currently stands:
     *
     * - `borrowed` spells `Foo&` (`cppOwnershipWrap`), and `box` decays the
     *   reference away before recording the type, so `payloadTypeTagFor<Foo&>`
     *   cannot equal what any box holds. Installing it would emit a load that
     *   aborts on every execution rather than one that sometimes works.
     *   `narrowing` above refuses borrowed targets for a separate lifetime
     *   reason, and both reasons apply here.
     * - `owned` spells a bare `Foo`, which `unboxValue` reaches by
     *   copy-constructing from the `const Foo&` `unboxAs` hands back, while
     *   boxing the same value needs only a MOVE (`makeRef<std::decay_t<T>>`
     *   forwards). So the question is whether any emitted struct is
     *   copy-constructible, and that is decidable rather than speculative:
     *   `records.ts` writes no copy constructor and no assignment operator at
     *   all, so copyability is never a property of the class this compiler
     *   emits -- it is implicitly derived from the FIELD carriers. Surveying
     *   every emitted struct across the corpus gives a closed carrier
     *   vocabulary, and `is_copy_constructible_v` holds for all of the ones this
     *   header owns (`double`, `bool`, `long long`, `std::string`,
     *   `gea::Optional<T>`, `gea::TaggedUnion<...>`, `gea::Ref<T>`,
     *   `gea::Value`) and for a struct built from them.
     *
     *   What is still unproven is the HOST-owned carriers a struct can also hold
     *   -- `gea::apple::UIKit::*`, `embedded::ui::Signal<T>`, `NodeHandle`,
     *   `CanvasRenderingContext2D` -- which live in headers this survey did not
     *   reach. One move-only type among them is all it takes, and it would fail
     *   as a clang error inside a generated struct rather than at the entry that
     *   licensed it. So this stays refused until that half is checked too: a
     *   narrower reason than the one first written here, and the honest one.
     */
    classRefMaterializer: (declaration, ownership) => {
      if (ownership !== 'shared-refcount') return null
      // A class projection is authenticated by the allocation's emitted class
      // family, not by the static `Ref<T>` spelling the writer happened to box:
      // a Ref<Base> may carry a Derived allocation.  `unboxClassRef` checks the
      // same family table and retains the original allocation, so this domain is
      // intentionally nominal rather than a payload-type claim.
      const domain = `class-family:${declaration}:${ownership}`
      return {
        classifier: { id: 'gea::Value::classIdentity', domain },
        materializer: {
          id: 'gea::detail::unboxClassRef',
          domain,
          allocates: false,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved'
        }
      }
    },
    // The compiler's own opaque host carrier is `NativeHandle<protocol>`: its
    // generated tag is an authenticated, copyable host identity, and an exact
    // payload read preserves that handle (and therefore host sidecars) without
    // reconstructing a native object.  A plugin-provided C++ spelling may be a
    // value struct, an alias, or a handle; `nativeTypes` communicates only that
    // spelling, not that it is a dynamic identity carrier, so it stays refused
    // until the plugin publishes that stronger fact explicitly.
    nativeHandleMaterializer: (protocol, version, native) => {
      if (native !== null) return null
      const domain = `opaque-native-handle:${protocol}@${version}`
      return {
        classifier: { id: 'gea::Value::payloadType', domain },
        materializer: { id: 'gea::detail::unboxValue', domain, allocates: false, wrapperKind: 'unbox-payload' }
      }
    },
    // Compiler-owned records have a closed field census, so a dynamic object can
    // materialize one only by checking object-ness, every required key, and every
    // declared field. `emit-narrowing.ts` renders that recipe. A boxed record of
    // the exact target type is merely its identity-preserving fast path; it does
    // not replace this product capability with an identity-only conversion.
    recordMaterializer: (shapeId, ownership) => {
      if (ownership === 'borrowed') return null
      const domain = `record-product:${shapeId}:${ownership}`
      return {
        id: 'gea::detail::unboxDynamicRecord',
        domain,
        allocates: ownership === 'shared-refcount'
      }
    },
    /**
     * Reading a record -- compiler-owned layout or host-stated native type
     * alike -- back out of a box BY IDENTITY, the exact mirror of
     * `classRefMaterializer` immediately above and installed on the identical
     * evidence.
     *
     * `Value::box` records `payloadTypeTagFor<std::decay_t<T>>()` for whatever
     * C++ type it stores, so a `gea::Ref<gea_record_type_N>` or a
     * `gea::Ref<gea::runtime::Date>` this program boxed records that exact
     * address, and `gea::detail::unboxValue<T>` -- the same primitive
     * `classRefMaterializer` uses, which `emit-narrowing.ts`'s `unboxedLoadText`
     * already renders through its generic `dynamicTagFor(target)` fallback --
     * checks both the tag and that address before handing the payload back. No
     * emitter change: both halves of the round trip were already built.
     *
     * Handing back the SAME object rather than a rebuild is the point. The
     * Compiler-owned records use `recordMaterializer`'s checked product path;
     * native records do not publish fields this compiler can walk, so this exact
     * identity recovery is their only admissible dynamic conversion.
     *
     * `shared-refcount` only, for the two reasons `classRefMaterializer`'s own
     * doc states in full: `borrowed` spells `Foo&`, which `box` decays away
     * before recording the type, so no box can ever match it; and `owned`
     * spells a bare `Foo`, whose copy-constructibility across every HOST carrier
     * a struct can hold is unchecked. Both stay refused rather than emitting a
     * load that aborts.
     */
    /**
     * A carrier read back out of the box BY IDENTITY -- the same round trip
     * `recordRefMaterializer` performs for a named record shape, for the
     * carriers that have no shape id to key on.
     *
     * Gated on `dynamicTagFor` answering, which is the one authority for which
     * carriers this backend boxes at all, so a value can never be admitted here
     * under a tag the boxing direction does not write. Gated on
     * `shared-refcount` for the reasons `classRefMaterializer` states in full:
     * `borrowed` spells `Foo&`, which `box` decays away before recording the
     * type, and `owned` spells a bare `Foo` whose copy-constructibility is
     * unchecked.
     *
     * An accessor-bearing record cannot be reconstructed as a product: doing
     * so would discard its accessor environments or run user code during a
     * classifier. Its one admissible read is this authenticated payload
     * recovery, retaining the exact object and its getters. Plain records
     * keep their product entry; native records, classes and arrays keep their
     * existing dedicated entries.
     */
    boxedIdentityMaterializer: (target) => {
      const eligible =
        (target.kind === 'dictionary' ||
          target.kind === 'record-with-index' ||
          target.kind === 'typed-array' ||
          (target.kind === 'record' && target.accessors.length > 0)) &&
        target.ownership === 'shared-refcount'
      if (!eligible && target.kind !== 'array-buffer' && target.kind !== 'shared-array-buffer' && target.kind !== 'data-view') return null
      if (dynamicTagFor(target) === null) return null
      const domain = `boxed-identity:${representationKey(target)}`
      return {
        classifier: { id: 'gea::Value::payloadType', domain },
        materializer: {
          id: 'gea::detail::unboxValue',
          domain,
          allocates: false,
          wrapperKind: 'unbox-payload',
          ...((target.kind === 'typed-array' ||
            target.kind === 'array-buffer' ||
            target.kind === 'shared-array-buffer' ||
            target.kind === 'data-view') &&
          target.ownership === 'shared-refcount'
            ? { nativeFieldProtocol: 'unused' as const, nativePayloadTransport: 'preserved' as const }
            : {}),
          ...(target.kind === 'record' && target.accessors.length > 0
            ? {
                nativeAccessorPayload: 'preserved' as const,
                nativeFieldProtocol: 'unused' as const,
                nativePayloadTransport: 'preserved' as const
              }
            : {})
        }
      }
    },
    dynamicPromiseAdoptionMaterializer: (target) => {
      if (target.kind !== 'promise' || !isSpellable(target)) return null
      const domain = `dynamic-promise-adoption:${representationKey(target)}`
      return {
        classifier: { id: 'gea::detail::adoptBoxedPromise', domain },
        materializer: { id: 'gea::detail::promiseFromDynamic', domain, allocates: true, wrapperKind: 'promise-from-dynamic' }
      }
    },
    dynamicMapViewMaterializer: (target) => {
      if (target.kind !== 'keyed-collection' || target.family !== 'map' || target.ownership !== 'shared-refcount') return null
      if (target.recursive !== undefined || target.readOnlyView === true) return null
      if (target.key.kind !== 'dynamic' || target.value?.kind !== 'dynamic') return null
      const domain = `dynamic-map-view:${representationKey(target)}`
      return {
        classifier: { id: 'gea::Value::isMapPayload', domain },
        materializer: { id: 'gea::detail::unboxDynamicMap', domain, allocates: true }
      }
    },
    recordRefMaterializer: (shapeId, ownership) => {
      if (ownership !== 'shared-refcount') return null
      const domain = `record-payload:${shapeId}:${ownership}`
      return {
        classifier: { id: 'gea::Value::payloadType', domain },
        materializer: {
          id: 'gea::detail::unboxValue',
          domain,
          allocates: false,
          wrapperKind: 'unbox-payload',
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          ...((layouts.accessorsForShape(shapeId)?.length ?? 0) > 0 ? { nativeAccessorPayload: 'preserved' as const } : {})
        }
      }
    },
    /**
     * Reading a materializable ordinary Array back out of a box -- the
     * MATERIALIZING direction (a genuinely dynamic value becoming a native
     * shape at a point the program requires one), never the boxing shortcut:
     * see `classRefMaterializer`'s own doc comment immediately above for the
     * exact discipline this mirrors.
     *
     * `Value::box`'s payload-type recording is generic over EVERY C++ type it
     * stores (`payloadTypeTagFor<std::decay_t<T>>()`, see `classRefMaterializer`'s
     * comment), so `gea::ArrayObject<Element>` is not a special case for it --
     * an array literal boxed into `dynamic` elsewhere in the SAME program (the
     * mirror widening this same registry's `widening` entry below already
     * installs for any `array-object` source, via `dynamicTagFor`'s existing
     * `'array-object' -> 'Object'` case) records that exact address, and
     * `gea::detail::unboxValue<T>` -- the SAME primitive `classRefMaterializer`
     * uses, and the one `emit-narrowing.ts`'s `unboxedLoadText` ALREADY renders
     * for every non-tagged-union target via its generic `dynamicTagFor(target)`
     * + `unboxValue<cppTypeOf(target)>` fallback -- checks both the tag and
     * that address before handing the payload back. So this entry needs no
     * emitter change at all: both halves of the round trip were already built,
     * the exact shape `classRefMaterializer`'s own doc names as the reason it
     * was missing for as long as it was.
     *
     * `unboxValue<Ref<ArrayObject<Element>>>` hands back a REFERENCE-COUNTED
     * pointer to the SAME underlying `ArrayObject` the box recorded -- not a
     * reconstruction -- so both properties `deriveArrayObject` requires hold
     * honestly: identity is the original object, not a copy, and every hole
     * `ArrayObject`'s own presence-bit storage tracked survives untouched,
     * because nothing about it was rebuilt.
     *
     * Restricted to `shared-refcount` for the identical reason
     * `classRefMaterializer` restricts to it: a `borrowed` target has no
     * lifetime a materialized value can honestly hold (`narrowing` above
     * refuses borrowed targets for the same reason), and `owned`'s
     * copy-constructibility across every carrier this backend can select as an
     * array element is unproven the same way it is for a class instance's own
     * fields -- narrower than a blanket refusal, and the honest boundary of
     * what has actually been checked.
     */
    arrayObjectDomain: (ownership): CollectionDomain | null => {
      if (ownership !== 'shared-refcount') return null
      return {
        classifier: { id: 'gea::Value::payloadType', domain: `array-payload:${ownership}` },
        excluded: [],
        preservesHoles: true,
        preservesIdentity: true
      }
    },
    // The sum classifier is the emitter's actual condition: one exact tag and
    // payload type, or an authenticated program-class family. A nested arm has
    // several possible conditions and this algebra has no disjunctive classifier
    // contract, so it remains explicitly refused rather than smuggling a
    // checker-only semantic type into a fake runtime domain.
    taggedUnionArmClassifier: cppTaggedUnionArmClassifier,
    narrowing: (source: Representation, target: Representation) => {
      // An open Document accepts every native object arm. Its live alias
      // recipe must run before an exact-tag subset drops those objects.
      if (isOpenDocument(target) && documentViewable(source)) return null
      // Presence loads and native class casts below inspect tags/allocation
      // identity, never a property's reflection protocol. State that on the
      // installed materializer, where the implementation is known; the IR
      // census must not reconstruct it from a helper name or a carrier kind.
      // General union selections remain unannotated because their renderer can
      // adapt a compatible arm through another conversion.
      // A target the backend cannot spell has no load: there is no C++ type for
      // it to produce. Asking the one authoritative type mapping keeps this from
      // becoming a second opinion about what is spellable.
      if (!isSpellable(target)) return null
      // A borrowed target is refused, and not for lack of syntax. `gea::Optional`
      // and `gea::TaggedUnion` both own their contents, so the reference a load
      // would hand back points into the cell -- which outlives nothing the caller
      // can see, and whose lifetime the program never stated.
      if ('ownership' in target && target.ownership === 'borrowed') return null
      if (classArmWithoutHome(layouts, source, target)) return null
      if (proxyArmWithoutHome(source, target)) return null
      const setPair = genericFunctionSetPair(source, target)
      if (setPair) return setPair
      // The payload read as the array-extending interface it also is
      // (`sameArrayUpToExtension`): the presence proof is the same and the load
      // is the same, since both carriers are one C++ type.
      if (
        source.kind === 'optional' &&
        (representationKey(source.payload) === representationKey(target) || sameArrayUpToExtension(source.payload, target))
      ) {
        return {
          classifier: { id: 'gea::Optional::has_value', domain: 'present-optional' },
          materializer: {
            id: 'gea::Optional::operator*',
            domain: 'present-optional',
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // The mirror of the presence narrowing directly above: the guard proved the
      // cell ABSENT, and the read carries the absent value's own carrier. There is
      // nothing in the cell to load -- `null`'s carrier is `std::nullptr_t` and
      // `undefined`'s is `gea::Undefined`, and each has exactly one inhabitant --
      // so the materializer produces that constant. Gated on the two absences
      // AGREEING: an `optional(T,undefined)` narrowed by `x === null` is not this
      // pair, and the checker would not have produced it.
      if (source.kind === 'optional' && target.kind === source.absence) {
        return {
          classifier: { id: 'gea::Optional::has_value', domain: `absent-optional:${source.absence}` },
          materializer: {
            id: 'gea::constant',
            domain: `absent-optional:${source.absence}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // The same absent read of a cell whose own carrier encodes absence: a
      // shared class reference IS `C | null` (a null `shared_ptr`), so `let x:
      // C | null = null` read where the guard proved it holds nothing -- the
      // flow type is `null` -- answers the constant, exactly as the optional
      // pair above does.
      if (source.kind === 'class-ref' && source.ownership === 'shared-refcount' && target.kind === 'null') {
        return {
          classifier: { id: 'gea::Optional::has_value', domain: 'absent-class-ref:null' },
          materializer: { id: 'gea::constant', domain: 'absent-class-ref:null', allocates: false, nativeFieldProtocol: 'unused' }
        }
      }
      // A structural value read as an instance of a class nothing can
      // instantiate. No such instance exists, so a guard that narrowed to it --
      // `incoming instanceof Http2ServerRequest` -- never passes, and the
      // instance-test census renders that guard only when it proved the view
      // cannot hold one (`projection/instance-test.ts`). The load is the branch's
      // own unreachability, never a value.
      if (
        target.kind === 'class-ref' &&
        layouts.classUninstantiable?.(target.declaration) === true &&
        (source.kind === 'record' ||
          source.kind === 'record-with-index' ||
          source.kind === 'dictionary' ||
          (source.kind === 'native-record-ref' && source.native === null))
      ) {
        const domain = `uninstantiable-class:${representationKey(target)}`
        return {
          classifier: { id: 'gea::host::neverInstance', domain },
          materializer: {
            id: 'gea::host::unreachableValue',
            domain,
            allocates: false,
            nativeFieldProtocol: 'unused',
            normalCompletion: 'never'
          }
        }
      }
      // A shared structural view read as a class, under the `instanceof` that
      // proved it was built from one: the view remembers its origin
      // (`gea::record::viewOrigin`) and authenticates that native allocation's
      // class layout. An optional view is the same read of its
      // payload, which the test proved present.
      // An open `any` document may view an instance too (`classDocumentViewText`).
      const sharedView = (value: Representation): boolean =>
        ((value.kind === 'record' || value.kind === 'record-with-index' || (value.kind === 'native-record-ref' && value.native === null)) &&
          value.ownership === 'shared-refcount') ||
        isOpenDocument(value)
      if (
        target.kind === 'class-ref' &&
        target.ownership === 'shared-refcount' &&
        (sharedView(source) || (source.kind === 'optional' && sharedView(source.payload)))
      ) {
        const domain = `view-origin:${representationKey(target)}`
        return {
          classifier: { id: 'gea::record::viewOriginIs', domain },
          materializer: {
            id: 'gea::record::viewOrigin',
            domain,
            allocates: false,
            nativeFieldProtocol: 'unused',
            requiresSourceGuard: true,
            executesSourceGuard: true
          }
        }
      }
      // A base class-ref read at a descendant -- see `downcastsToDerived` above.
      // `downcastClassRef` (gea_runtime.h) is `Ref::staticCast`, which adopts
      // `static_cast<Derived*>` of the SAME pointee: the payload travels as the
      // object it already was, so payload transport is preserved as well.
      if (downcastsToDerived(source, target)) {
        return {
          classifier: { id: 'gea::host::hasNativeClassLayoutRef', domain: `class-descendant:${representationKey(target)}` },
          materializer: {
            id: 'gea::host::downcastClassRef',
            domain: `class-descendant:${representationKey(target)}`,
            allocates: false,
            requiresSourceGuard: true,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // The same handle read at a UNION of descendants -- `object instanceof A
      // || object instanceof B || object instanceof C`. The physical
      // carrier stays one `Ref<Base>`; allocation identity is the discriminant,
      // so the classifier is the same family test and the materializer the same
      // checked downcast, applied per arm by `emit-narrowing.ts`'s
      // `classFamilyLoadText`. `conversion/build.ts` owns the predicate and this
      // imports it, so the pair this admits is exactly the pair that proposed it.
      if (narrowsToDescendantClassUnion(source, target)) {
        return {
          classifier: { id: 'gea::host::hasNativeClassLayoutRef', domain: `class-descendant-union:${representationKey(target)}` },
          materializer: {
            id: 'gea::host::downcastClassRef',
            domain: `class-descendant-union:${representationKey(target)}`,
            allocates: false,
            requiresSourceGuard: true,
            nativeFieldProtocol: 'unused',
            // Each arm is `ofArm<I>(downcastClassRef<D>(held))`: one pointee,
            // injected into the target union (and its optional, if any).
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // The census asks this table before widening. A total native transfer
      // must therefore win here too; otherwise the broad subset fallback below
      // can shadow its selected recipe and lose its payload identity contract.
      const nativeSelection =
        nativeTotalSelectionRecipeOf(source, target) ??
        ((source.kind === 'optional' || source.kind === 'tagged-union') && narrowingReachesTarget(source, target)
          ? nativeSelectionRecipeOf(source, target)
          : null)
      if (nativeSelection) return nativeSelectionConversion(source, target, nativeSelection)
      if (
        (source.kind === 'optional' || source.kind === 'tagged-union') &&
        target.kind === 'class-ref' &&
        narrowingReachesTarget(source, target)
      ) {
        return {
          classifier: { id: 'gea::host::hasNativeClassLayoutRef', domain: `class-descendant-sum:${representationKey(target)}` },
          materializer: {
            id: 'gea::host::downcastClassRef',
            domain: `class-descendant-sum:${representationKey(target)}`,
            allocates: false,
            requiresSourceGuard: true,
            // Presence and sum selection over native class handles never reads
            // field values. Mixed sums retain their general converting protocol.
            // A mixed sum (`Error | CustomError` narrowed by `instanceof`) composes
            // its leaves' contracts, as the exact-arm narrowing below does.
            ...(nativeClassPresence(source)
              ? { nativeFieldProtocol: 'unused' as const, ...nativeClassReferenceIdentityOf(source, target) }
              : nativeNarrowing(source, target))
          }
        }
      }
      // Selecting one arm of a union, either directly or through an optional the
      // same narrowing also proved present. `gea::TaggedUnion::is<Index>` is the
      // discriminant test and `get<Index>` is the load, and both are indexed by
      // the arm's position in `representation.arms` -- the checker's own order,
      // which is what the emitter already uses to build one.
      //
      // More than one arm may carry the target's C++ type: `A | B | C` where all
      // three lower to `std::string` is one narrowing target with three possible
      // live arms. That is a fact about the load -- it dispatches on which arm is
      // live -- not about whether the capability exists, so it does not change
      // the answer here.
      //
      // The target may itself still be an optional: narrowing `A | B | undefined`
      // to `A | undefined` rules out an arm and proves nothing about presence, so
      // both sides unwrap before the arms are compared and the load rebuilds the
      // optional around whichever arm it read.
      const union = source.kind === 'optional' ? source.payload : source
      const selected = source.kind === 'optional' && target.kind === 'optional' ? target.payload : target
      if (union.kind !== 'tagged-union') return null
      // A record-shaped target some OTHER arm reaches only through the
      // structural view is not a selection: that arm is live at a store, and a
      // selection would read it as the exact arm. The view's `dispatch` plan
      // (`conversion/record-view.ts`) is the conversion, installed by
      // `staticRecipe` below once this table declines -- the same plan
      // `emit-narrowing.ts`'s `narrowedLoadText` defers to, asked here so the
      // admission and the render agree.
      if (isRecordViewTarget(selected)) {
        const view = viewPlanFor(layouts, source, target)
        if (view !== null && recordViewDispatchesArms(view)) return null
      }
      const targetKey = representationKey(selected)
      // A SUB-union target: `selected` is still a tagged union, just missing one
      // or more of `union`'s arms -- `h instanceof Headers`'s `else` branch
      // leaving a `Headers | Record<string,string> | [string,string][]` cell
      // narrowed to the latter two. Installed exactly when every one of
      // `selected`'s own arms has a same-shaped home among `union`'s -- the
      // identical admission `emit-narrowing.ts`'s `narrowedUnionSubsetText`
      // checks before it renders the `ofArm<Index>` rebuild, asked here rather
      // than restated so the two cannot disagree about which pairs install.
      if (selected.kind === 'tagged-union') {
        const installed = selected.arms.every((arm) =>
          union.arms.some(
            (candidate) =>
              representationKey(candidate.value) === representationKey(arm.value) ||
              narrowingReachesTarget(candidate.value, arm.value) ||
              downcastsToDerived(candidate.value, arm.value)
          )
        )
        if (!installed) return null
        const selection = nativeSubsetSelectionRecipeOf(source, target)
        if (selection) return nativeSelectionConversion(source, target, selection)
        return {
          classifier: { id: 'gea::TaggedUnion::is', domain: `live-arm-subset:${targetKey}` },
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain: `live-arm-subset:${targetKey}`,
            allocates: false,
            // The discriminant selects; each candidate leaf's own contract says
            // whether the selected payload travels natively.
            ...nativeNarrowing(source, target)
          }
        }
      }
      // The same admitted tag selection can load one exact opaque record arm.
      // It rejects every omitted tag; composing a possible structural rebuild
      // from those tags would lose the selected allocation's storage identity.
      // Only a structural target can be reached by a rebuild of another arm; a
      // guard-proven load of any other arm keeps the unchecked `get<k>()`
      // below, and an `as` assertion takes `assertedUnionFor`'s checked
      // projection instead.
      const exactSelection =
        isRecordViewTarget(selected) || selected.kind === 'record-with-index' || selected.kind === 'dictionary'
          ? nativeSubsetSelectionRecipeOf(source, target)
          : null
      if (exactSelection) return nativeSelectionConversion(source, target, exactSelection)
      // A target OPTIONAL whose payload is one of the union's arms, where the
      // union carries no bare absent arm at all -- absence living inside another
      // arm's own optional. `emit-narrowing.ts`'s `narrowedLoadText` renders the
      // arm test as the presence test; this installs the capability it needs.
      if (target.kind === 'optional' && union.arms.some((arm) => representationKey(arm.value) === representationKey(target.payload))) {
        return {
          classifier: { id: 'gea::TaggedUnion::is', domain: `live-arm-optional:${targetKey}` },
          materializer: {
            id: 'gea::TaggedUnion::get',
            domain: `live-arm-optional:${targetKey}`,
            allocates: false,
            armSelection: 'guarded-load',
            ...nativeNarrowing(source, target)
          }
        }
      }
      if (!union.arms.some((arm) => representationKey(arm.value) === targetKey)) {
        // An arm the target lives INSIDE, not one that equals it. A narrowing
        // does not stop at the top level: a `?(string|number|boolean)`
        // field is `undefined | null | (string|number|boolean)`, and a guard past
        // the two absences lands on one of the inner arms -- two steps, and this
        // test saw only one. `narrowingReachesTarget` (`conversion/build.ts`) is
        // the same enumeration that PROPOSED this pair, asked here rather than
        // restated so the admission cannot admit fewer levels than the graph
        // offers, and `emit-narrowing.ts`'s `taggedUnionArmText` recurses through
        // `narrowedLoadText` to render exactly the step this admits.
        if (!narrowingReachesTarget(source, target)) return null
        return {
          classifier: { id: 'gea::TaggedUnion::is', domain: `live-arm-nested:${targetKey}` },
          materializer: {
            id: 'gea::TaggedUnion::get',
            domain: `live-arm-nested:${targetKey}`,
            allocates: false,
            armSelection: 'guarded-load',
            ...nativeNarrowing(source, target)
          }
        }
      }
      return {
        classifier: { id: 'gea::TaggedUnion::is', domain: `live-arm:${targetKey}` },
        materializer: {
          id: 'gea::TaggedUnion::get',
          domain: `live-arm:${targetKey}`,
          allocates: false,
          armSelection: 'guarded-load',
          ...nativeNarrowing(source, target)
        }
      }
    },
    // The mirror of `narrowing`: a plain value taking the place of the tagged
    // union (or the union payload of an optional) that declares it as one arm --
    // or, when the target is an optional and the source is exactly its bare
    // payload, no union at all, because `gea::Optional<T>` declares its own
    // converting constructor from `T`. `gea::TaggedUnion::ofArm<Index>` is a
    // real constructor -- built, not assumed -- so the union case is installed
    // exactly when the source's carrier is one of the target union's arms,
    // indexed the same way the emitter already reads one back
    // (`representation.arms`'s own order).
    widening: (source: Representation, target: Representation) => {
      if (!isSpellable(target)) return null
      const nativeAbsence = nativeReferenceAbsenceOf(source, target)
      if (nativeAbsence !== null)
        return {
          classifier: { id: NATIVE_REFERENCE_ABSENCE, domain: `absence:${nativeAbsence}` },
          materializer: {
            id: NATIVE_REFERENCE_ABSENCE,
            domain: `absence:${nativeAbsence}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      const nativeSum = nativeSumConversion(source, target)
      if (nativeSum) return nativeSum
      const totalSelection = nativeTotalSelectionRecipeOf(source, target)
      if (totalSelection) return nativeSelectionConversion(source, target, totalSelection)
      const setPair = genericFunctionSetPair(source, target)
      if (setPair) return setPair
      const exactDispatch = exactFunctionDispatchPair(source, target)
      if (exactDispatch) return exactDispatch
      const identity = callableIdentityPair(source, target)
      if (identity) return identity
      const constructEntry = callableConstructEntryPair(source, target)
      if (constructEntry) return constructEntry
      // `Function` promises only callability, so crossing into an evaluated
      // callable slot needs the same checked ABI adapter as the generic dynamic
      // materializer above. This pair is proposed explicitly by
      // `wideningSourcesOf`: dynamic provenance is part of a representation's
      // key, and the generic node is intentionally keyed to declared `any`.
      if (
        source.kind === 'dynamic' &&
        source.reason === 'untyped-callable' &&
        target.kind === 'function-value-dispatch' &&
        dynamicCallableReadAbiSupported(target.abi)
      ) {
        return dynamicCallablePair(target)
      }
      // A callable declaring a type-matching PREFIX of the target's own
      // parameters widening into it -- `gea::CallableObject`'s own converting
      // constructor (`gea_runtime.h`) performs this, so the pairing this
      // capability approves is exactly the one `dropsUnboundParameters` (the
      // same authority `emit-narrowing.ts`'s renderer asks) proves sound. Asked
      // before the `dynamic`/absence/optional cases below because a callable
      // pair can never satisfy any of those (`callableObjectAbi` inside
      // `dropsUnboundParameters` answers `null` for anything that is not a
      // `function`/`function-family`/`function-value-family`/
      // `function-value-dispatch`), so ordering only ever skips work, never
      // changes an answer.
      if (constructorUpcastMember(source, target) !== null || constructorFamilyUpcastMembers(source, target) !== null) {
        const domain = `constructor-upcast:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: 'gea::upcastConstructor', domain },
          materializer: { id: 'gea::upcastConstructor', domain, allocates: false }
        }
      }
      // A class stored into a construct-signature slot with its own convention:
      // the environment (and so the constructor's identity) is kept and only the
      // construct entry is adapted -- see `emit-narrowing.ts`'s
      // `constructorDispatchAdapterText`, asked here so the two cannot disagree.
      if (adaptsConstructorIntoDispatch(source, target)) {
        const domain = `constructor-dispatch-adapter:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: 'gea::ConstructorObject::adapter', domain },
          materializer: { id: 'gea::ConstructorObject::adapter', domain, allocates: false }
        }
      }
      if (upcastsToBase(source, target)) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        return {
          classifier: { id: 'gea::Ref::converting-ctor', domain: `class-upcast:${sourceKey}->${targetKey}` },
          materializer: {
            id: 'gea::Ref::converting-ctor',
            domain: `class-upcast:${sourceKey}->${targetKey}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            // `Ref<Base>(derived)` retains the same pointee.
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      if (dropsUnboundParameters(source, target)) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        return {
          classifier: { id: 'gea::CallableObject::converting-ctor', domain: `callable-prefix:${sourceKey}->${targetKey}` },
          materializer: {
            id: 'gea::CallableObject::converting-ctor',
            domain: `callable-prefix:${sourceKey}->${targetKey}`,
            allocates: true,
            ...nativeCallableTransport(source, target)
          }
        }
      }
      // The composed sibling of the pairing just above: a zero-parameter
      // callable widening into a slot that ALSO widens its result into one arm
      // of a tagged union -- `gea_runtime.h`'s `ResultWidensIntoArm` performs
      // both steps as one converting constructor, asked here through
      // `dropsAllParametersIntoResultArm` for the identical reason
      // `dropsUnboundParameters` is asked above it, so the two authorities
      // cannot disagree about which pairs the runtime actually accepts.
      if (dropsAllParametersIntoResultArm(source, target)) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        return {
          classifier: { id: 'gea::CallableObject::result-arm-ctor', domain: `callable-result-arm:${sourceKey}->${targetKey}` },
          materializer: {
            id: 'gea::CallableObject::result-arm-ctor',
            domain: `callable-result-arm:${sourceKey}->${targetKey}`,
            allocates: true,
            ...nativeCallableTransport(source, target)
          }
        }
      }
      // The same widening at a nonzero arity the source already declares in
      // full -- `gea_runtime.h`'s `widenResultIntoArm` constructor, gated by the
      // very same `ResultWidensIntoArm` trait as the composed case above.
      // Installed here for the identical reason its two siblings are: the
      // conversion graph decides admissibility, and a pairing the emitter
      // renders but the graph never heard of is refused at certification for a
      // conversion this backend can already perform.
      if (widensResultIntoArm(source, target)) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        return {
          classifier: {
            id: 'gea::CallableObject::same-arity-result-arm-ctor',
            domain: `callable-result-arm-fixed:${sourceKey}->${targetKey}`
          },
          materializer: {
            id: 'gea::CallableObject::same-arity-result-arm-ctor',
            domain: `callable-result-arm-fixed:${sourceKey}->${targetKey}`,
            allocates: true,
            ...nativeCallableTransport(source, target)
          }
        }
      }
      // The rest slot rebased to position 0 -- `gea_runtime.h`'s
      // `spreadRestOverLeading` constructor, gated by the very same
      // `RestRebaseAdmits` trait. Installed here for the identical reason its
      // siblings are: a pairing the emitter renders but the graph never heard
      // of is refused at certification for a conversion this backend performs.
      if (rebasesRestOverLeadingParameters(source, target)) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        return {
          classifier: { id: 'gea::CallableObject::rest-rebase-ctor', domain: `callable-rest-rebase:${sourceKey}->${targetKey}` },
          materializer: {
            id: 'gea::CallableObject::rest-rebase-ctor',
            domain: `callable-rest-rebase:${sourceKey}->${targetKey}`,
            allocates: true
          }
        }
      }
      // A fifth pair, and the one that is not a constructor at all: same frame,
      // a result no `CallableObject` constructor can convert because converting
      // it means BOXING, and the tag table lives in the emitter. Rendered as a
      // captureless-lambda adapter at the conversion site
      // (`emit-narrowing.ts`'s `resultAdapterOf`); named here so the graph
      // states the capability rather than leaving the pair to be licensed by
      // accident and refused at emission -- which is exactly what happened
      // before this entry existed, the inverse of the usual gap.
      //
      // Asked AFTER the four above and never before: every pair one of them
      // accepts is an implicit conversion with no allocation of its own, and
      // an adapter for such a pair would make an identity store allocate.
      const resultAdapter = resultAdapterTransportOf(source, target)
      if (resultAdapter !== null) {
        const sourceKey = representationKey(source)
        const targetKey = representationKey(target)
        const domain = `callable-result-adapter:${sourceKey}->${targetKey}`
        const callableAdapter = resultAdapter.nativeConventions
        return {
          classifier: { id: 'gea::CallableObject::result-adapter', domain },
          materializer: {
            id: 'gea::CallableObject::result-adapter',
            domain,
            allocates: true,
            // `resultAdaptedCallableText` renders every such adapter through
            // `CallableObject::adaptSource`, which shares the source's Function
            // identity whether or not the entry boxes: identity is a fact of
            // the renderer, not of the native field protocol.
            ...(callableAdapter === null
              ? { callableIdentityTransport: 'preserved' as const }
              : { nativeFieldProtocol: 'unused' as const, callableAdapter, callableIdentityTransport: 'preserved' as const })
          }
        }
      }
      // Boxing into `dynamic`: the one widening direction whose *target*
      // carries no structural information about which sources are valid at
      // all (a tagged union's arms are a fixed list; `gea::Value` accepts
      // anything `dynamicTagFor` recognizes). `emit-narrowing.ts`'s
      // `widenedStoreText` already renders exactly this store; asking the
      // identical function here is what lets the conversion graph -- built
      // structurally from `target`'s own shape everywhere else -- offer this
      // one capability too, rather than leaving every merge whose carrier is
      // `dynamic` refused for a conversion emission can already perform.
      if (target.kind === 'dynamic') {
        // An optional value has no single tag of its own -- see this
        // function's sibling render, `emit-narrowing.ts`'s `widenedStoreText`,
        // whose `held.kind === 'dynamic'` branch already renders exactly this
        // recursively: absence boxes to `Null`/`Undefined`, presence boxes
        // whatever the payload itself boxes as (which may in turn be a tagged
        // union, the case just below). This installs the capability that
        // render already implements; without it, every optional value merging
        // or returning into a declared-`any`/`unknown` carrier refused for a
        // conversion `emitConvert` could already perform.
        if (source.kind === 'optional') {
          const payload = source.payload
          if (!boxable(payload)) return null
          return {
            classifier: { id: 'gea::Value::box', domain: `box:optional:${representationKey(payload)}` },
            materializer: { id: 'gea::Value::box', domain: `box:optional:${representationKey(payload)}`, allocates: true }
          }
        }
        // A tagged union is the other sum carrier, and it boxes on exactly the
        // condition the optional case above already states for its payload:
        // every arm boxes. `dynamicTagFor` cannot answer for the union itself --
        // a sum has no single tag, which is the whole point of it -- but each
        // arm has one, and `widenedStoreText` already renders the per-arm store
        // recursively. Without this the identical value refused one level out
        // from where it was admitted: `optional(tagged-union(A|B))` boxed and a
        // bare `tagged-union(A|B)` did not.
        if (source.kind === 'tagged-union') {
          if (!boxable(source)) return null
          return {
            classifier: { id: 'gea::Value::box', domain: `box:sum:${representationKey(source)}` },
            materializer: { id: 'gea::Value::box', domain: `box:sum:${representationKey(source)}`, allocates: true }
          }
        }
        const tag = dynamicTagFor(source)
        if (tag === null) return null
        // Absence constructs only the dynamic tag; there is no native payload
        // to allocate, inspect or publish. In particular, an omitted any formal
        // must not turn an otherwise known constructor into an external entry.
        const absent = source.kind === 'undefined' || source.kind === 'null'
        return {
          classifier: { id: 'gea::Value::box', domain: `box:${tag}` },
          materializer: {
            id: 'gea::Value::box',
            domain: `box:${tag}`,
            allocates: !absent,
            ...(['scalar', 'string', 'symbol', 'null', 'undefined'].includes(source.kind)
              ? { primitiveIdentityTransport: 'preserved' as const }
              : {}),
            ...(callableObjectAbi(source) === null ? {} : { callableIdentityTransport: 'preserved' as const }),
            ...(absent ? { nativeFieldProtocol: 'unused' as const } : {})
          }
        }
      }
      // The bare absence marker -- `null`/`undefined` as its OWN static type,
      // not a literal appearing where a wider carrier is held -- widening into
      // an optional whose absence tag it matches: no payload conversion at
      // all, just the optional's own empty state. `emit-narrowing.ts`'s
      // `emptyOptionalText` already renders exactly this (`written.kind ===
      // held.absence` -> default-construct); this installs the capability
      // that render already implements. Gated to a matching tag on purpose --
      // `null` reaching an `undefined`-absent optional is a real semantic
      // mismatch `emptyOptionalText` itself refuses, not a spelling gap.
      if ((source.kind === 'null' || source.kind === 'undefined') && target.kind === 'optional' && source.kind === target.absence) {
        return {
          classifier: { id: 'gea::Optional::empty', domain: `absence:${target.absence}` },
          materializer: {
            id: 'gea::Optional::empty',
            domain: `absence:${target.absence}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // widenedStoreText already renders null as the empty state of a native
      // handle or refcounted class. Neither admits undefined without a flag.
      // The render is the default-constructed handle (`Ref<T>()`): no payload is
      // read or built, which is the payload-transport statement below.
      if (
        source.kind === 'null' &&
        (target.kind === 'native-handle' || (target.kind === 'class-ref' && target.ownership === 'shared-refcount'))
      ) {
        return {
          classifier: { id: 'empty-reference', domain: 'absence:null' },
          materializer: {
            id: 'empty-reference',
            domain: 'absence:null',
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // A source still wearing its own optional widens by reading its own
      // presence flag rather than assuming one -- `emit-narrowing.ts`'s
      // `widenedStoreText` is what actually renders that read, guarded by a
      // `has_value()` check when the target keeps an absence of its own and
      // unconditional (the checker having already proven presence) when it does
      // not. This only states the pairing is real: the payload widens exactly
      // as a bare source would, one optional layer down, so the domain is named
      // separately from the bare-payload case below to keep the two capability
      // pairs from being mistaken for one another.
      if (source.kind === 'optional') {
        const payloadKey = representationKey(source.payload)
        if (target.kind === 'optional' && representationKey(target.payload) === payloadKey) {
          return {
            classifier: { id: 'gea::Optional::converting-ctor', domain: `optional-payload:${payloadKey}` },
            materializer: {
              id: 'gea::Optional::converting-ctor',
              domain: `optional-payload:${payloadKey}`,
              allocates: false,
              nativeFieldProtocol: 'unused',
              ...nativeClassReferenceIdentityOf(source, target)
            }
          }
        }
        const wrappedUnion = target.kind === 'optional' ? target.payload : target
        if (wrappedUnion.kind !== 'tagged-union') return null
        if (!wrappedUnion.arms.some((arm) => representationKey(arm.value) === payloadKey)) return null
        return {
          classifier: { id: 'gea::TaggedUnion::ofArm', domain: `optional-arm:${payloadKey}` },
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain: `optional-arm:${payloadKey}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      const sourceKey = representationKey(source)
      // The bare payload widening straight into its own optional --
      // `gea::Optional<T>` declares a converting constructor from `T`, so this
      // needs no tagged union and no arm index at all.
      if (target.kind === 'optional' && representationKey(target.payload) === sourceKey) {
        return {
          classifier: { id: 'gea::Optional::converting-ctor', domain: `payload:${sourceKey}` },
          materializer: {
            id: 'gea::Optional::converting-ctor',
            domain: `payload:${sourceKey}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      // A source that is not the payload but reaches it by one of the four
      // `gea::CallableObject` converting constructors above. Every one of those
      // was installed only for a BARE callable target, so
      // `((gl, v) => void)` returned where `((gl, v, textures) => void) |
      // undefined` is expected -- a setter-selecting function with many returns
      // of exactly that shape -- refused for a pair whose two halves this backend
      // performs individually. The same four authorities are asked here, one
      // optional layer down, so the graph and the emitter cannot disagree about
      // which pairs the runtime accepts.
      //
      // `allocates` is true, unlike the bare-payload case: the emitter names
      // the payload type EXPLICITLY (`convertedValueText`'s optional branch)
      // because C++ allows one user-defined conversion per implicit sequence
      // and this pair needs two, so a `CallableObject` really is constructed
      // here rather than merely wrapped.
      if (target.kind === 'optional') {
        const payload = target.payload
        const nativeConstructor =
          dropsUnboundParameters(source, payload) ||
          dropsAllParametersIntoResultArm(source, payload) ||
          widensResultIntoArm(source, payload)
        const restRebase = !nativeConstructor && rebasesRestOverLeadingParameters(source, payload)
        const adapter = nativeConstructor || restRebase ? null : resultAdapterTransportOf(source, payload)
        if (nativeConstructor || restRebase || adapter !== null) {
          const domain = `payload-callable:${sourceKey}->${representationKey(payload)}`
          const native = nativeConstructor
            ? nativeCallableTransport(source, payload)
            : adapter?.nativeConventions
              ? {
                  nativeFieldProtocol: 'unused' as const,
                  callableAdapter: adapter.nativeConventions,
                  callableIdentityTransport: 'preserved' as const
                }
              : {}
          return {
            classifier: { id: 'gea::Optional::converting-ctor', domain },
            materializer: { id: 'gea::Optional::converting-ctor', domain, allocates: true, ...native }
          }
        }
      }
      if ((target.kind === 'optional' || target.kind === 'tagged-union') && hasSingleClassUpcastHome(source, target)) {
        const domain = `class-upcast-arm:${sourceKey}->${representationKey(target)}`
        return {
          classifier: { id: 'gea::TaggedUnion::ofArm', domain },
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain,
            allocates: false,
            nativeFieldProtocol: 'unused',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      const union = target.kind === 'optional' ? target.payload : target
      if (union.kind !== 'tagged-union') return null
      if (union.arms.some((arm) => representationKey(arm.value) === sourceKey)) {
        return {
          classifier: { id: 'gea::TaggedUnion::ofArm', domain: `arm:${sourceKey}` },
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain: `arm:${sourceKey}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            ...nativeClassReferenceIdentityOf(source, target)
          }
        }
      }
      return null
    },
    // Two tagged unions built from the same member set at different tag orders
    // -- one declared `boolean | number`, the other `number | boolean` -- need a
    // recast: every value the source can hold must have a same-typed home among
    // the target's arms, so the live one can always be rebuilt at the target's
    // own tag. A source arm with no match in the target is a real hole, not a
    // missing recipe, and is refused rather than dropped.
    recasting: (source: Representation, target: Representation) => {
      if (!isSpellable(target)) return null
      const setPair = genericFunctionSetPair(source, target)
      if (setPair) return setPair
      if (source.kind === 'native-record-ref' && source.native === cppStringObjectNativeType && target.kind === 'string') {
        const domain = `string-object-value:${representationKey(source)}`
        return {
          classifier: { id: 'gea::runtime::StringObject::value', domain },
          materializer: { id: 'gea::runtime::StringObject::value', domain, allocates: false }
        }
      }
      // The two void-payload guards that used to sit here now live inside
      // `promisePayloadConvertible`, which is the printer's own authority: a
      // `Promise<never>` source is admissible and a `Promise<void>` one is not,
      // and stating that twice is how the census and the printer drift apart.
      // A payload that only a structural record view carries adopts the same
      // way: `Promise.resolve({ value, done: false })` returned where
      // `Promise<IteratorResult<T>>` is declared reaches the yield arm's named
      // interface by the view, never by the ctx-free chain. `recipeText`
      // renders the pair from the identical plan.
      if (
        source.kind === 'promise' &&
        target.kind === 'promise' &&
        (promisePayloadConvertible(source.value, target.value) || viewPlanFor(layouts, source.value, target.value) !== null)
      ) {
        const domain = `promise-state-adoption:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: 'gea::Promise::state', domain },
          materializer: { id: 'gea::Promise::adopt-converted', domain, allocates: true }
        }
      }
      // A hand-written iterator object read as the cursor its declared type
      // names -- an object literal whose `[Symbol.asyncIterator]()` does
      // `return this` (`conversion/protocol-iterator.ts`), held by a field
      // declared `AsyncGenerator<T> | null`.
      const cursor = target.kind === 'optional' ? target.payload : target
      if ((cursor.kind === 'iterator' || cursor.kind === 'async-generator') && protocolIteratorPlanFor(layouts, source, cursor) !== null) {
        const domain = `protocol-iterator:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: PROTOCOL_ITERATOR, domain },
          materializer: { id: PROTOCOL_ITERATOR, domain, allocates: true }
        }
      }
      // The reverse: a native cursor read as the iterator OBJECT an interface
      // declares -- a subclass's `keys(): IterableIterator<K> { return
      // super.keys() as IterableIterator<K> }`
      // over a generator-backed `URLSearchParams.keys()`
      // (`conversion/iterator-object-view.ts`).
      // `x.constructor` stored where a constructor family is declared
      // (`conversion/constructor-identity-family.ts`).
      if (constructorIdentityFamilyPlan(layouts, source, target) !== null) {
        const domain = `constructor-identity-family:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: CONSTRUCTOR_IDENTITY_FAMILY, domain },
          materializer: { id: CONSTRUCTOR_IDENTITY_FAMILY, domain, allocates: false }
        }
      }
      // A constructor carried by its convention alone read as a class family --
      // a checked projection by the class evaluation's own declaration token.
      if (constructorDispatchFamilyPlan(layouts, source, target) !== null) {
        const domain = `constructor-dispatch-family:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: CONSTRUCTOR_DISPATCH_FAMILY, domain },
          materializer: { id: CONSTRUCTOR_DISPATCH_FAMILY, domain, allocates: false }
        }
      }
      const object = target.kind === 'optional' ? target.payload : target
      if (
        (source.kind === 'iterator' || source.kind === 'async-generator') &&
        iteratorObjectViewPlanFor(layouts, source, object) !== null
      ) {
        const domain = `iterator-object-view:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: ITERATOR_OBJECT_VIEW, domain },
          materializer: { id: ITERATOR_OBJECT_VIEW, domain, allocates: true }
        }
      }
      // An Array or Set read as the iterable object an interface declares --
      // `Readable.from(['a', 'b'])` into `Iterable<unknown>`
      // (`conversion/iterable-object-view.ts`).
      if (
        (source.kind === 'array-object' || source.kind === 'keyed-collection') &&
        iterableObjectViewPlanFor(layouts, source, object) !== null
      ) {
        const domain = `iterable-object-view:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: ITERABLE_OBJECT_VIEW, domain },
          materializer: { id: ITERABLE_OBJECT_VIEW, domain, allocates: true }
        }
      }
      if (source.kind === 'record' && target.kind === 'tagged-union' && ownedRecordMaterializationPlan(source, target, layouts) !== null) {
        const domain = `owned-record-arm:${representationKey(source)}->${representationKey(target)}`
        return {
          classifier: { id: 'gea::record::ownedArm', domain },
          materializer: { id: 'gea::record::ownedArm', domain, allocates: true }
        }
      }
      // Built on demand, never up front: this function is asked about EVERY
      // ordered pair of recastable carriers (`conversion/build.ts`), hundreds
      // of millions on a large program, and almost every pair leaves
      // through an early `null` without ever needing its key. Concatenating
      // it first was one string allocation per pair and a collector busy
      // reclaiming them -- the same cost `build.ts`'s own loop already paid once.
      let pairKeyMemo: string | null = null
      const pairKey = (): string => {
        pairKeyMemo ??= `${representationKey(source)}->${representationKey(target)}`
        return pairKeyMemo
      }
      if (
        source.kind === 'native-record-ref' &&
        target.kind === 'native-record-ref' &&
        source.native !== null &&
        source.native === target.native &&
        source.ownership === target.ownership &&
        samePhysicalCarrier(source, target)
      ) {
        return {
          classifier: { id: 'gea::native-record::identity', domain: `native-identity:${source.native}:${source.ownership}` },
          materializer: {
            id: 'gea::native-record::identity',
            domain: `native-identity:${source.native}:${source.ownership}`,
            allocates: false
          }
        }
      }
      const sum = nativeSumConversion(source, target)
      if (sum) return sum
      // Two boxes are one box. `dynamic`'s `reason` records WHY a value is
      // carried dynamically -- it is diagnostic provenance, not a physical
      // difference -- and `cppTypeOf` spells every one of them `gea::Value`. So
      // a store from one to another is the identity, and refusing it would
      // refuse an assignment C++ performs with no conversion at all.
      //
      // The pair became reachable when `untyped-callable` joined the reason list
      // (`representation/model.ts`): a `Function`-typed value flowing into a
      // cell that holds a declared `any` is two reasons over one carrier, and
      // before this the conversion graph had no node for it even though there
      // was nothing to convert.
      if (source.kind === 'dynamic' && target.kind === 'dynamic') {
        return {
          classifier: { id: 'gea::Value::identity', domain: `dynamic-reason:${pairKey()}` },
          materializer: { id: 'gea::Value::identity', domain: `dynamic-reason:${pairKey()}`, allocates: false }
        }
      }
      // The plain array and the array an interface extended with typed fields
      // (`List<T> extends ReadonlyArray<T>`, `array-object.extension`) are
      // ONE `gea::ArrayObject<E>`: the fields live in the object's own
      // extension sidecar, so `elements.slice() as MutableList<T>` is the
      // same object gaining fields on their first write, and a `List<T>`
      // handed to a `readonly T[]` parameter is that object read as the array
      // it is. Same element, same ownership, and only the extension differs;
      // the identity spelling `convertedValueText` already renders for two
      // carriers with one C++ type is what performs it.
      if (
        source.kind === 'array-object' &&
        target.kind === 'array-object' &&
        source.ownership === target.ownership &&
        representationKey(source.element) === representationKey(target.element) &&
        arrayExtensionKey(source.extension) !== arrayExtensionKey(target.extension)
      ) {
        return {
          classifier: { id: 'gea::ArrayObject::identity', domain: `array-extension:${pairKey()}` },
          // The extension is a typed native sidecar struct, never the field
          // protocol: the elements and the fields cross unchanged.
          materializer: {
            id: 'gea::ArrayObject::identity',
            domain: `array-extension:${pairKey()}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved'
          }
        }
      }
      // `never[]` into `E[]`: THE empty array of `E`, by identity. A shared
      // `emptyArray: never[]` is a sentinel a program can compare by identity
      // (storing it marks a state; `=== emptyArray` detects it), so a fresh `[]` is a silently
      // wrong answer and a boxed one a refusal; `gea::emptyArraySentinel<E>()`
      // is one object per element type, so every `never[]` that reaches an
      // `E[]` slot is the same one and compares equal to itself. The carrier
      // cannot tell `never[]` from `undefined[]` (an element with no storage is
      // stored as the absence), so the recipe admits only the pairs TypeScript
      // admits for `never[]` alone: an element that does not carry `undefined`
      // (a genuine `undefined[]` is not assignable to it) and, for `any[]`, a
      // runtime test -- empty is the sentinel, anything else is boxed element
      // by element, which is what a real `undefined[]` into `any[]` means.
      if (
        source.kind === 'array-object' &&
        target.kind === 'array-object' &&
        source.element.kind === 'undefined' &&
        source.ownership === 'shared-refcount' &&
        target.ownership === 'shared-refcount' &&
        (target.element.kind === 'dynamic' || !carriesUndefined(target.element))
      ) {
        return {
          classifier: { id: 'gea::emptyArraySentinel', domain: `empty-array:${pairKey()}` },
          materializer: { id: 'gea::emptyArraySentinel', domain: `empty-array:${pairKey()}`, allocates: false }
        }
      }
      // ⛔ NO CONVERSION IS INSTALLED between two `array-object` carriers whose
      // ELEMENTS disagree, and none may be. Such a conversion can only ALLOCATE
      // -- every element needs its own unbox -- and an `ArrayObject` a program
      // can still reach is a mutable reference, so a fresh array silently drops
      // every later write through the other name and loses identity outright.
      // `gea::ArrayObject::recastElements` did exactly that at a call argument
      // where two helpers pushed their values into the COPY, so every key the
      // caller built from the array came out identical and every cache lookup
      // keyed on it collided -- silently wrong output. A compile refusal is the correct outcome here, and the fix
      // for a disagreement is to make the two authorities agree -- which is
      // where `structural-array-element.ts`'s `unstatedNeverArray` parameter
      // form and `structural.ts`'s `refusedArrayParameterTypeAt` now put it.
      // See `test/runtime/array-object-call-argument-aliasing.ts`.
      // Two records declaring the SAME fields under two shape ids -- one written
      // as `Named & { age: number }`, the other as the literal that satisfies it
      // -- are one shape this backend spells as two structs, so a value of one is
      // rebuilt member-wise as the other. `emit-narrowing.ts`'s
      // `recastedRecordText` is what performs it; asking it here rather than
      // restating the admission rule keeps the census and the renderer from
      // disagreeing about which pairs are installed.
      // A `native-record-ref` target is the SAME question asked of a layout the
      // carrier only names: it holds a shape id, never a field list, so the pair
      // was never even proposed (`conversion/build.ts`'s `recastable` filter had
      // no reason to include a carrier nothing could compare). Resolving the
      // layout through the one policy and asking `recordsRecastable` the
      // identical question keeps this admission and the record-to-record one from
      // ever disagreeing. `emit-callable.ts`'s `structuralRecordViewText` is what
      // performs it -- the one place in the emitter both layouts are in hand --
      // reached from an argument slot and, since this pair became admissible,
      // from a return as well.
      const asRecord = (candidate: Representation): Representation => {
        if (candidate.kind !== 'native-record-ref' || candidate.native !== null) return candidate
        const fields = layouts.forShape(candidate.shapeId)
        if (fields === null) return candidate
        return { kind: 'record', shapeId: candidate.shapeId, ownership: candidate.ownership, fields, accessors: [] }
      }
      // A generated class written to a structural interface is materialized as
      // the native record view `emit-callable.ts` renders. Data fields are read
      // from the instance and methods become receiver-bound callable members.
      // Build the same effective source shape here so certification asks the
      // existing recursive record predicate about every field carrier before
      // the renderer sees the pair. The concrete source class supplies its own
      // method set, so interfaces with several implementors need no nominal or
      // sole-implementor shortcut.
      if (
        source.kind === 'class-ref' &&
        source.ownership === 'shared-refcount' &&
        (target.kind === 'native-record-ref' || target.kind === 'record') &&
        !(target.kind === 'native-record-ref' && target.native !== null)
      ) {
        const sourceFields = layouts.forShape(source.shapeId)
        const targetFields =
          target.kind === 'record'
            ? target.accessors.length === 0
              ? target.fields
              : null
            : (layouts.plainFieldsForShape?.(target.shapeId) ?? null)
        if (sourceFields !== null && targetFields !== null) {
          const projected = [...sourceFields]
          for (const field of targetFields) {
            if (!layouts.classMethodFor?.(source.declaration, field.key)) continue
            const abi = 'abi' in field.value ? field.value.abi : null
            if (abi === null || abi.receiver !== null || abi.restFrom !== null) continue
            const structuralIndex = projected.findIndex((candidate) => candidate.key === field.key)
            if (structuralIndex >= 0) projected.splice(structuralIndex, 1)
            projected.push({ key: field.key, value: field.value, required: true })
          }
          const sourceView = {
            kind: 'record' as const,
            shapeId: source.shapeId,
            ownership: source.ownership,
            fields: projected,
            accessors: []
          }
          const targetView = {
            kind: 'record' as const,
            shapeId: target.shapeId,
            ownership: target.ownership,
            fields: targetFields,
            accessors: []
          }
          if (recordsRecastable(sourceView, targetView)) {
            // The printer renders this atom as the chain's text when the chain
            // has one and otherwise as the structural view's plan
            // (`emit-narrowing.ts`'s `recipeText`). Where the plan is what
            // renders and it only copies held carriers or leaves members
            // absent, the view reads the instance's own native storage and
            // publishes nothing through its field protocol -- the same proof
            // `staticRecipe` states for `view:structural-record`. The origin
            // the view remembers boxed is read back only by `instanceof` and
            // by the `gea::record::viewOrigin` narrowing to the class, never by
            // program code that could write through it. Without it
            // the reflection census read an `emitter as unknown as
            // SomeMethodsInterface` cast as an unknown boundary, promoted every
            // emitter subclass and everything their fields reach to full
            // reflection, and refused each `this.method.bind(this)` in those
            // subclasses as `call-abi:bind-shadowable`.
            const plan = conversionRecipeOf(source, target)?.renders === true ? null : viewPlanFor(layouts, source, target)
            return {
              classifier: { id: 'gea::record::classStructuralView', domain: `class-view:${pairKey()}` },
              materializer: {
                id: 'gea::record::classStructuralView',
                domain: `class-view:${pairKey()}`,
                allocates: target.ownership === 'shared-refcount',
                ...(plan !== null ? viewProtocolOf(plan) : {})
              }
            }
          }
        }
      }
      // An EMPTY record -- what `[]` with no contextual array type derives, via
      // the empty tuple -- into a native array-like. Nothing is carried across
      // and nothing is lost: the source declares no field at all, and the target
      // is minted value-initialized, which is an array-like holding nothing.
      // `emit-narrowing.ts`'s `convertedValueText` renders it; installed here so
      // the merge that needs it is certified rather than emitted uncertified.
      // The same for an open record whose every declared field is optional:
      // `f(filter: Filter<T> = {})` defaults an all-optional parameter to the
      // empty literal, and the value-initialized struct IS that
      // object -- every presence bit off, an empty index sidecar.
      if (
        source.kind === 'record' &&
        source.fields.length === 0 &&
        source.accessors.length === 0 &&
        (target.kind === 'native-record-ref' || (target.kind === 'record-with-index' && target.fields.every((field) => !field.required)))
      ) {
        return {
          classifier: { id: 'gea::record::emptyNative', domain: `empty:${pairKey()}` },
          materializer: { id: 'gea::record::emptyNative', domain: `empty:${pairKey()}`, allocates: target.ownership === 'shared-refcount' }
        }
      }
      if (source.kind === 'record-with-index' && target.kind === 'native-record-ref' && target.native === null) {
        const targetFields = layouts.forShape(target.shapeId)
        const targetIndexes = layouts.indexesForShape(target.shapeId)
        const sourceFields = {
          kind: 'record',
          shapeId: source.shapeId,
          ownership: source.ownership,
          fields: source.fields,
          accessors: []
        } as const
        const targetFieldsView =
          targetFields === null
            ? null
            : ({ kind: 'record', shapeId: target.shapeId, ownership: target.ownership, fields: targetFields, accessors: [] } as const)
        if (
          targetFieldsView !== null &&
          targetIndexes.length === source.indexes.length &&
          targetIndexes.every((targetIndex, index) => {
            const sourceIndex = source.indexes[index]
            return (
              sourceIndex !== undefined &&
              targetIndex.key === sourceIndex.key &&
              representationKey(targetIndex.value) === representationKey(sourceIndex.value)
            )
          }) &&
          recordsRecastable(sourceFields, targetFieldsView)
        ) {
          return {
            classifier: { id: 'gea::record::recastWithIndex', domain: `recast-index:${pairKey()}` },
            materializer: {
              id: 'gea::record::recastWithIndex',
              domain: `recast-index:${pairKey()}`,
              allocates: target.ownership === 'shared-refcount'
            }
          }
        }
        // A closed named interface may receive an open record at runtime even
        // though the interface itself declares no index signature. TypeScript's
        // structural assignment permits that value, and JavaScript keeps the
        // extra own properties: `Object.assign(o, this.fields)` returned as a
        // closed interface still carries user fields that must enumerate and
        // serialize.
        //
        // The target does not need an inline index member. Every shared native
        // record already has the identity-keyed expando table implemented by
        // `nativeDynamicGet`/`Set` in the runtime. Admit only the sidecar carrier
        // that table stores exactly -- string keys and `gea::Value` payloads --
        // and only a data-only target layout. `emit-callable.ts` copies the
        // source sidecar into that expando table after rebuilding the named
        // fields, so no property is dropped and the typed target stays native.
        const plainTargetFields = layouts.plainFieldsForShape?.(target.shapeId) ?? null
        const plainTargetView =
          plainTargetFields === null
            ? null
            : ({ kind: 'record', shapeId: target.shapeId, ownership: target.ownership, fields: plainTargetFields, accessors: [] } as const)
        if (
          targetIndexes.length === 0 &&
          target.ownership === 'shared-refcount' &&
          source.indexes.length === 1 &&
          source.indexes[0]?.key === 'string' &&
          source.indexes[0]?.value.kind === 'dynamic' &&
          plainTargetView !== null &&
          recordsRecastable(sourceFields, plainTargetView)
        ) {
          return {
            classifier: { id: 'gea::record::recastWithExpando', domain: `recast-expando:${pairKey()}` },
            materializer: { id: 'gea::record::recastWithExpando', domain: `recast-expando:${pairKey()}`, allocates: true }
          }
        }
      }
      // A class viewed as a record of its own properties: a helper takes the
      // class itself as `{ tags?: Set<symbol> }` and writes a static, and an
      // instance method reads `(this.constructor as { tags?: Set<symbol> }).tags`.
      // The view is
      // the class evaluation's own record for the shape, so a write through one
      // view is every later view's read (`gea::constructorStaticView`).
      if (constructorStaticViewAdmitted(source, target, target.kind === 'native-record-ref' ? layouts.forShape(target.shapeId) : null)) {
        return {
          classifier: { id: CONSTRUCTOR_STATIC_VIEW, domain: `constructor-view:${pairKey()}` },
          materializer: { id: CONSTRUCTOR_STATIC_VIEW, domain: `constructor-view:${pairKey()}`, allocates: true }
        }
      }
      // The provisional layout pair is sealed into exact deferred field routes
      // by structuralRecipe; no shared document migration is rendered here.
      const named = target.kind === 'optional' ? target.payload : target
      // Lifted through an optional of the same absence: `items.find((o:
      // Document) => o.flag)` answers `Document | undefined` where a named
      // `Item | undefined` is carried.
      const document =
        source.kind === 'optional' && target.kind === 'optional' && source.absence === target.absence ? source.payload : source
      if (
        document.kind === 'dictionary' &&
        named.kind === 'native-record-ref' &&
        dynamicDictionaryToNamedRecordAdmitted(document, named, layouts.forShape(named.shapeId), layouts.indexesForShape(named.shapeId))
      ) {
        return {
          classifier: { id: DYNAMIC_DICTIONARY_TO_NAMED_RECORD, domain: `dictionary-record:${pairKey()}` },
          materializer: { id: DYNAMIC_DICTIONARY_TO_NAMED_RECORD, domain: `dictionary-record:${pairKey()}`, allocates: true }
        }
      }
      if ((source.kind === 'record' || source.kind === 'native-record-ref') && target.kind === 'native-record-ref') {
        const viewed = asRecord(source)
        const viewedTarget = asRecord(target)
        if (viewedTarget.kind !== 'record' || viewed.kind !== 'record') return null
        if (!recordsRecastable(viewed, viewedTarget)) return null
        return {
          classifier: { id: 'gea::record::recast', domain: `recast:${pairKey()}` },
          materializer: {
            id: 'gea::record::recast',
            domain: `recast:${pairKey()}`,
            allocates: target.ownership === 'shared-refcount',
            // Unused only while no field crosses the dynamic boundary; a boxed
            // field is read through the payload's protocol later
            // (`recordRecastCrossesDynamic`).
            ...(recordRecastCrossesDynamic(viewed, viewedTarget) ? {} : { nativeFieldProtocol: 'unused' as const })
          }
        }
      }
      // The arm the value belongs in, written as a DIFFERENT shape id than the
      // arm declares. A tuple literal returned into a union of tuple types is
      // the case -- a method writes `[items]` against
      // `Result<T> = [[T, A][]] | [[T, B][], C]` --
      // and an exact-key search cannot see it, because the literal's own shape
      // id is minted at the literal and the arm's at the declaration. It is
      // still the same shape: `recordsRecastable` is the one authority on that,
      // asked here so this admission and `armInjectedText`'s render, which asks
      // it through `recastedRecordText`, can never disagree. When several arms
      // accept the value it carries no field that tells them apart (every
      // distinguishing field is optional and absent), so each is a correct
      // home; the first is the one `armInjectedText` renders into.
      if (source.kind === 'record' && target.kind === 'tagged-union') {
        const recastable = target.arms.map((arm) => arm.value).filter((arm) => arm.kind === 'record' && recordsRecastable(source, arm))
        const sole = recastable[0]
        if (!sole || sole.kind !== 'record') return null
        return {
          classifier: { id: 'gea::TaggedUnion::ofArm', domain: `arm-recast:${pairKey()}` },
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain: `arm-recast:${pairKey()}`,
            allocates: sole.ownership === 'shared-refcount',
            nativeFieldProtocol: 'unused'
          }
        }
      }
      if (source.kind === 'record' && target.kind === 'record') {
        if (!recordsRecastable(source, target)) return null
        return {
          classifier: { id: 'gea::record::recast', domain: `recast:${pairKey()}` },
          materializer: {
            id: 'gea::record::recast',
            domain: `recast:${pairKey()}`,
            allocates: target.ownership === 'shared-refcount',
            // This renderer only copies fields, injects native alternatives and
            // recursively rebuilds records. It never asks a dynamic field table
            // -- unless a field it copies is boxed into (or unboxed out of) a
            // `dynamic` destination: that payload is read through its own field
            // protocol by every later dynamic read, so the claim is withheld
            // (`recordRecastCrossesDynamic`) and the payload keeps its protocol.
            ...(recordRecastCrossesDynamic(source, target) ? {} : { nativeFieldProtocol: 'unused' as const })
          }
        }
      }
      // A closed record's fields poured into an open dictionary -- one level out
      // from the record-to-record recast just above, and sound for the same
      // reason: the dictionary can hold every field the record has, so nothing
      // is lost going from the closed shape to the open one. `derive.ts`'s
      // `dictionary` case is the mirror refusal (recovering a closed field list
      // from an open one is not derivable); this direction has no such gap.
      // `emit-narrowing.ts`'s `recordCastableToDictionary` is the one authority
      // for which pairs actually rebuild, asked here rather than restated.
      // A named interface is the same closed field list, resolved through the
      // layout it names (`asRecord`): a program builds a named interface value
      // and hands it to a parameter typed `Document`.
      // A record that also carries an open string index -- a mapped
      // `Filter<T>`, or a named interface whose layout declares one --
      // poured into an open string dictionary, or into the ONE dictionary arm of
      // a union (`Document | Document[]`): the named fields, then every
      // enumerable index entry (`indexedRecordCastableToDictionary`). Ahead of
      // the plain recast below, which knows only the named fields and would drop
      // the rest. A `dynamic` arm beside the dictionary is not a second home:
      // the typed dictionary holds the document natively.
      // A shared record handed to an open `any` Document is that record, viewed
      // (`classDocumentViewText`, in the chain): a table of its fields would be
      // a second object, deaf to every write made through either name after.
      if (classDocumentViewText(source, target, 'gea_view_probe') !== null) return null
      const indexedView = indexedRecordViewOf(source, layouts)
      if (indexedView !== null && target.kind === 'dictionary') {
        if (!indexedRecordCastableToDictionary(indexedView, target)) return null
        return {
          classifier: { id: INDEXED_RECORD_TO_DICTIONARY, domain: `recast:${pairKey()}` },
          materializer: { id: INDEXED_RECORD_TO_DICTIONARY, domain: `recast:${pairKey()}`, allocates: true }
        }
      }
      if (indexedView !== null && target.kind === 'tagged-union' && indexedRecordDictionaryArmOf(indexedView, target) !== null) {
        return {
          classifier: { id: INDEXED_RECORD_INTO_DICTIONARY_ARM, domain: `arm-recast:${pairKey()}` },
          materializer: { id: INDEXED_RECORD_INTO_DICTIONARY_ARM, domain: `arm-recast:${pairKey()}`, allocates: true }
        }
      }
      if ((source.kind === 'record' || (source.kind === 'native-record-ref' && !source.recursive)) && target.kind === 'dictionary') {
        const viewed = asRecord(source)
        if (viewed.kind !== 'record' || !recordCastableToDictionary(viewed, target)) return null
        return {
          classifier: { id: 'gea::record::recastToDictionary', domain: `recast:${pairKey()}` },
          materializer: { id: 'gea::record::recastToDictionary', domain: `recast:${pairKey()}`, allocates: true }
        }
      }
      // Structural recipes publish live dictionary views with checked reads
      // and total writes. This widening table must not replace that shared
      // storage with an entry-by-entry copy. Exact identity and native-sum
      // transport are handled by their ordinary authorities.
      if (source.kind === 'dictionary' && target.kind === 'dictionary') return null
      // Two optionals over the IDENTICAL payload that disagree only on which
      // falsy JS value spends the absence -- `string | null` widened into a
      // `string | undefined` slot (`request.ts`'s `this.raw.headers.get(name) ??
      // undefined`, where DOM `Headers.get` returns `string | null`). `gea::
      // Optional<T>` has no field for which value caused the empty state --
      // `cppTypeOf` never reads `.absence` -- so the two carriers are one C++
      // type under two identities, and `emit-narrowing.ts`'s `convertedValueText`
      // already renders this as the value unchanged (its `cppTypeOf(source) ===
      // cppTypeOf(target)` shortcut). This only asks whether the CAPABILITY
      // exists; a payload that itself still needs converting is refused here and
      // left to the ordinary narrowing/widening obligations to require.
      if (source.kind === 'optional' && target.kind === 'optional') {
        if (representationKey(source.payload) === representationKey(target.payload)) {
          // Payload already identical: the only difference is which falsy value
          // spends the absence, so this is `rebrandAbsence` alone (see above).
          if (source.absence === target.absence) return null
          return {
            classifier: { id: 'gea::Optional::rebrandAbsence', domain: `recast:${pairKey()}` },
            // Same payload, only the absence tag is renamed: no field is read.
            materializer: {
              id: 'gea::Optional::rebrandAbsence',
              domain: `recast:${pairKey()}`,
              allocates: false,
              nativeFieldProtocol: 'unused',
              nativePayloadTransport: 'preserved'
            }
          }
        }
        // The payload is a record recast one level in: `return toSearchResult(
        // undefined)` where the copy at `T = undefined` returns `{ value:
        // undefined } | undefined` into a slot declared `SearchResult<Resolved>`
        // (13 rows from one module). The bare pair is already
        // admitted just below (`gea::record::recast`); the presence bit adds
        // nothing to convert, only a branch to render, so the admission is the
        // same question asked of the payloads. Same absence on both sides, as
        // for the union case: an absence-tag difference alongside a reshaping is
        // two conversions, not one.
        if (
          source.payload.kind === 'record' &&
          target.payload.kind === 'record' &&
          source.absence === target.absence &&
          recordsRecastable(source.payload, target.payload)
        ) {
          return {
            classifier: { id: 'gea::Optional::has_value', domain: `recast:${pairKey()}` },
            materializer: {
              id: 'gea::Optional::recastPayload',
              domain: `recast:${pairKey()}`,
              allocates: target.payload.ownership === 'shared-refcount',
              nativeFieldProtocol: 'unused'
            }
          }
        }
        // The payload itself is a union recast one level in -- `optional(string |
        // boolean, undefined)` merged against `optional(boolean | string,
        // undefined)`, the two branches of a control-flow merge each arriving
        // through an independently-declared union (the SAME shape
        // `recastedUnionText` handles for a bare union, just still wrapped in the
        // presence bit). Both payloads must be tagged unions built from the same
        // member set for this to be sound -- an absence-tag difference alongside
        // a genuine payload reshaping is two conversions, not one, and is left
        // unclaimed rather than composed here.
        if (source.payload.kind !== 'tagged-union' || target.payload.kind !== 'tagged-union') return null
        if (source.absence !== target.absence) return null
        const payloadTargetKeys = target.payload.arms.map((arm) => representationKey(arm.value))
        if (!source.payload.arms.every((arm) => payloadTargetKeys.includes(representationKey(arm.value)))) return null
        return {
          classifier: { id: 'gea::TaggedUnion::is', domain: `recast:${pairKey()}` },
          // Every source arm is a target arm BY KEY, so `recastedUnionText`
          // homes each one exact (`ofArm<j>(get<i>())`): a re-tag, no field read.
          materializer: {
            id: 'gea::TaggedUnion::ofArm',
            domain: `recast:${pairKey()}`,
            allocates: false,
            nativeFieldProtocol: 'unused',
            nativePayloadTransport: 'preserved'
          }
        }
      }
      // A sum every arm of which reaches ONE payload, wrapped in the presence
      // bit: `fn === undefined ? node : fn(node, ...)` returned as `T |
      // undefined` from a generic visitor `visit<T>` -- `tagged-union(
      // native-record-ref | dynamic)` into `optional(native-record-ref)`, 74
      // rows from one site, one per instantiation. The
      // typed arm is the payload and the dynamic arm is the checked unbox, and
      // `emit-narrowing.ts`'s `sumIntoPayloadText` is asked here so the pair is
      // admitted on exactly the render that will spell it.
      if (
        source.kind === 'tagged-union' &&
        target.kind === 'optional' &&
        target.absence === 'undefined' &&
        sumIntoPayloadText(source, target.payload, 'gea_sum', (arm) => arm) !== null
      ) {
        return {
          classifier: { id: 'gea::TaggedUnion::is', domain: `sum-into-payload:${pairKey()}` },
          materializer: { id: 'gea::TaggedUnion::intoPayload', domain: `sum-into-payload:${pairKey()}`, allocates: false }
        }
      }
      if (source.kind !== 'tagged-union' || target.kind !== 'tagged-union') return null
      const targetKeys = target.arms.map((arm) => representationKey(arm.value))
      if (!source.arms.every((arm) => targetKeys.includes(representationKey(arm.value)))) return null
      return {
        classifier: { id: 'gea::TaggedUnion::is', domain: `recast:${pairKey()}` },
        // A pure re-tag, as the optional-wrapped twin above.
        materializer: {
          id: 'gea::TaggedUnion::ofArm',
          domain: `recast:${pairKey()}`,
          allocates: false,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved'
        }
      }
    },
    /**
     * Asked of the printer's own chain (`emit-narrowing.ts`'s
     * `conversionChain`), so the census answers exactly what the printer
     * renders. The chain's step ids are the recipe ids; a step that claims the
     * pair but cannot render it is reported as no recipe, which is the same
     * refusal the printer would raise at emission. `allocates` is stated per
     * step: the recipes that mint a fresh value are the ones that construct
     * a target from parts.
     */
    // Installed exactly when the printer's own renderer has a text for it
    // (`emit-coercion.ts` says why the same function answers both).
    coercion: (source: Representation, operation: CoercionOperation) =>
      coercionText(operation, 'x', source, layouts) === null
        ? null
        : {
            id: `coercion:${operation}`,
            domain: `coercion:${operation}:${representationKey(source)}`,
            allocates: operation === 'ToString'
          },
    nativeArrayViewRecipe: (source, target, lookup, read, resolve) => {
      const base = nativeArrayViewBasePlanOf(source, target, lookup, read, resolve)
      if (base === null) return null
      const observationTarget: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
      const observed = nativeArrayViewWithObservation(base, lookup(base.storage.element, observationTarget), resolve)
      const plan =
        observed !== null && source.kind === 'array-object' && observed.write.kind === 'conversion'
          ? nativeArrayViewWithOwnerObservation(observed, lookup(observed.storage, observationTarget), resolve)
          : observed
      if (plan === null) return null
      // An open Document is checked as the object it views, exactly as a box is.
      const boxed = nativeArrayViewSourceIsBoxed(source)
      const domain = boxed
        ? `any-of:array-payload:${representationKey(plan.storage)}|array-payload:${representationKey(plan.target)}`
        : `native-array-view:${representationKey(source)}->${representationKey(target)}`
      return {
        classifier: { id: boxed ? 'gea::detail::nativeArrayViewAccepts' : 'gea::ArrayObject::identity', domain },
        materializer: {
          id: boxed ? 'gea::detail::checkedNativeArrayView' : 'gea::makeNativeArrayView',
          domain,
          allocates: true,
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          ...(boxed ? { requiresSourceGuard: true, executesSourceGuard: true } : {}),
          nativeArrayView: plan,
          dependencies: plan.dependencies
        }
      }
    },
    dictionaryReadRecipe: (conversion) => {
      const { source, target, capability } = conversion
      if (capability.kind === 'atom' || capability.kind === 'static') {
        if (capability.materializer.documentRecordView !== undefined || capability.materializer.nativeArrayView !== undefined) return null
        const selection = capability.materializer.nativeSelection
        if (selection !== undefined)
          return {
            id: 'view:checked-dictionary-entry',
            domain: 'static:checked-dictionary-entry',
            allocates: false,
            requiresSourceGuard: true,
            executesSourceGuard: true,
            dictionaryRead: { kind: 'native-selection', conversion, selection },
            dependencies: [conversion]
          }
      }
      if (source.kind !== 'dynamic' || target.kind === 'dynamic') return null
      if (target.kind === 'null' || target.kind === 'undefined')
        return {
          id: 'view:checked-dictionary-entry',
          domain: 'static:checked-dictionary-entry',
          allocates: false,
          requiresSourceGuard: true,
          executesSourceGuard: true,
          dictionaryRead: { kind: 'dynamic-absence', conversion, absence: target.kind },
          dependencies: [conversion]
        }
      if (target.kind === 'class-ref' && target.ownership === 'shared-refcount')
        return {
          id: 'view:checked-dictionary-entry',
          domain: 'static:checked-dictionary-entry',
          allocates: false,
          requiresSourceGuard: true,
          executesSourceGuard: true,
          dictionaryRead: { kind: 'dynamic-class', conversion, target },
          dependencies: [conversion]
        }
      // A construct-frame entry reads through its own adapter too: the exact
      // payload check below would refuse a constructor boxed at another frame.
      if (callableObjectAbi(target) !== null || target.kind === 'constructor-value-dispatch')
        return {
          id: 'view:checked-dictionary-entry',
          domain: 'static:checked-dictionary-entry',
          // The adapter may build a native frame around the same function.
          allocates: 'materializer' in capability && capability.materializer.allocates,
          requiresSourceGuard: true,
          executesSourceGuard: true,
          dictionaryRead: { kind: 'dynamic-callable', conversion },
          dependencies: [conversion]
        }
      const tag = dynamicTagFor(target)
      if (tag === null || target.kind === 'optional' || target.kind === 'record' || target.kind === 'record-with-index') return null
      return {
        id: 'view:checked-dictionary-entry',
        domain: 'static:checked-dictionary-entry',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true,
        dictionaryRead: { kind: 'dynamic-payload', conversion, target, tag },
        dependencies: [conversion]
      }
    },
    readOnlyDictionaryRecipe: (source, target, lookup, resolve, read) => {
      const plan = composedDictionaryViewPlan(source, target, 'read-only', lookup, resolve, read)
      return plan === null
        ? null
        : {
            id: 'view:read-only-dictionary',
            domain: 'static:read-only-dictionary',
            allocates: true,
            readOnlyDictionary: plan,
            dependencies: plan.dependencies
          }
    },
    structuralRecipe: (
      source: Representation,
      target: Representation,
      lookup: (source: Representation, target: Representation) => ConversionNode,
      members?: FamilyMemberKeys,
      nativeMethod?: (source: Representation, target: Representation) => ConversionNode | null,
      resolve?: ConversionNodeResolver,
      dictionaryRead?: (source: Representation, target: Representation) => ConversionNode | null,
      classDowncast?: (source: Representation, target: Representation) => ConversionNode | null
    ): MaterializerContract | null => {
      if (!isSpellable(source) || !isSpellable(target)) return null
      if (classArmWithoutHome(layouts, source, target)) return null
      if (proxyArmWithoutHome(source, target)) return null
      const accepted = (from: Representation, into: Representation): ConversionNode | null => {
        const node = lookup(from, into)
        return node.capability.kind === 'never' ? null : node
      }
      const nativeDependencies = (nodes: readonly ConversionNode[]): boolean =>
        [...recipeClosureOf(nodes, resolve).values()].every((node) => transfersNativeStorage(node.capability))
      // `writeDocumentNativeEntry` stores through `nativeDocumentSetNative`,
      // which checks an Array owner's element lane before an index store.
      const documentRecordView = composedDocumentRecordViewPlanOf(source, target, layouts, accepted, dictionaryRead ?? accepted, resolve, {
        laneChecked: true
      })
      if (documentRecordView !== null)
        return {
          id: 'view:document-record',
          domain: 'static:document-record',
          allocates: true,
          documentRecordView,
          nativeFieldViewProtocol: 'live',
          dependencies: documentRecordView.dependencies
        }
      const dictionaryView = composedDictionaryViewPlan(source, target, 'mutable', accepted, resolve, dictionaryRead)
      if (dictionaryView !== null)
        return {
          id: 'view:mutable-dictionary',
          domain: 'static:mutable-dictionary',
          allocates: true,
          dictionaryView,
          dependencies: dictionaryView.dependencies
        }
      const callablePayload = callablePayloadPlan(source, target, accepted, resolve)
      if (callablePayload !== null)
        return {
          id: 'view:callable-payload',
          domain: 'static:callable-payload',
          allocates: true,
          callablePayload,
          dependencies: [callablePayload.payload],
          ...(nativeDependencies([callablePayload.payload]) ? { nativeFieldProtocol: 'unused' as const } : {}),
          ...(callablePayload.mode === 'unwrap' ? { requiresSourceGuard: true as const, executesSourceGuard: true as const } : {})
        }
      if (source.kind === 'record' && target.kind === 'array-object') {
        const plan = recordToArrayPlan(source, target, accepted)
        return plan === null
          ? null
          : {
              id: 'gea::record::recastToArray',
              domain: `recast:${representationKey(source)}->${representationKey(target)}`,
              allocates: true,
              recordToArray: plan,
              ...sourceGuardsOf(
                plan.fields.map((field) => field.conversion),
                resolve
              )
            }
      }
      if (source.kind === 'promise' && target.kind === 'promise') {
        const plan = promiseAdoptionPlanOf(source, target, lookup, resolve)
        return plan === null
          ? null
          : {
              id: 'gea::Promise::adopt-converted',
              domain: `promise-state-adoption:${representationKey(source)}->${representationKey(target)}`,
              allocates: true,
              promiseAdoption: plan,
              ...(plan.kind === 'payload-transfer' ? { dependencies: [plan.conversion] } : {})
            }
      }
      const protocol = certifiedProtocolIteratorPlan(layouts, source, target, accepted, resolve)
      if (protocol !== null)
        return {
          id: PROTOCOL_ITERATOR,
          domain: `protocol-iterator:${representationKey(source)}->${representationKey(target)}`,
          allocates: true,
          protocolIterator: protocol,
          dependencies: [...protocol.leaves.values()]
        }
      if (source.kind === 'array-object' || source.kind === 'keyed-collection') {
        const plan = certifiedIterableObjectViewPlan(layouts, source, target, accepted, resolve)
        if (plan !== null)
          return {
            id: ITERABLE_OBJECT_VIEW,
            domain: `iterable-object-view:${representationKey(source)}->${representationKey(target)}`,
            allocates: true,
            iterableObjectView: plan,
            dependencies: [...plan.leaves.values()]
          }
      }
      if (source.kind === 'iterator' || source.kind === 'async-generator') {
        const plan = certifiedIteratorObjectViewPlan(layouts, source, target, accepted, resolve)
        if (plan !== null)
          return {
            id: ITERATOR_OBJECT_VIEW,
            domain: `iterator-object-view:${representationKey(source)}->${representationKey(target)}`,
            allocates: true,
            iteratorObjectView: plan,
            dependencies: [...plan.leaves.values()]
          }
      }
      const sourceCallable = callableObjectAbi(source)
      const targetCallable = callableObjectAbi(target)
      if (sourceCallable !== null && targetCallable !== null) {
        const plan = callableViewPlan(source, target, accepted, resolve, classDowncast)
        if (plan !== null) {
          const dependencies = [
            ...(plan.logicalReceiver?.materializers ?? []),
            ...(plan.receiver === null ? [] : [plan.receiver]),
            ...plan.parameters,
            ...(plan.omittedArguments ?? []),
            ...(plan.restPacking?.elements ?? []),
            ...(plan.restUnpacking?.elements.flatMap((element) =>
              element.absent === null ? [element.present] : [element.present, element.absent]
            ) ?? []),
            ...(plan.result === null ? [] : [plan.result])
          ]
          return {
            id: VIEW_ADAPTED_CALLABLE,
            domain: 'static:adapted-callable',
            allocates: true,
            callableView: plan,
            dependencies,
            // adaptSourceWithReceiver shares the original Function identity.
            // Executable native frames are a separate claim, authenticated by
            // every sealed leaf rather than inherited from a provisional atom.
            callableIdentityTransport: 'preserved',
            ...(nativeDependencies(dependencies)
              ? { nativeFieldProtocol: 'unused' as const, callableAdapter: { from: sourceCallable, to: targetCallable } }
              : {})
          }
        }
      }
      const plan = certifiedRecordViewPlan(layouts, source, target, accepted, members, nativeMethod, resolve)
      return plan === null
        ? null
        : {
            id: members === undefined ? 'view:structural-record' : FAMILY_MEMBER_VIEW_MATERIALIZER,
            domain: members === undefined ? 'static:structural-record-view' : 'static:family-member-record-view',
            allocates: true,
            recordView: plan,
            ...(nativeFieldViewPlanIsLive(plan) ? { nativeFieldViewProtocol: 'live' as const } : {}),
            dependencies: [...plan.leaves.values()],
            ...viewProtocolOf(plan.view),
            ...sourceGuardsOf([...plan.leaves.values()], resolve)
          }
    },
    staticRecipe: (source: Representation, target: Representation) => {
      if (!isSpellable(source) || !isSpellable(target)) return null
      if (classArmWithoutHome(layouts, source, target)) return null
      if (proxyArmWithoutHome(source, target)) return null
      const recipe = conversionRecipeOf(source, target)
      if (recipe !== null && recipe.renders) {
        // `unreachable-value` spells either `unreachableValue<T>()` (a throw that
        // reads nothing) or a discard into `undefined`: no field is read and no
        // payload is built. `same-cpp-type` spells the value itself -- the two
        // carriers are one C++ type -- so it is identity at run time: gea's
        // `constructor-family` into `new () => C`, or a `jsx-element` handle
        // stored as `GeaElement` where one host type carries both. A `narrowed-load` out of a sum is the structural
        // load whose contract its leaf pairs compose (see `nativeNarrowing`).
        // `optional-wrap-converted` spells `Optional<P>{P{inner}}` around the
        // chain's own text for (source, payload), so it reads a field table
        // exactly when that inner conversion does (`nativeWrappedPayload`).
        const native: NativeNarrowingContract =
          recipe.id === 'unreachable-value'
            ? { nativeFieldProtocol: 'unused', ...(source.kind === 'undefined' ? { nativePayloadTransport: 'preserved' as const } : {}) }
            : recipe.id === 'same-cpp-type'
              ? { nativeFieldProtocol: 'unused', nativePayloadTransport: 'preserved' }
              : recipe.id === 'narrowed-load' && (source.kind === 'optional' || source.kind === 'tagged-union')
                ? nativeNarrowing(source, target)
                : recipe.id === 'optional-wrap-converted' && target.kind === 'optional'
                  ? nativeWrappedPayload(source, target.payload)
                  : // `optional-payload-convert` spells `has_value() ? T{P{convert(*x)}} : T{}`,
                    // the same shape around the payload's own conversion.
                    recipe.id === 'optional-payload-convert' && source.kind === 'optional' && target.kind === 'optional'
                    ? nativeWrappedPayload(source.payload, target.payload)
                    : {}
        return {
          id: `chain:${recipe.id}`,
          domain: `static:${recipe.id}`,
          allocates: allocatingRecipes.has(recipe.id),
          ...(recipe.id === 'narrowed-load' ? { armSelection: 'guarded-load' as const } : {}),
          ...native,
          ...(recipe.id === 'unreachable-value' && source.kind === 'undefined' ? { normalCompletion: 'never' as const } : {})
        }
      }
      // A callable whose parameter reaches the source's only through a record
      // view (`emit-narrowing.ts`'s `VIEW_ADAPTED_CALLABLE`): the chain's own
      // adapter asked the same parameters and found no layout-free conversion.
      if (
        source.kind === 'function-value-dispatch' &&
        target.kind === 'function-value-dispatch' &&
        !containsUnresolved(source) &&
        !containsUnresolved(target) &&
        tryCandidateText(() =>
          resultAdaptedCallableText(source, target, 'gea_conversion_probe', (from, to, text) =>
            viewPlanFor(layouts, from, to) === null ? null : `gea_view(${text})`
          )
        ) !== null
      )
        return { id: VIEW_ADAPTED_CALLABLE, domain: 'static:adapted-callable', allocates: true, staticRecipeFallback: true }
      // Some arms homed, some with no home anywhere (`CHECKED_ARM_NARROWING`).
      if (checkedArmNarrowingText(source, target, 'gea_conversion_probe') !== null)
        return { id: CHECKED_ARM_NARROWING, domain: 'static:checked-arm-narrowing', allocates: false, staticRecipeFallback: true }
      // The printer's own last resort behind the view (`structuralRecordViewText`).
      if (boxedAssertionText(source, target, 'gea_conversion_probe') !== null)
        return { id: 'view:boxed-assertion', domain: 'static:boxed-assertion', allocates: true, staticRecipeFallback: true }
      return null
    }
  }
}

const allocatingRecipes: ReadonlySet<string> = new Set([
  // A host may lazily allocate the per-object state behind its view.
  'native-handle-view',
  'array-element-recast',
  'array-copy-recast',
  'empty-record-into-native',
  'optional-payload-convert',
  'optional-wrap-converted',
  'union-into-optional-payload',
  'union-subset-narrow',
  'union-recast',
  'record-recast',
  'optional-record-recast',
  'record-to-dictionary',
  'dictionary-to-record',
  'class-document-view',
  'record-to-array',
  'promise-payload',
  'readonly-map-view',
  'dynamic-map-arm-view'
])
