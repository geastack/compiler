import type { ClassifierMaterializerPair, CoercionOperation, ConversionRuntimeRegistry } from '../../conversion/registry.js'
import { coercionText } from './emit-coercion.js'
import { classRefTransportKind, constructorUpcastMember } from './class-ref-transport.js'
import type { ClassifierContract, CollectionDomain, MaterializerContract } from '../../conversion/algebra.js'
import { chainFieldProtocolUnused, nativeSumNarrowingTransports } from './native-narrowing-transport.js'
import { classRefDomainsOverlap, classifierDomainsOverlap } from '../../conversion/algebra.js'
import { recordCastableToArray } from './emit-arrays.js'
import { emptyConversionRegistry, narrowingReachesTarget, narrowsToDescendantClassUnion } from '../../conversion/build.js'
import type { CallableAbi, Representation, TaggedUnionArm } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { defaultRecordLayoutPolicy } from '../../representation/policies.js'
import { abiKey, arrayExtensionKey, representationKey, carriesUndefined } from '../../representation/model.js'
import {
  isSpellable,
  callableObjectAbi,
  resultAdapterTransportOf,
  boxDiscriminantsOfArm,
  type BoxDiscriminant,
  conversionRecipeOf,
  boxedAssertionText,
  dropsAllParametersIntoResultArm,
  dropsUnboundParameters,
  dynamicTagFor,
  promisePayloadConvertible,
  rebasesRestOverLeadingParameters,
  dictionaryCastableToDictionary,
  recordCastableToDictionary,
  recordRecastCrossesDynamic,
  recordsRecastable,
  sameArrayUpToExtension,
  sumIntoPayloadText,
  widensResultIntoArm
} from './emit-narrowing.js'
import { cppTypeOf } from './types.js'
import { nativeSumWidenable } from '../../conversion/native-sum.js'
import { nativeSelectionRecipeOf, nativeTotalSelectionRecipeOf, type NativeSelectionRecipe } from '../../conversion/native-selection.js'
import { nativeClassReferenceIdentityOf } from '../../conversion/native-class-reference.js'
import {
  isRecordViewTarget,
  ownedRecordMaterializationPlan,
  recordViewDispatchesArms,
  recordViewUsesOnlyDirectFields
} from '../../conversion/record-view.js'
import { cppStringObjectNativeType } from './regexp-types.js'
import { viewPlanFor } from './emit-record-view.js'

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
  if (!nativeSumWidenable(source, target)) return null
  const domain = `sum-widen:${representationKey(source)}->${representationKey(target)}`
  return {
    classifier: { id: 'gea::native-sum::live-alternative', domain },
    materializer: {
      id: 'gea::native-sum::inject-alternative',
      domain,
      allocates: false,
      nativeFieldProtocol: 'unused',
      nativePayloadTransport: 'preserved',
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
      nativeFieldProtocol: 'unused',
      nativePayloadTransport: 'preserved',
      nativeSelection,
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
 * `tagged-union(record | optional(callable))`: hono's `compose` builds that
 * carrier for its `handler`, and the render was ready for it.
 */
const boxable = (representation: Representation): boolean => {
  // Already a box. `dynamicTagFor` answers `null` for it -- a box holds
  // whichever tag its value carries, not one fixed tag -- and reading that as
  // "cannot be boxed" refused hono's `compose` handler,
  // `tagged-union(dynamic | optional(callable))`, whose first arm is one.
  if (representation.kind === 'dynamic') return true
  if (representation.kind === 'optional') return boxable(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => boxable(arm.value))
  return dynamicTagFor(representation) !== null
}

const exactTagRead = (tag: string): ClassifierMaterializerPair => ({
  classifier: { id: 'gea::Value::tag', domain: `tag:${tag}` },
  materializer: { id: 'gea::detail::unboxValue', domain: `tag:${tag}`, allocates: false }
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
 * `Object3D.traverse( part => { if ( part instanceof Mesh ) part.castShadow =
 * true } )` is the shape, and it is the one `instanceof` exists for -- the
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
const downcastsToDerived = (source: Representation, target: Representation): boolean => classRefTransportKind(source, target) === 'downcast'

/** Exactly one class arm inside `target` accepts `source` by inheritance. */
const hasSingleClassUpcastHome = (source: Representation, target: Representation): boolean => {
  if (upcastsToBase(source, target)) return true
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
    materializer: { id: 'generic-function-set::remap', domain, allocates: false }
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
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
      return representation.ownership === 'shared-refcount'
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

const dynamicCallableAbiSupported = (abi: CallableAbi, seen = new Set<Representation>()): boolean => {
  if (abi.receiver !== null && !dynamicCarrierSupported(abi.receiver, seen)) return false
  if (abi.result.kind !== 'void' && !dynamicCarrierSupported(abi.result, seen)) return false
  if (!abi.parameters.every((parameter) => dynamicCarrierSupported(parameter.value, seen))) return false
  if (abi.restFrom === null) return true
  const rest = abi.parameters[abi.restFrom]?.value
  return (
    abi.restFrom === abi.parameters.length - 1 &&
    rest?.kind === 'array-object' &&
    rest.ownership === 'shared-refcount' &&
    dynamicCarrierSupported(rest.element, seen)
  )
}

const dynamicCallablePair = (target: Extract<Representation, { kind: 'function-value-dispatch' }>): ClassifierMaterializerPair => {
  const domain = `dynamic-callable:${representationKey(target)}`
  return {
    classifier: { id: 'gea::Value::tag', domain },
    materializer: { id: 'gea::detail::DynamicCarrier::in', domain, allocates: true }
  }
}

type NativeNarrowingContract = Pick<MaterializerContract, 'nativeFieldProtocol' | 'nativePayloadTransport'>

/**
 * A shared class handle among a sum's arms, at a record-shaped target it
 * reaches by neither the chain nor the structural view.
 *
 * Nothing in the program proves that arm dead: an interface-typed slot holds
 * whatever object the program put there (`semantics/interface-implementors.ts`),
 * and a class this cannot view as the record is still a value the slot can be
 * handed -- skytail's `const ctx: AudioContextLike | null = Ctor ? new Ctor()
 * : createNativeAudioContext()`, whose `NativeAudioContext` carries class-typed
 * fields and a promise the view cannot rebuild. Selecting the record arm
 * there read the class instance's bytes as the record and crashed at launch,
 * certified. A record arm beside the exact one is the opposite case: a record
 * the view cannot rebuild as the target is not assignable to it either, so the
 * checker's own narrowing is what put the pair here, and the selection stands.
 *
 * Asked by every table that could answer the pair -- `narrowing` and
 * `staticRecipe` -- so the census refuses it outright rather than one table
 * declining and the next selecting.
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
    (source, payload) => (chainFieldProtocolUnused(registry, source, payload) ? { nativeFieldProtocol: 'unused' } : {})
  )
  return registry
}

const cppConversionTables = (
  layouts: RecordLayoutPolicy,
  nativeNarrowing: (source: Representation, target: Representation) => NativeNarrowingContract,
  nativeWrappedPayload: (source: Representation, payload: Representation) => NativeNarrowingContract
): ConversionRuntimeRegistry => ({
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
   * values. This is Three's public `Function | null` sort hook. Broadening the
   * predicate requires matching `DynamicCarrier<T>::supported` for every new
   * parameter/result carrier; guessing there would move an honest preflight
   * refusal into a C++ template failure.
   */
  functionValueDispatchMaterializer: (abi) => {
    const target = { kind: 'function-value-dispatch' as const, abi }
    return dynamicCallableAbiSupported(abi) ? dynamicCallablePair(target) : null
  },
  functionMaterializer: (functionId, abi) => {
    if (!dynamicCallableAbiSupported(abi)) return null
    const domain = `dynamic-callable-identity:${functionId}:${representationKey({ kind: 'function', functionId, abi })}`
    return {
      classifier: { id: 'gea::Value::callableDeclarationIdentity', domain },
      materializer: { id: 'gea::detail::DynamicCarrier::in', domain, allocates: true }
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
   * `never`, so EVERY nullable tagged-union read out of a box was refused --
   * 15 of the three.js app's 74 unmet obligations, all on this one arm.
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
      materializer: { id: 'gea::detail::unboxClassRef', domain, allocates: false }
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
      materializer: { id: 'gea::detail::unboxValue', domain, allocates: false }
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
   * `record`/`native-record-ref`/`class-ref`/`array-object` are deliberately
   * NOT routed here even though they would qualify -- each already has its own
   * entry with its own reasoning, and a second answer to the same question is
   * how two authorities drift apart.
   */
  boxedIdentityMaterializer: (target) => {
    const eligible =
      (target.kind === 'dictionary' || target.kind === 'record-with-index' || target.kind === 'typed-array') &&
      target.ownership === 'shared-refcount'
    if (!eligible && target.kind !== 'array-buffer' && target.kind !== 'shared-array-buffer') return null
    if (dynamicTagFor(target) === null) return null
    const domain = `boxed-identity:${representationKey(target)}`
    return {
      classifier: { id: 'gea::Value::payloadType', domain },
      materializer: { id: 'gea::detail::unboxValue', domain, allocates: false }
    }
  },
  recordRefMaterializer: (shapeId, ownership) => {
    if (ownership !== 'shared-refcount') return null
    const domain = `record-payload:${shapeId}:${ownership}`
    return {
      classifier: { id: 'gea::Value::payloadType', domain },
      materializer: { id: 'gea::detail::unboxValue', domain, allocates: false }
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
        materializer: { id: 'gea::host::unreachableValue', domain, allocates: false, nativeFieldProtocol: 'unused' }
      }
    }
    // A shared structural view read as a class, under the `instanceof` that
    // proved it was built from one: the view remembers its origin
    // (`gea::record::viewOrigin`) and the origin is narrowed like any boxed
    // class instance, checked. An optional view is the same read of its
    // payload, which the test proved present.
    const sharedView = (value: Representation): boolean =>
      (value.kind === 'record' || value.kind === 'record-with-index' || (value.kind === 'native-record-ref' && value.native === null)) &&
      value.ownership === 'shared-refcount'
    if (
      target.kind === 'class-ref' &&
      target.ownership === 'shared-refcount' &&
      (sharedView(source) || (source.kind === 'optional' && sharedView(source.payload)))
    ) {
      const domain = `view-origin:${representationKey(target)}`
      return {
        classifier: { id: 'gea::record::viewOriginIs', domain },
        materializer: { id: 'gea::record::viewOrigin', domain, allocates: false, nativeFieldProtocol: 'unused' }
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
          nativeFieldProtocol: 'unused',
          nativePayloadTransport: 'preserved',
          ...nativeClassReferenceIdentityOf(source, target)
        }
      }
    }
    // The same handle read at a UNION of descendants -- `object instanceof Mesh
    // || object instanceof Line || object instanceof Points`. The physical
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
          // Presence and sum selection over native class handles never reads
          // field values. Mixed sums retain their general converting protocol.
          ...(nativeClassPresence(source)
            ? { nativeFieldProtocol: 'unused' as const, ...nativeClassReferenceIdentityOf(source, target) }
            : {})
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
          ...nativeNarrowing(source, target)
        }
      }
    }
    if (!union.arms.some((arm) => representationKey(arm.value) === targetKey)) {
      // An arm the target lives INSIDE, not one that equals it. A narrowing
      // does not stop at the top level: three's `?(string|number|boolean)`
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
          ...nativeNarrowing(source, target)
        }
      }
    }
    return {
      classifier: { id: 'gea::TaggedUnion::is', domain: `live-arm:${targetKey}` },
      materializer: { id: 'gea::TaggedUnion::get', domain: `live-arm:${targetKey}`, allocates: false, ...nativeNarrowing(source, target) }
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
      dynamicCallableAbiSupported(target.abi)
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
    if (constructorUpcastMember(source, target) !== null) {
      const domain = `constructor-upcast:${representationKey(source)}->${representationKey(target)}`
      return {
        classifier: { id: 'gea::upcastConstructor', domain },
        materializer: { id: 'gea::upcastConstructor', domain, allocates: false }
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
          ...(callableAdapter === null
            ? {}
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
          ...nativeClassReferenceIdentityOf(source, target)
        }
      }
    }
    // A source that is not the payload but reaches it by one of the four
    // `gea::CallableObject` converting constructors above. Every one of those
    // was installed only for a BARE callable target, so
    // `((gl, v) => void)` returned where `((gl, v, textures) => void) |
    // undefined` is expected -- three's `getSingularSetter`, 30 returns of
    // exactly that shape -- refused for a pair whose two halves this backend
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
        dropsUnboundParameters(source, payload) || dropsAllParametersIntoResultArm(source, payload) || widensResultIntoArm(source, payload)
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
    if (source.kind === 'promise' && target.kind === 'promise' && promisePayloadConvertible(source.value, target.value)) {
      const domain = `promise-state-adoption:${representationKey(source)}->${representationKey(target)}`
      return {
        classifier: { id: 'gea::Promise::state', domain },
        materializer: { id: 'gea::Promise::adopt-converted', domain, allocates: true }
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
    // of millions on TypeScript's own compiler, and almost every pair leaves
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
      cppTypeOf(source) === cppTypeOf(target)
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
    // (`NodeArray<T> extends ReadonlyArray<T>`, `array-object.extension`) are
    // ONE `gea::ArrayObject<E>`: the fields live in the object's own
    // extension sidecar, so `elements.slice() as MutableNodeArray<T>` is the
    // same object gaining fields on their first write, and a `NodeArray<T>`
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
        materializer: { id: 'gea::ArrayObject::identity', domain: `array-extension:${pairKey()}`, allocates: false }
      }
    }
    // `never[]` into `E[]`: THE empty array of `E`, by identity. tsc's
    // `emptyArray: never[]` is a sentinel the program compares by identity
    // (`type.resolvedBaseTypes = emptyArray` marks a circular resolution in
    // progress; `=== emptyArray` detects it), so a fresh `[]` is a silently
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
    // in three's `getProgramCacheKey`: the two helpers pushed ~60 values into
    // the COPY, so every material's cache key came out identical, one shader
    // program served the whole scene, and every HUD glyph rendered as a solid
    // rectangle. A compile refusal is the correct outcome here, and the fix
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
          return {
            classifier: { id: 'gea::record::classStructuralView', domain: `class-view:${pairKey()}` },
            materializer: {
              id: 'gea::record::classStructuralView',
              domain: `class-view:${pairKey()}`,
              allocates: target.ownership === 'shared-refcount'
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
    if (source.kind === 'record' && source.fields.length === 0 && source.accessors.length === 0 && target.kind === 'native-record-ref') {
      return {
        classifier: { id: 'gea::record::emptyNative', domain: `empty:${pairKey()}` },
        materializer: { id: 'gea::record::emptyNative', domain: `empty:${pairKey()}`, allocates: target.ownership === 'shared-refcount' }
      }
    }
    if (source.kind === 'record-with-index' && target.kind === 'native-record-ref' && target.native === null) {
      const targetFields = layouts.forShape(target.shapeId)
      const targetIndexes = layouts.indexesForShape?.(target.shapeId) ?? []
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
      // extra own properties: BSON's `Object.assign(o, this.fields)` returns a
      // `DBRefLike` whose user fields must still enumerate and serialize.
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
    // the case -- hono's `PatternRouter.match` writes `[handlers]` against
    // `Result<T> = [[T, Params][]] | [[T, ParamIndexMap][], ParamStash]` --
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
    // The same admission for a dictionary whose values widen into ONE
    // dictionary arm of the union -- the string dictionary `@hono/node-server`
    // merges into `[string, string][] | OutgoingHttpHeaders`. Only a SOLE
    // castable arm, for the same reason as the record rule: two would make
    // the choice of arm a guess. `emit-narrowing.ts`'s `widenedStoreText`
    // renders it through `recastedDictionaryText` at the arm it finds first,
    // which under this admission is the only one.
    if (source.kind === 'dictionary' && target.kind === 'tagged-union') {
      const recastable = target.arms
        .map((arm) => arm.value)
        .filter((arm) => arm.kind === 'dictionary' && dictionaryCastableToDictionary(source, arm))
      if (recastable.length !== 1) return null
      return {
        classifier: { id: 'gea::TaggedUnion::ofArm', domain: `arm-recast:${pairKey()}` },
        materializer: { id: 'gea::TaggedUnion::ofArm', domain: `arm-recast:${pairKey()}`, allocates: true, nativeFieldProtocol: 'unused' }
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
    if (source.kind === 'record' && target.kind === 'dictionary') {
      if (!recordCastableToDictionary(source, target)) return null
      return {
        classifier: { id: 'gea::record::recastToDictionary', domain: `recast:${pairKey()}` },
        materializer: { id: 'gea::record::recastToDictionary', domain: `recast:${pairKey()}`, allocates: true }
      }
    }
    // One shape wider: an open dictionary's values widened into another open
    // dictionary's -- `Record<string, string>` reaching `OutgoingHttpHeaders`.
    // `emit-narrowing.ts`'s `dictionaryCastableToDictionary` is the one
    // authority for which pairs rebuild, asked here rather than restated.
    if (source.kind === 'dictionary' && target.kind === 'dictionary') {
      if (!dictionaryCastableToDictionary(source, target)) return null
      return {
        classifier: { id: 'gea::dictionary::recastValues', domain: `recast:${pairKey()}` },
        materializer: { id: 'gea::dictionary::recastValues', domain: `recast:${pairKey()}`, allocates: true }
      }
    }
    // A third recast at the same distance: a closed, contiguous-numeric-keyed
    // record -- an unannotated rest parameter's open-arity tuple view, from
    // `semantics/normalize/structural.ts`'s `restParameterArrayElementAt` --
    // poured into the array it physically is. `emit-narrowing.ts`'s
    // `recordCastableToArray` is the one authority for which pairs rebuild.
    if (source.kind === 'record' && target.kind === 'array-object') {
      if (!recordCastableToArray(source, target)) return null
      return {
        classifier: { id: 'gea::record::recastToArray', domain: `recast:${pairKey()}` },
        materializer: { id: 'gea::record::recastToArray', domain: `recast:${pairKey()}`, allocates: true }
      }
    }
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
          materializer: { id: 'gea::Optional::rebrandAbsence', domain: `recast:${pairKey()}`, allocates: false }
        }
      }
      // The payload is a record recast one level in: `return toSearchResult(
      // undefined)` where the copy at `T = undefined` returns `{ value:
      // undefined } | undefined` into a slot declared `SearchResult<Resolved>`
      // (13 rows on tsc's moduleNameResolver.ts). The bare pair is already
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
      // The payload is a dictionary reaching the one wider dictionary arm of
      // the target's union, still wrapped in its presence bit: `cache[2] ||
      // (... ? undefined : { 'content-type': ... })` merged as `optional(
      // dictionary(string, string))` into `optional([string, string][] |
      // OutgoingHttpHeaders)`. The bare pair is the arm-recast admission just
      // above; the presence bit adds only the branch `emit-narrowing.ts`'s
      // `optional-payload-convert` already renders around any converted
      // payload. Same absence on both sides, as for every optional pair here.
      const sourceDictionary = source.payload.kind === 'dictionary' ? source.payload : null
      if (
        sourceDictionary !== null &&
        target.payload.kind === 'tagged-union' &&
        source.absence === target.absence &&
        target.payload.arms.filter((arm) => arm.value.kind === 'dictionary' && dictionaryCastableToDictionary(sourceDictionary, arm.value))
          .length === 1
      ) {
        return {
          classifier: { id: 'gea::Optional::has_value', domain: `recast:${pairKey()}` },
          materializer: {
            id: 'gea::Optional::recastPayloadArm',
            domain: `recast:${pairKey()}`,
            allocates: true,
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
        materializer: { id: 'gea::TaggedUnion::ofArm', domain: `recast:${pairKey()}`, allocates: false }
      }
    }
    // A sum every arm of which reaches ONE payload, wrapped in the presence
    // bit: `fn === undefined ? node : fn(node, ...)` returned as `T |
    // undefined` from tsc's `visitEachChild<T>` -- `tagged-union(
    // native-record-ref | dynamic)` into `optional(native-record-ref)`, 74
    // rows from one site on the self-compile, one per instantiation. The
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
      materializer: { id: 'gea::TaggedUnion::ofArm', domain: `recast:${pairKey()}`, allocates: false }
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
      : { id: `coercion:${operation}`, domain: `coercion:${operation}:${representationKey(source)}`, allocates: operation === 'ToString' },
  staticRecipe: (source: Representation, target: Representation) => {
    if (!isSpellable(source) || !isSpellable(target)) return null
    if (classArmWithoutHome(layouts, source, target)) return null
    // A sum some arm of which reaches the record-shaped target only through
    // the structural view is that view's `dispatch` plan, asked BEFORE the
    // chain: the chain answers the pair too, by selecting the exact arm, and
    // that selection is the narrowing this table's `narrowing` entry has
    // already declined for the pair (`recordViewDispatchesArms`). The
    // printer renders in the same order (`emit-narrowing.ts`'s `recipeText`).
    const dispatching = viewPlanFor(layouts, source, target)
    if (dispatching !== null && recordViewDispatchesArms(dispatching))
      return {
        id: 'view:structural-record',
        domain: 'static:structural-record-view',
        allocates: true,
        ...(recordViewUsesOnlyDirectFields(dispatching) ? { nativeFieldProtocol: 'unused' as const } : {})
      }
    const recipe = conversionRecipeOf(source, target)
    if (recipe !== null && recipe.renders) {
      // `unreachable-value` spells either `unreachableValue<T>()` (a throw that
      // reads nothing) or a discard into `undefined`: no field is read and no
      // payload is built. A `narrowed-load` out of a sum is the structural
      // load whose contract its leaf pairs compose (see `nativeNarrowing`).
      // `optional-wrap-converted` spells `Optional<P>{P{inner}}` around the
      // chain's own text for (source, payload), so it reads a field table
      // exactly when that inner conversion does (`nativeWrappedPayload`).
      const native: NativeNarrowingContract =
        recipe.id === 'unreachable-value'
          ? { nativeFieldProtocol: 'unused', nativePayloadTransport: 'preserved' }
          : recipe.id === 'narrowed-load' && (source.kind === 'optional' || source.kind === 'tagged-union')
            ? nativeNarrowing(source, target)
            : recipe.id === 'optional-wrap-converted' && target.kind === 'optional'
              ? nativeWrappedPayload(source, target.payload)
              : {}
      return { id: `chain:${recipe.id}`, domain: `static:${recipe.id}`, allocates: allocatingRecipes.has(recipe.id), ...native }
    }
    // After the chain, as the printer asks (`emit.ts`'s `emitConvert`): a
    // record rebuilt as another shape it satisfies, decided by the plan the
    // printer renders from (`conversion/record-view.ts`). `viewPlanFor`
    // caches this build so the printer's later render of the same node
    // (`emit-record-view.ts`'s `structuralRecordViewText`) reads the plan
    // this existence check already built rather than rebuilding it.
    const view = viewPlanFor(layouts, source, target)
    if (view !== null)
      return {
        id: 'view:structural-record',
        domain: 'static:structural-record-view',
        allocates: true,
        ...(recordViewUsesOnlyDirectFields(view) ? { nativeFieldProtocol: 'unused' as const } : {})
      }
    // The printer's own last resort behind the view (`structuralRecordViewText`).
    if (boxedAssertionText(source, target, 'gea_conversion_probe') !== null)
      return { id: 'view:boxed-assertion', domain: 'static:boxed-assertion', allocates: true }
    return null
  }
})

const allocatingRecipes: ReadonlySet<string> = new Set([
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
  'record-to-array',
  'promise-payload'
])
