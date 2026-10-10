import { isNativeCallableCarrier } from '../../representation/callable-object.js'
import { numberStorageTarget } from '../../conversion/number-storage.js'
import { numberStorageText } from './emit-number-storage.js'
import { NATIVE_REFERENCE_ABSENCE, nativeReferenceAbsenceOf } from '../../conversion/native-absence.js'
import { isNativeError } from './error-types.js'
import { proxyArmWithoutHome } from '../../representation/proxy-carriers.js'
import { physicalCarrierKey, samePhysicalCarrier } from '../../representation/physical-carrier.js'
import type { NativeSelectionHelper } from './native-selection-helpers.js'
import { cppRecordIndexSidecarName, tailAwareFieldReadText, tailAwareFieldWriteText, tailFieldsOf } from './records.js'
import {
  classRefTransportKind,
  constructorFamilyUpcastMembers,
  constructorUpcastMember,
  nativeRecordBaseTransportKind,
  nativePromiseBaseOf
} from './class-ref-transport.js'
import type { AbiParameter, CallableAbi, Ownership, RecordField, Representation, TaggedUnionArm } from '../../representation/model.js'
import {
  abiKey,
  arrayExtensionKey,
  containsUnresolved,
  isCanonicalNumberPropertyKeyText,
  isOpenDocument,
  representationKey,
  standInRefuses,
  walkRepresentation,
  carriesUndefined
} from '../../representation/model.js'
import type { IrOperand, MergeLiveArmRebuildOperation } from '../../ir/model.js'
import { programConversionKey, type ProgramConversionRecipe, type ProgramConversionRole } from '../../ir/program-conversions.js'
import { transferOf } from '../../ir/transfer.js'
import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { coercionText } from './emit-coercion.js'
import {
  ARM_VIEW_MATERIALIZER,
  ASSERTED_UNION_MATERIALIZER,
  ASSERTED_UNION_COPY_MATERIALIZER,
  ASSERTED_VIEW_MATERIALIZER,
  type AssertedViewPlan,
  EXACT_ARM_MATERIALIZER,
  FAMILY_MEMBER_VIEW_MATERIALIZER,
  CAUGHT_HANDOFF_MATERIALIZER,
  ASSERTED_CLASS_DOWNCAST_MATERIALIZER,
  NULLISH_OPTIONAL_MATERIALIZER,
  NATIVE_BASE_VIEW_MATERIALIZER,
  IMPOSSIBLE_INDEX_READ,
  exactArmIndexOf,
  isNativeCollectionUpcast,
  type ConversionCensus
} from '../../conversion/nodes.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { ClassLayout } from '../../projection/classes.js'
import type { CaptureIndex } from './emit-context.js'
import { certifiedRecordViewText, familyMemberViewText, structuralRecordViewText } from './emit-record-view.js'
import { documentRecordViewText } from './emit-document-record-view.js'
import { dynamicRecordLoadNeedsPlan } from '../../conversion/document-record-view.js'
import { IMPOSSIBLE_FIELD_READ } from '../../conversion/impossible-field-read.js'
import { checkedNativeFieldReadMismatchOf } from '../../conversion/checked-native-field-read.js'
import { callablePayloadText, callableViewText } from './emit-callable-view.js'
import { dictionaryReadText, dictionaryViewText } from './emit-dictionary-view.js'
import { nativeObjectSampleText } from './emit-native-object-sample.js'
import { nativeDescriptorSnapshotViewText } from './emit-descriptor-snapshot.js'
import { SIBLING_CLASS_ARGUMENT } from '../../conversion/sibling-class.js'
import { PROTOCOL_ITERATOR, protocolIteratorText, certifiedProtocolIteratorText } from './emit-protocol-iterator.js'
import { ITERABLE_OBJECT_VIEW, iterableObjectViewText, certifiedIterableObjectViewText } from './emit-iterable-object-view.js'
import { ITERATOR_OBJECT_VIEW, certifiedIteratorObjectViewText, iteratorObjectViewText } from './emit-iterator-object-view.js'
import {
  CONSTRUCTOR_DISPATCH_FAMILY,
  CONSTRUCTOR_IDENTITY_FAMILY,
  constructorDispatchFamilyText,
  constructorIdentityFamilyText
} from './emit-constructor-identity-family.js'
import {
  createCppEmitBlockedError,
  cppConstructThunkName,
  cppThunkName,
  defineValue,
  isCppEmitBlockedError,
  isDeferredValue,
  operandText,
  type EmitContext
} from './emit-context.js'
import { booleanTestText } from './emit-presence.js'
import { recastedRecordToArrayText } from './emit-arrays.js'
import {
  cppAbiParameterType,
  cppCallableFrameArguments,
  cppClassName,
  cppConstantLiteral,
  cppRecordFieldName,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppStringLiteral,
  cppTypeOf,
  cppNarrowedIntegerType,
  cppUndefinedIn,
  cppUndefinedValue,
  storageSlotIsNarrowed,
  unitFunctionName,
  withoutUnitFunctions
} from './types.js'
import { integerStorageSlot } from '../../ir/integer-storage.js'
import { cppRegExpNativeTypes, cppStringObjectNativeType } from './regexp-types.js'
import { widenedNativeSumText } from './emit-sum-widening.js'
import { nativeSelectionText } from './emit-native-selection.js'
import { narrowingReachesTarget } from '../../conversion/build.js'
import { evaluatedOnceText } from './evaluated-once.js'
import { nativeCallReceiverText, nativeUnboundMethodText } from './emit-native-method.js'
import type { PromiseAdoptionRecipe } from '../../conversion/promise-adoption.js'
import { dynamicWrapperPlanMatches, type DynamicWrapperPlan } from '../../conversion/dynamic-wrapper.js'
import { nativeArrayViewText } from './emit-array-view.js'
import { nativeFieldPolicyType } from './records.js'

/**
 * `native-record-ref` (the String WRAPPER OBJECT, `new String(x)`) -> `string`,
 * the one direction `convertedValueText` needs that neither `narrowedLoadText`
 * nor `widenedStoreText` otherwise reaches: both read their `held`/`written`
 * argument as a search through a union's arms or a dynamic box's tag, and a
 * String object is neither.
 *
 * A short, deliberately duplicated twin of `emit-prototype-regexp.ts`'s
 * `stringObjectToStringText` -- not imported, to avoid a cycle: that file
 * already imports `convertedValueText` FROM here (for a property store's own
 * threaded result, mirroring `emitNativeSidecarSet`), so this file cannot
 * import back from it. Both read the identical one fact,
 * ECMA-262 22.1.3.34/22.1.5.4's `[[StringData]]`, off the identical struct --
 * see `gea::runtime::StringObject`'s doc comment in `runtime/gea_runtime.h`.
 */
const stringObjectStringifyText = (source: Representation, text: string): string | null =>
  source.kind === 'native-record-ref' && source.native === cppStringObjectNativeType ? `${text}->value` : null

/**
 * Whether the C++ backend has a concrete reconciliation recipe for a promise
 * payload. Promise-to-promise conversion is state adoption plus this payload
 * conversion, so preflight and emission must ask the same authority rather
 * than maintaining a second, inevitably drifting list of payload pairs.
 */
export const promisePayloadConvertible = (source: Representation, target: Representation): boolean => {
  // A void TARGET payload has nowhere to put the source's value, and a void
  // SOURCE payload has no `value()` to read -- except when the source payload
  // is `never`, where the absence is the proof rather than the obstacle: a
  // `Promise<never>` cannot fulfil, so the target's fulfilment channel is
  // never written and only the rejection has to be carried across. This is
  // the one authority both the registry's `recasting` entry and the
  // `promise-payload` chain step ask, so the pair the census admits is the
  // pair the printer renders.
  //
  // The second exception is `void` against `undefined`, which is one promise
  // wearing two TypeScript types rather than two promises: ECMA-262 27.2.1.4
  // fulfils a promise resolved with nothing with `undefined`, and this runtime
  // elides that `undefined` entirely for `void` (`cppResultTypeOf`). So the
  // unit pair reconciles by supplying or dropping the value, in either
  // direction. An unknown payload can also hold that undefined value; it must
  // receive the fulfillment value rather than a boxed source promise.
  // A function declared `Promise<undefined | void>` whose callers `return` its
  // promise from an async function whose own result is `Promise<void>` needs
  // exactly this.
  if (target.kind === 'void') return isUnitPromisePayload(source)
  if (source.kind === 'void') return source.bottom === true || acceptsVoidPromisePayload(target)
  try {
    return convertedValueText(source, target, 'gea_promise_payload') !== null
  } catch (error) {
    if (isCppEmitBlockedError(error)) return false
    throw error
  }
}

/** A promise payload that carries no information: `void`, and the `undefined` it is spelled as wherever a value is required. */
const isUnitPromisePayload = (payload: Representation): boolean => payload.kind === 'void' || payload.kind === 'undefined'

/** A void fulfillment supplies undefined, including at an explicitly unknown boundary. */
const acceptsVoidPromisePayload = (payload: Representation): boolean => isUnitPromisePayload(payload) || payload.kind === 'dynamic'

/** `RegExpMatchArray` read through the `Array<string>` base it inherits. */
const regexpMatchArrayBaseText = (source: Representation, target: Representation, text: string): string | null =>
  source.kind === 'native-record-ref' &&
  source.native === cppRegExpNativeTypes['match-result'] &&
  source.ownership === 'shared-refcount' &&
  target.kind === 'array-object' &&
  target.ownership === 'shared-refcount' &&
  target.element.kind === 'string'
    ? `${cppTypeOf(target)}(${text})`
    : null

/** A failed candidate is not a failed search when another union arm can carry the value. */
export const tryCandidateText = (build: () => string | null): string | null => {
  try {
    return build()
  } catch (error) {
    if (isCppEmitBlockedError(error)) return null
    throw error
  }
}

/** Whether `candidate` is `base` or descends from it in the emitted class layout. */
const isOrDescendsFrom = (ctx: ConversionSite, candidate: DeclarationId, base: DeclarationId): boolean => {
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = candidate; current !== null && !seen.has(current);) {
    if (current === base) return true
    seen.add(current)
    current = ctx.classes.get(current)?.base ?? null
  }
  return false
}

/**
 * A base-class carrier narrowed to a union of descendant classes.
 *
 * The physical carrier intentionally remains one `Ref<Base>`: allocation
 * identity supplies the target union's discriminant, and checked class-family
 * downcasts preserve the same native object. This is shared by cell and field
 * reads because both are projections out of wider storage. An optional target
 * preserves the source's absence around the projected descendant union.
 */
export const classFamilyLoadText = (ctx: ConversionSite, held: Representation, read: Representation, text: string): string | null => {
  const targetUnion = read.kind === 'optional' ? read.payload : read
  if (targetUnion.kind !== 'tagged-union' || targetUnion.arms.length === 0) return null

  const heldClass = (() => {
    if (held.kind === 'optional' && held.payload.kind === 'class-ref') {
      return { source: held.payload, value: `(*${text})` }
    }
    if (held.kind === 'class-ref') return { source: held, value: text }
    if (read.kind === 'optional' || held.kind !== 'tagged-union') return null
    const classes = held.arms.flatMap((arm, index) => (arm.value.kind === 'class-ref' ? [{ source: arm.value, index }] : []))
    if (classes.length !== 1) return null
    if (!held.arms.every((arm) => arm.value.kind === 'class-ref' || arm.value.kind === 'undefined' || arm.value.kind === 'null'))
      return null
    const sole = classes[0]!
    return { source: sole.source, value: `${text}.get<${sole.index}>()` }
  })()
  if (heldClass === null) return null
  const { source, value } = heldClass
  const arms = targetUnion.arms.map((arm) => arm.value)
  if (!arms.every((arm) => arm.kind === 'class-ref' && arm.ownership === source.ownership && arm.ancestors.includes(source.declaration)))
    return null
  const classes = arms as readonly Extract<Representation, { kind: 'class-ref' }>[]
  // A target may retain both an ancestor and one of its descendants (a
  // `Base | Derived` union where `Derived extends Base`). JS unions do not
  // preserve which syntactic arm produced an object, so allocation identity
  // supplies the canonical answer: test the most-specific family first and
  // retain each arm's original target-union index when rebuilding it.
  const ordered = classes
    .map((arm, index) => ({ arm, index }))
    .sort((left, right) => {
      const leftBelowRight = isOrDescendsFrom(ctx, left.arm.declaration, right.arm.declaration)
      const rightBelowLeft = isOrDescendsFrom(ctx, right.arm.declaration, left.arm.declaration)
      if (leftBelowRight !== rightBelowLeft) return leftBelowRight ? -1 : 1
      return left.index - right.index
    })

  const unionType = cppTypeOf(targetUnion)
  const armText = (arm: Extract<Representation, { kind: 'class-ref' }>, index: number): string =>
    `${unionType}::ofArm<${index}>(gea::host::downcastClassRef<${cppClassName(arm.declaration)}>(${value}))`
  const fallback = ordered[ordered.length - 1]!
  let projected = armText(fallback.arm, fallback.index)
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const candidate = ordered[index]!
    const arm = candidate.arm
    const descendants = [...ctx.classes.keys()].filter(
      (candidate) => isOrDescendsFrom(ctx, candidate, arm.declaration) && isOrDescendsFrom(ctx, candidate, source.declaration)
    )
    if (descendants.length === 0) return null
    const test = `gea::host::hasNativeClassLayoutRef<${descendants.map(cppClassName).join(', ')}>(${value})`
    projected = `${test} ? ${armText(arm, candidate.index)} : (${projected})`
  }
  if (classes.length > 1) projected = `(${projected})`
  if (read.kind !== 'optional') return projected

  const targetType = cppTypeOf(read)
  if (held.kind === 'optional') {
    if (held.absence !== read.absence) return null
    return `(${text}.has_value() ? ${targetType}(${projected}) : ${targetType}())`
  }
  if (held.kind !== 'class-ref') return null
  if (read.absence === 'null') return `(${text} ? ${targetType}(${projected}) : ${targetType}())`
  return `${targetType}(${projected})`
}

/**
 * The live arm of a tagged union, as an expression.
 *
 * More than one arm can carry the target's C++ type -- `A | B | C` where all
 * three lower to `std::string` -- so the load dispatches on the discriminant
 * rather than assuming a position. With one candidate it is a plain `get`, and
 * the chain collapses to nothing; with several it tests each in turn and falls
 * through to the last without testing it, because the narrowing already proved
 * one of them is live and a test with no else has nothing to return.
 */
const taggedUnionArmText = (
  union: Extract<Representation, { kind: 'tagged-union' }>,
  target: Representation,
  text: string,
  unhomed: 'refuse' | 'throw' = 'refuse'
): string => {
  const targetKey = representationKey(target)
  const exact = union.arms
    .map((arm, index) => ({ arm, index }))
    .filter((entry) => representationKey(entry.arm.value) === targetKey)
    .map((entry) => ({ index: entry.index, text: `${text}.get<${entry.index}>()` }))
  // An arm that CONVERTS to the target answers too. An exact arm is the
  // cheapest answer for its own discriminant, but its existence cannot erase
  // a different live arm which is structurally assignable to the same target.
  // A regex-driven router exposed this: a truthy value is either `string[]` or
  // `RegExpMatchArray`; both are `Array<string>`, yet preferring the exact arm
  // emitted an unconditional `get<0>()` and crashed on a match-result arm.
  //
  // A method reading a boxed-or-optional cell is another converting case: the cell is
  // `dynamic | optional(record)` and the read is a
  // `native-record-ref`, so the live arm is the BOX and the load is the
  // unboxing check `unboxedLoadText` already renders. The narrowing that
  // licensed this load proved one arm is live; the discriminant chain below
  // then picks whichever it is, exactly as it does for several exact arms.
  // An arm the target lives INSIDE answers too, on the same terms as a
  // converting arm: `undefined | null | (string|number)` narrowed to `number`
  // reads the `present` arm and then narrows THAT, which is one more level than
  // an arm-key search can see. `narrowedUnionSubsetText` already recurses this
  // way for a sub-union target; this is the same step for a flat one, and it
  // terminates because each call strips one level of nesting.
  const candidates = union.arms.flatMap((arm, index) => {
    const found = exact.find((entry) => entry.index === index)
    if (found) return [found]
    const slot = `${text}.get<${index}>()`
    const converted = tryCandidateText(() => convertedValueText(arm.value, target, slot) ?? narrowedLoadText(arm.value, target, slot))
    return converted === null ? [] : [{ index, text: converted }]
  })
  const last = candidates[candidates.length - 1]
  // A union target that some arm only WIDENS into is a recast, not a
  // narrowing: the narrowing proved nothing about which arm is live, so every
  // arm needs its home or the read would rebuild a live arm as another.
  // Whatever the uncovered arm is: a class or a named record left without a
  // home is dropped just as surely as a structural one, and the chain then
  // reads the wrong arm's payload: an instance of one class handed to a
  // `ClassA | ClassB | { option? }` parameter, of which it is none of the
  // classes, was read as the first class.
  const partialWidening =
    target.kind === 'tagged-union' &&
    candidates.some((candidate) => !exact.includes(candidate)) &&
    union.arms.some((_, index) => !candidates.some((candidate) => candidate.index === index))
  if (unhomed === 'throw' && last && partialWidening) {
    // `CHECKED_ARM_NARROWING`: every arm without a home throws, checked by
    // its own discriminant, so none is ever read as another.
    const targetType = cppTypeOf(target)
    let result = `gea::host::unhomedUnionArm<${targetType}>(${text}.index())`
    for (const entry of [...candidates].reverse()) result = `${text}.is<${entry.index}>() ? ${entry.text} : (${result})`
    return `(${result})`
  }
  if (!last || partialWidening) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(union)}->${targetKey}`,
      `narrows tagged union "${representationKey(union)}" to "${targetKey}", which none of its arms carries`
    )
  }
  let result = last.text
  for (const entry of candidates.slice(0, -1).reverse()) {
    result = `${text}.is<${entry.index}>() ? ${entry.text} : (${result})`
  }
  return candidates.length > 1 ? `(${result})` : result
}

/**
 * A tagged union narrowed to a SUB-union -- fewer arms, not one flat arm.
 *
 * `taggedUnionArmText` above answers "narrowed to one specific representation";
 * this answers the sibling question control flow proves just as often: `h
 * instanceof Headers` inside `const h = init.headers` (a `Headers |
 * Record<string,string> | [string,string][]` cell) leaves the `else` branch
 * holding `Record<string,string> | [string,string][]` -- still a union, just
 * one arm short. Neither `narrowedLoadText`'s optional-of-union case nor
 * `taggedUnionArmText` covers it: the first is about presence, the second
 * searches for arms sharing the target's WHOLE C++ type, which no single arm
 * of a genuinely narrower union has.
 *
 * Every one of the narrower union's arms must have a same-shaped home among
 * the wider union's arms (matched by `representationKey`, not by C++ type
 * alone -- two structurally different arms can still share a C++ type, and
 * conflating them would silently pick the wrong one) -- `null` otherwise,
 * which is a real hole rather than a missing recipe. Each live arm rebuilds at
 * its NEW index with `TaggedUnion<...>::ofArm<Index>`, the identical
 * materializer a value narrowed into a fresh union already uses (`conversions.
 * ts`'s widening/recasting entries) -- this is that same construction, tested
 * over the WIDER union's own discriminant instead of over a single known
 * value.
 */
const narrowedUnionSubsetText = (
  inner: Extract<Representation, { kind: 'tagged-union' }>,
  read: Extract<Representation, { kind: 'tagged-union' }>,
  text: string
): string | null => {
  const pairs: { readonly heldIndex: number; readonly targetIndex: number; readonly load: string | null }[] = []
  for (const [targetIndex, arm] of read.arms.entries()) {
    const heldIndex = inner.arms.findIndex((candidate) => representationKey(candidate.value) === representationKey(arm.value))
    if (heldIndex >= 0) {
      pairs.push({ heldIndex, targetIndex, load: null })
      continue
    }
    // An arm the held arm NARROWS INTO, rather than one it equals. A narrowing
    // does not stop at the top: `typeof x === 'string'` in the else branch of
    // `BodyInit | null | undefined` leaves the same three-arm outer shape with
    // a smaller inner union in its `present` arm, and matching arms by key
    // alone reads that as a union with no such arm at all. Asking this same
    // function one level in is what makes the outer match, and it terminates
    // because each step strips one level of nesting.
    const nested = inner.arms
      .map((candidate, index) => ({
        index,
        load: tryCandidateText(() => narrowedLoadText(candidate.value, arm.value, `${text}.get<${index}>()`))
      }))
      .find((entry) => entry.load !== null)
    if (!nested?.load) return null
    pairs.push({ heldIndex: nested.index, targetIndex, load: nested.load })
  }
  const last = pairs[pairs.length - 1]
  if (!last) return null
  // THE HELD INDEX IS THE DISCRIMINANT, so two target arms may not share one.
  //
  // The chain below tests `text.is<heldIndex>()` to pick a target arm, which is
  // only a discriminant while each target arm comes from a DIFFERENT held arm.
  // Exact homes always do -- two distinct arm keys cannot both equal one arm's
  // -- but the nested search above can land several target arms on the same
  // held arm, and then the first test wins every time: `string | number |
  // boolean | null | undefined` narrowed past its two absences resolved all
  // three of `string`, `number` and `boolean` to held arm 2 (the nested
  // `present` union), and the emitted chain read `is<2>() ? ofArm<0>(...) :
  // (is<2>() ? ofArm<1>(...) : ...)`, which always answered `string`. It
  // compiled, certified, and printed `string:` for the number 7.
  //
  // When they collide, the read does not live across the arms at all -- it
  // lives INSIDE one, and the whole narrowing is that one arm's own, one level
  // down, where its own discriminant is in scope. That recursion is the answer;
  // anything left over refuses rather than emitting a chain whose test cannot
  // decide.
  const collides = new Set(pairs.map((pair) => pair.heldIndex)).size !== pairs.length
  if (collides) {
    for (const [index, candidate] of inner.arms.entries()) {
      const slot = `${text}.get<${index}>()`
      // `narrowedLoadText` answers `null` for "nothing to load", which for an
      // arm that already carries exactly the read IS the answer: the arm's own
      // value. Asked as an equality first so that `null` is never mistaken for
      // "this arm cannot".
      if (representationKey(candidate.value) === representationKey(read)) return slot
      // Only an arm that is itself a sum can hold the whole read. A plain
      // member "loads" into the read by widening, and taking it would rebuild
      // every live arm as that one: `Promise<{done: true} | {done: false,
      // value: Uint8Array}>` into its `value: unknown` twin read `.get<0>()`
      // with the chunk arm live.
      if (candidate.value.kind !== 'tagged-union' && candidate.value.kind !== 'optional') continue
      const load = narrowedLoadText(candidate.value, read, slot)
      if (load !== null) return load
    }
    return null
  }
  // The same one-time binding `recastedUnionText` makes, for the same reason:
  // this chain is what a NESTED union arm reaches through (`homeOf` there
  // asks `convertedValueText`, which lands here for an inner union narrowed
  // one level down), and it spelled the ~1.3KB target type and the source
  // expression once per arm -- 928 inner spellings on one emitted line after
  // the outer recast alone was bound. A single-pair chain keeps the direct
  // spelling: there is nothing to share.
  const multiPair = pairs.length > 1
  const boundText = multiPair ? recastUnionSourceName : text
  const targetType = multiPair ? recastUnionAliasName : cppTypeOf(read)
  const armText = (pair: { readonly heldIndex: number; readonly targetIndex: number; readonly load: string | null }): string =>
    `${targetType}::ofArm<${pair.targetIndex}>(${pair.load ?? `${boundText}.get<${pair.heldIndex}>()`})`
  let result = armText(last)
  for (const pair of pairs.slice(0, -1).reverse()) {
    result = `${boundText}.is<${pair.heldIndex}>() ? ${armText(pair)} : (${result})`
  }
  if (!multiPair) return result
  // The source arrives as the lambda's PARAMETER, spelled with its own type
  // (an `auto` parameter makes every `.is<k>()` a dependent template name),
  // never as a `const auto&` declared in its body: a nested chain's `text` is the outer chain's own
  // `gea_recast_source.get<2>()`, and a body-local of the same name would be
  // in scope from its own declarator, so the initializer would read the
  // uninitialized inner binding instead of the outer one. An argument is
  // evaluated in the caller's scope, where the outer name is the live one.
  return (
    `([&](const ${cppTypeOf(inner)}& ${recastUnionSourceName}) -> ${cppTypeOf(read)} { using ${recastUnionAliasName} = ${cppTypeOf(read)}; ` +
    `return ${result}; }(${text}))`
  )
}

/**
 * The load a narrowing licenses, or `null` when the two carriers are the same
 * and there is nothing to load.
 *
 * Returning `null` for "no narrowing needed" and throwing for "no narrowing
 * possible" keeps the two apart: the first is the ordinary case, the second is
 * a program this compiler already knows is wrong.
 */
export const narrowedLoadText = (held: Representation, read: Representation, text: string): string | null => {
  if (representationKey(held) === representationKey(read)) return null
  // No guard the checker proved can have ruled a proxy arm out; the census
  // refuses the pair (`proxyArmWithoutHome`), and so does every printer path.
  if (proxyArmWithoutHome(held, read)) return null
  const remappedSet = genericFunctionSetWideningText(held, read, text)
  if (remappedSet !== null) return remappedSet
  // Two structural views of one host facade still hold the same native value.
  // `Buffer` and `Uint8Array` expose different TypeScript member sets while
  // both map to the host's one BufferFacade C++ type. Equal native identity,
  // ownership, and physical type prove this is an alias-preserving read.
  if (
    held.kind === 'native-record-ref' &&
    read.kind === 'native-record-ref' &&
    held.native !== null &&
    held.native === read.native &&
    held.ownership === read.ownership &&
    samePhysicalCarrier(held, read)
  )
    return text
  const unwrapped = held.kind === 'optional' ? `(*${text})` : text
  const inner = held.kind === 'optional' ? held.payload : held
  if (representationKey(inner) === representationKey(read)) return unwrapped
  // The same array read as the interface that extends it (`elements` of
  // `readonly T[] | undefined`, proven present and then type-guarded): one
  // C++ type either way -- the fields an extension adds live beside the
  // elements -- so the load is the payload itself, exactly as
  // `conversions.ts`'s `gea::ArrayObject::identity` recast states for the
  // bare pair.
  if (sameArrayUpToExtension(inner, read)) return unwrapped
  // The guard proved the cell ABSENT: `if ( dstArray === null )` and every read
  // inside that branch. There is nothing in the cell to load -- the read's
  // carrier has one inhabitant -- so this produces the constant, and must be
  // asked BEFORE the arm search below, which answers `null` ("nothing to
  // narrow") for this pair and would let the caller emit the whole
  // `gea::Optional<T>` where a `std::nullptr_t` is declared.
  if (held.kind === 'optional' && read.kind === held.absence) return read.kind === 'null' ? 'nullptr' : cppUndefinedValue
  // A shared class reference carries its own absence (a null handle): the same proof, the same constant.
  if (held.kind === 'class-ref' && held.ownership === 'shared-refcount' && read.kind === 'null') return 'nullptr'
  // Reading a cell as `dynamic` is not a narrowing at all -- it is the box, and
  // the box accepts every carrier. Answered by the widening this file already
  // owns rather than by searching the arms for a `dynamic` one, which no union
  // has: a sum's arms are the declared types, and `any` is not one of them.
  // Without this, a `string | symbol` cell read into an `unknown` parameter
  // refused with "narrows a tagged union to dynamic, which none of its arms
  // carries" -- an accurate sentence about the wrong question.
  //
  // The HELD carrier goes in whole, never `inner`/`unwrapped`: an optional
  // read as `any` still has its presence to state, and `widenedStoreText`'s
  // dynamic branch owns that (`has_value() ? box(payload) : box(absence)`).
  // Handing it the unwrapped payload boxed `(*cell)` unconditionally, so a
  // `number | null` holding `null` reached an `...args: any[]` listener as
  // `Tag::Number` over whatever the dereference found -- an event reporting
  // `code=null` reported `code=0`. Certified, compiled, wrong.
  if (read.kind === 'dynamic') return widenedStoreText(read, held, text)
  // And the mirror: a cell the program declared `any` read at a place the
  // checker narrowed. `if (a instanceof Error) throw a` reads the same cell as
  // an Error record, and that read is the box's tag-and-payload-type check --
  // the narrowing's claim ENFORCED, not assumed. A union's arm search below
  // cannot answer it, because a box has no arms.
  if (inner.kind === 'dynamic') return unboxedLoadText(read, unwrapped)
  // Presence narrowing and class widening can happen in the same read. A
  // guarded `Derived | undefined` passed to a `Base` parameter is physically
  // the present `Derived` handle followed by Ref's ordinary upcast. Keeping
  // those as one recipe matters because the exact-payload check above only
  // answers `T | undefined -> T`; it cannot answer a different base carrier.
  //
  // This direction is a store-style widening, so it is proved from the
  // source's ancestry. The downcast immediately below proves the inverse
  // direction from the target's ancestry and remains the checked narrowing.
  if (
    (inner.kind === 'class-ref' &&
      read.kind === 'class-ref' &&
      inner.ownership === read.ownership &&
      inner.ancestors.includes(read.declaration)) ||
    nativeRecordBaseTransportKind(inner, read) === 'upcast'
  ) {
    return `${cppTypeOf(read)}(${unwrapped})`
  }
  // A program-class handle read at a DERIVED class -- `node instanceof Derived`
  // then `node.derivedField = true` on a callback parameter typed as the base.
  // `gea::Ref<Base>` and `gea::Ref<Derived>` are different C++ types, so the
  // narrowed read needs a cast even though nothing about the object changes:
  // `downcastClassRef` (gea_runtime.h) is `staticCast` plus the one thing this
  // call site can be wrong about on its own, a `static_assert` that `Derived`
  // really descends from `Base`.
  //
  // Only ever the DOWNCAST direction, and it is CHECKED here rather than left
  // to the `static_assert`: this function is also the arm search
  // `narrowedUnionSubsetText` runs over EVERY arm of a union looking for a
  // home, so answering a downcast for two unrelated classes would put a text
  // that cannot compile into a branch the dispatch never takes. The carrier
  // states its own ancestry (`Representation`'s `class-ref`), so the question
  // is answerable without a policy to thread. A read at an ANCESTOR is a
  // widening and `widenedStoreText` answers it with `Ref`'s own converting
  // constructor. Ownership must agree -- a handle and a by-value struct of the
  // same class are different physical things, not a heritage question.
  if (
    read.kind === 'class-ref' &&
    ((inner.kind === 'class-ref' && inner.ownership === read.ownership && read.ancestors.includes(inner.declaration)) ||
      nativeRecordBaseTransportKind(inner, read) === 'downcast')
  ) {
    return `gea::host::downcastClassRef<${cppClassName(read.declaration)}>(${unwrapped})`
  }
  // A cell that provably holds nothing but absence, read at a place declared
  // wider. A parameter typed `env: E['Bindings']` -- an indexed access
  // through a type parameter's constraint that this program never instantiates
  // -- so its cell is placed `undefined` while every read of it is the declared
  // optional. A read cannot be narrower than the cell here; it is a widening,
  // and the store direction already knows the answer is the empty optional.
  if ((inner.kind === 'undefined' || inner.kind === 'null') && read.kind === 'optional' && read.absence === inner.kind) {
    return widenedStoreText(read, inner, unwrapped)
  }
  if (inner.kind !== 'tagged-union') return null
  // Every arm search below SELECTS: it loads the arm the read names and
  // trusts the narrowing that licensed the load to have killed the rest. A
  // store into a declared slot has no such licence -- `const ctx:
  // SomeInterface | null = Ctor ? new Ctor() : createOther()`
  // converts a `record | class` into the interface's record, and the class
  // arm is as live as the record's. This chain cannot tell the two apart (a
  // class viewed as a record needs the program's layouts), so the census
  // decides it: a pair some arm reaches only through the structural view is
  // `conversion/record-view.ts`'s `dispatch` plan, installed and rendered
  // ahead of this chain (`conversions.ts`'s `staticRecipe`, `recipeText`).
  // A join may preserve another join (or an optional) as one physical arm.
  // Search that nested carrier before trying to compare the outer arm list
  // with the read's list. Otherwise a read of the preserved inner union is
  // mistaken for a sub-union assembled from several OUTER arms, and a read of
  // an absence carried inside an optional arm is reported as having no arm at
  // all. Control-flow narrowing already proves the selected leaf is live; the
  // recursion below only renders the required sequence of `get`/`*` loads.
  const nested = nestedArmLoadText(inner, read, unwrapped)
  if (nested !== null) return nested
  // A read that is still optional narrowed the arm without proving presence, so
  // the presence test survives into the load: absent stays absent, and present
  // reads the arm the narrowing named. The empty branch is a default-constructed
  // optional rather than a copy of the cell, because the cell's optional holds
  // the wrong payload type by construction -- that is the whole difference this
  // load exists to express.
  if (held.kind === 'optional' && read.kind === 'optional') {
    const narrowed = cppTypeOf(read)
    // The payload itself can still be a sub-union -- `if (x !== undefined &&
    // typeof x !== 'number')` proves both presence and one excluded arm in a
    // single guard, leaving `T | U | undefined` narrowed to `T | U`, still
    // wrapped in the same optional. `taggedUnionArmText` searches for one arm
    // whose WHOLE representation matches the target and has nothing to find
    // when the target is a sub-union rather than a flat arm.
    const armText =
      read.payload.kind === 'tagged-union'
        ? (narrowedUnionSubsetText(inner, read.payload, unwrapped) ?? recastedUnionText(inner, read.payload, unwrapped))
        : taggedUnionArmText(inner, read.payload, unwrapped)
    if (armText === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(inner)}->${representationKey(read.payload)}`,
        `narrows an optional tagged union carrying "${representationKey(inner)}" to "${representationKey(read.payload)}", ` +
          'which none of its arms carries'
      )
    }
    return `(${text}.has_value() ? ${narrowed}(${armText}) : ${narrowed}())`
  }
  // A union read as an OPTIONAL: the read spends absence on one flag where the
  // union spends it on an arm. `f(x: T | null = null)`'s body binds `T | null`
  // while its slot is `T | null | undefined`, so every such body does this
  // once, at the merge that chose between the argument and the default.
  //
  // The arms not named here are proven dead by the narrowing that licensed
  // this load -- the same proof every other branch of this function reads
  // rather than re-derives.
  if (read.kind === 'optional') {
    const absentIndex = inner.arms.findIndex((arm) => arm.value.kind === read.absence)
    if (absentIndex >= 0) {
      const narrowed = cppTypeOf(read)
      // The absent arm is tested first, so it never needs a home in the
      // payload. Searching with `refuse` counted it as an unhomed arm of a
      // union payload and refused, and the chain fell through to
      // `optional-wrap-converted`, which loaded the present arm into a PRESENT
      // optional unconditionally: `describe(holder.image)` over `A | B |
      // undefined` passed into `A | B | C | null | undefined` read the
      // undefined arm as the present union. Any other unhomed arm is proven
      // dead by the narrowing that licensed this load, and is checked.
      return `(${unwrapped}.is<${absentIndex}>() ? ${narrowed}() : ${narrowed}(${taggedUnionArmText(inner, read.payload, unwrapped, 'throw')}))`
    }
    // No arm is the bare absent literal, because absence lives INSIDE another
    // arm's own optional. A middleware composer binds `let handler` to a
    // `Function | (Next | undefined)` cell and reads it back as `Function |
    // undefined`: the union's arms are the record and an
    // `optional(callable)`, and the read's payload is the record alone.
    //
    // So the payload's own arm is the whole test: live means present, and
    // every other arm is absence -- the arms not named here being proven dead
    // by the narrowing that licensed this load, the same proof the branch
    // above reads rather than re-derives.
    const payloadIndex = inner.arms.findIndex((arm) => representationKey(arm.value) === representationKey(read.payload))
    if (payloadIndex >= 0) {
      const narrowed = cppTypeOf(read)
      return `(${unwrapped}.is<${payloadIndex}>() ? ${narrowed}(${unwrapped}.get<${payloadIndex}>()) : ${narrowed}())`
    }
  }
  // The narrower-union case: `read` is still a union, just missing one or more
  // of `inner`'s arms (proven dead by the narrowing that licensed this load),
  // rather than one flat representation `taggedUnionArmText` below can search
  // for. `narrowedUnionSubsetText` covers both the plain case (`inner` held no
  // optional to begin with) and the presence-plus-arm-narrowing case just
  // handled above falling through here when `read` itself is not `optional`
  // (a destructured element proven both present and narrowed in one step).
  if (read.kind === 'tagged-union') {
    const subset = narrowedUnionSubsetText(inner, read, unwrapped)
    if (subset !== null) return subset
    // And the other direction: a read WIDER than the cell. A narrowing does not
    // only ever shrink a union -- the cell's placement is the union of what the
    // program writes to it, and a read's carrier is the declared type at that
    // site, so a cell every writer narrows still gets read at its full declared
    // width. A response-building method is the case: the cell holds
    // `Response | ResponseInit` and the read wants
    // `StatusCode | Response | ResponseInit`. Every arm the cell can hold is an
    // arm of the read, which is exactly what `recastedUnionText` proves, and
    // the arms the read has and the cell does not are simply never live.
    const widened = recastedUnionText(inner, read, unwrapped)
    if (widened !== null) return widened
  }
  return taggedUnionArmText(inner, read, unwrapped)
}

/**
 * The load for a target that is an arm of an ARM.
 *
 * A join nests: `string | Blob | URLSearchParams | null | undefined` derives as
 * an outer union over the two absence arms and an inner union over the three
 * value arms, so narrowing it to `string` reads through two `get`s and not one.
 * `widenedStoreText` already walks exactly this nesting in the store direction
 * ("A join can nest", below); this is its mirror, and without it the load
 * refused with "narrows a tagged union to string, which none of its arms
 * carries" -- an accurate sentence about the outer union only.
 *
 * `typeof init.body === 'string'` over a nested `string | Blob | null |
 * undefined` body field is the case: it narrows to `string`.
 *
 * The discriminant is tested whenever more than one arm can answer, exactly as
 * `taggedUnionArmText` does for the flat case, and for the same reason: with
 * one candidate the narrowing already proved which arm is live, and a test with
 * no else has nothing to return.
 */
const nestedArmLoadText = (inner: Extract<Representation, { kind: 'tagged-union' }>, read: Representation, text: string): string | null => {
  const readKey = representationKey(read)
  const nestedLoad = (held: Representation, at: string): string | null => {
    if (representationKey(held) === readKey) return at
    // A leaf can satisfy a wider nested read through a real carrier
    // conversion. A regex-driven router reads an optional `Array<string>` from
    // an optional union whose leaves are `string[]` and `RegExpMatchArray`:
    // neither leaf equals the OPTIONAL target, but both convert to it. Looking
    // only for exact nested keys found the first leaf and emitted its `get`
    // unconditionally, crashing when the second discriminant was live.
    if (held.kind !== 'optional' && held.kind !== 'tagged-union') {
      const converted = tryCandidateText(() => convertedValueText(held, read, at))
      if (converted !== null) return converted
    }
    if (held.kind === 'optional') {
      if (read.kind === held.absence) return read.kind === 'null' ? 'nullptr' : cppUndefinedValue
      if (read.kind === 'optional' && read.absence === held.absence) {
        const payload = nestedLoad(held.payload, `(*${at})`)
        if (payload === null) return null
        const targetType = cppTypeOf(read)
        return `(${at}.has_value() ? ${targetType}(${payload}) : ${targetType}())`
      }
      return nestedLoad(held.payload, `(*${at})`)
    }
    if (held.kind !== 'tagged-union') return null
    if (read.kind === 'tagged-union') {
      const narrowed = tryCandidateText(() => narrowedUnionSubsetText(held, read, at))
      if (narrowed !== null) return narrowed
    }
    const candidates = held.arms.flatMap((arm, index) => {
      const loaded = nestedLoad(arm.value, `${at}.get<${index}>()`)
      return loaded === null ? [] : [{ index, loaded }]
    })
    const last = candidates[candidates.length - 1]
    if (!last) return null
    let dispatched = last.loaded
    for (const candidate of candidates.slice(0, -1).reverse()) {
      dispatched = `${at}.is<${candidate.index}>() ? ${candidate.loaded} : (${dispatched})`
    }
    return candidates.length > 1 ? `(${dispatched})` : dispatched
  }
  const candidates: { readonly index: number; readonly text: string }[] = []
  let converted = false
  for (const [index, arm] of inner.arms.entries()) {
    const armText = `${text}.get<${index}>()`
    const load = nestedLoad(arm.value, armText)
    if (load === null) continue
    candidates.push({ index, text: load })
    if (arm.value.kind !== 'optional' && arm.value.kind !== 'tagged-union' && representationKey(arm.value) !== readKey) converted = true
  }
  const last = candidates[candidates.length - 1]
  if (!last) return null
  // A flat arm that only CONVERTS into the read proves nothing about which arm
  // is live, so dispatching on it is sound only when every arm has a home: a
  // `{done: true} | {done: false, value: Uint8Array}` cell read as its
  // `value: unknown` twin found a home for the first arm alone and read it
  // unconditionally, with the chunk arm live.
  if (converted && candidates.length !== inner.arms.length) return null
  let result = last.text
  for (const candidate of candidates.slice(0, -1).reverse()) {
    result = `${text}.is<${candidate.index}>() ? ${candidate.text} : (${result})`
  }
  return candidates.length > 1 ? `(${result})` : result
}

/**
 * The store a widening needs, or `null` when the value can be assigned as it
 * stands.
 *
 * This is the mirror of `narrowedLoadText` and it exists for the same reason:
 * `const x: string | number = 3` puts a `double` into a `TaggedUnion`, and the
 * language really does widen there -- the union is the declared carrier and the
 * initializer is one arm of it.
 *
 * `gea::Optional<T>` needs nothing: it declares a converting assignment from
 * `T`, so a present value assigns straight in and the presence flag follows.
 * `gea::TaggedUnion` deliberately declares no such thing, because there is no
 * one answer -- two arms can share a C++ type, and an implicit conversion would
 * have to pick one silently. `ofArm<Index>` is where that choice is stated, and
 * the index is the arm's position in the checker's own order, the same order
 * the load reads back.
 *
 * The first arm carrying the written carrier is the one chosen. When several
 * do, they are indistinguishable at runtime by construction -- the load
 * dispatches over exactly that set and reads the same C++ type from any of them
 * -- so the choice is not observable. What would be observable is choosing an
 * arm that does *not* carry it, which is what returning `null` prevents.
 */
/**
 * The `gea::Value::Tag` a concrete representation boxes under when it is
 * written into a `dynamic` cell -- the widening direction `conversion/
 * derive.ts`'s narrowing-only algebra has no answer for (see citations.md
 * finding 1). `null` for a carrier this compiler does not yet box (a
 * container, a proxy, an existing `dynamic` itself, which the
 * `representationKey` equality check above already short-circuits): an
 * omission to extend deliberately later, not to guess at here.
 *
 * Exported so `targets/cpp/conversions.ts`'s `widening` registry entry can
 * ask the identical question when the conversion graph -- not just a
 * `convert` this function already renders -- needs to know whether boxing a
 * given carrier is a real, installed capability. One answer, asked from both
 * the preflight authority and the emission authority, rather than a second
 * table naming the same tags that could drift from this one.
 */
export const dynamicTagFor = (representation: Representation): string | null => {
  switch (representation.kind) {
    case 'null':
      return 'Null'
    case 'undefined':
      return 'Undefined'
    case 'string':
      return 'String'
    // `gea::Symbol` is an id, and `Value::Tag` has a state for it. Missing here
    // rather than deliberately absent: every `symbol`-carrying union refused to
    // box at all, which is what `EventName = string | symbol` -- node's own
    // event-name type -- is made of.
    case 'symbol':
      return 'Symbol'
    case 'scalar':
      return representation.domain === 'boolean' ? 'Boolean' : representation.domain === 'bigint' ? 'BigInt' : 'Number'
    case 'class-ref':
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'native-handle':
    case 'array-object':
    case 'dictionary':
    // A source-declared any/unknown boundary retains the collection's native
    // handle, including its key/value types and object identity.
    case 'keyed-collection':
    // ECMA-262 25.1's `ArrayBuffer` is a JS Object exactly like the typed
    // array below it -- `typeof` answers `"object"`, `cppTypeOf` already
    // spells it `gea::Ref<gea::ArrayBuffer>` (`gea::ArrayBuffer` being the
    // one monomorphic `std::vector<std::uint8_t>` alias, so there is only
    // ever one payload address to record, never one per element domain the
    // way `typed-array` needs). `Value::box` records that address as
    // `payloadType()` the identical way it does for every other `Ref<...>`
    // in this list. Missing here meant an `ArrayBuffer` value -- a
    // request-body data union carries one -- could never widen
    // into a `dynamic` cell, the same silent gap `typed-array`'s own
    // addition just above closed for typed arrays, blocking both this
    // widen and the reverse read (`unboxedLoadText`, below) for the
    // identical reason.
    case 'array-buffer':
    case 'shared-array-buffer':
    // A `gea::TypedArray<T>` is a JS Object like the rest of this list --
    // ECMA-262 typeof answers `"object"` for it too (`emit-typeof.ts`'s
    // `objectLike`) -- and it boxes the identical way: `cppTypeOf` already
    // spells it `gea::Ref<gea::TypedArray<T>>`, so `Value::box` records that
    // exact C++ type's address as `payloadType()`, one program-wide address
    // per element domain. That per-type address is also what
    // `gea::host::instanceOfTypedArray<T>` (gea_runtime.h) reads back to
    // answer `x instanceof Uint16Array` on a boxed value -- the SAME
    // primitive `instanceOfError` above already uses for the error family,
    // asked of a typed array's own payload type instead of a registration
    // table, because a typed array's C++ type already IS its constructor
    // identity with no subclass to reconcile.
    //
    // Missing here meant a typed-array value could never widen into a
    // `dynamic` cell at all: `emit-instanceof.ts`'s boxed
    // `x instanceof Uint16Array` test has a real box to read only once a
    // typed array can actually get INTO one, and this is the one place that
    // decides that. The same gap silently blocked the reverse read
    // (`unboxedLoadText`, below) and the "typed-array -> dynamic" merge
    // widenings `targets/cpp/conversions.ts`'s `widening` registry asks this
    // exact function about.
    case 'typed-array':
    // A DataView is the third ArrayBuffer view kind and boxes the same way:
    // `gea::Ref<gea::DataView>` is one monomorphic payload address, which
    // `gea::host::isArrayBufferView` and `instanceOfDataView` already read
    // back. Missing here left `unknown`-held DataViews unrepresentable in a
    // box, and the reverse read an `instanceof DataView` guard narrows to.
    case 'data-view':
      return 'Object'
    // A `gea::Promise<T>` is a JS Object too -- `typeof new Promise(...) ===
    // 'object'` -- and `Value::box` needs nothing case-specific to hold one:
    // the template already records `payloadTypeTagFor<gea::Promise<T>>()` for
    // whichever `T` this instantiation closes over, one program-wide address
    // per payload type, exactly as it does for every other kind sharing this
    // tag. Missing here meant a value returned from a plain (non-async)
    // function -- a body cache's `return (bodyCache[k] as Promise<BodyInit>)
    // .then(...)`, whose OWN inferred return type is a
    // real `Promise<unknown>` folding to `dynamic` only because its sibling
    // return arm reads a program-declared `any` -- could never widen into a
    // `dynamic` cell at all: `emit-narrowing.ts`'s own generic `held.kind ===
    // 'dynamic'` store (below) and `targets/cpp/conversions.ts`'s `widening`
    // registry both ask this exact function, and both got `null` for a
    // pairing this runtime already has every primitive to satisfy.
    case 'promise':
      return 'Object'
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'generic-function-set':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      return 'Function'
    default:
      return null
  }
}

/**
 * The empty optional, when what is being stored is the absence the cell's own
 * presence flag stands for.
 *
 * This is the one store the payload cannot state, which is why the recursion
 * below has a second half. `gea::Optional<T>` is a presence flag plus a `T`;
 * an absence is neither a `T` nor an arm of one, so asking the payload how to
 * hold it gets no answer -- and the answer that comes back, `null`, is read by
 * every caller as "assign as it stands" and renders `cell = nullptr`. For
 * `Optional<double>` that is a clang error. For `Optional<std::string>` it is
 * worse: `std::string`'s own `const char*` constructor makes
 * `Optional::operator=(T&&)` viable, so the cell comes out *present*, holding
 * a string built from a null pointer, and every later presence test answers the
 * opposite of the truth with nothing to say it did.
 *
 * Which absence the cell holds is checked rather than assumed -- an optional
 * tagged `null` handed an `undefined` would answer a later `=== null` with
 * `true`, and that is a wrong answer, not a spelling gap -- which is the rule
 * `convertedValueText` used to keep as its own private copy, now stated once
 * here, where every store site already asks.
 */
const emptyOptionalText = (held: Extract<Representation, { kind: 'optional' }>, written: Representation): string | null => {
  if (written.kind !== 'null' && written.kind !== 'undefined') return null
  return written.kind === held.absence ? `${cppTypeOf(held)}()` : null
}

/**
 * The empty handle, when what is being stored is the absence the handle's own
 * invalid state stands for.
 *
 * The same store `emptyOptionalText` describes, for the carrier that took the
 * `Optional`'s place. `representation/optional.ts` collapses `T | null` onto a
 * host handle because a handle already carries its absence -- `NativeHandle`
 * default-constructs to `id_ = -1` and `valid()` is `id_ >= 0` -- so the cell
 * that used to be an `Optional<Element>` holding nothing is now an `Element`
 * naming nothing. Without this the `null` assigns as it stands and renders
 * `handle = nullptr`, which is the clang error the optional case above exists
 * to prevent, one carrier along.
 *
 * `null` only, matching the collapse exactly: `optionalOf` keeps the presence
 * flag for `undefined`, so a handle carrier is never the destination of one.
 */
const emptyHandleText = (held: Extract<Representation, { kind: 'native-handle' }>, written: Representation): string | null =>
  written.kind === 'null' ? `${cppTypeOf(held)}()` : null

/**
 * The parameter index a callable's trailing arguments pack into, or `null` for
 * a fixed-arity convention or a carrier that is not a callable at all.
 */
const restFromOf = (representation: Representation): number | null => {
  if (representation.kind === 'function' || representation.kind === 'function-value-dispatch') return representation.abi.restFrom
  if (representation.kind === 'function-family' || representation.kind === 'function-value-family') return representation.abi.restFrom
  if (representation.kind === 'function-and-constructor') return representation.call.restFrom
  return null
}

/**
 * One value, boxed.
 *
 * A CALLABLE with a rest parameter takes the ABI-stating form: which formal
 * absorbs the trailing arguments is invisible in the C++ type -- `(a, xs: T[])`
 * and `(a, ...xs: T[])` are the same `CallableObject` -- so a dynamic call
 * through the box would hand the first trailing argument to a slot expecting
 * the packed array (10.2.11 binds a rest parameter to an Array of ALL the
 * remaining ones). The emitter is the only reader of the ABI, so it states the
 * position here and `gea::Value::boxCallable` records the matching thunk.
 * A method table built as `this[method] = (args1, ...args) => ...` makes
 * every call through it such a call.
 */
export const boxedText = (representation: Representation, tag: string, text: string): string => {
  const restFrom = restFromOf(representation)
  const value = `static_cast<${cppTypeOf(representation)}>(${text})`
  const abi = representation.kind === 'function-and-constructor' ? representation.call : 'abi' in representation ? representation.abi : null
  if (abi?.receiver) return `gea::Value::boxMethod<${restFrom === null ? -1 : restFrom + 1}, ${abi.argumentsFrame === 'actual'}>(${value})`
  if (restFrom === null) return `gea::Value::box(gea::Value::Tag::${tag}, ${value})`
  return `gea::Value::boxCallable<${restFrom}, ${abi?.argumentsFrame === 'actual'}>(${value})`
}

/**
 * How a native carrier boxes into a dynamic cell, rendered over an arbitrary
 * text naming the storage.
 *
 * The dynamic reason is stated HERE rather than at each caller because it is
 * not a choice: `widenedStoreText` records below that no `DynamicReason` is
 * consulted on this edge -- every boundary a reason names admits any concrete
 * value the checker lets reach it -- so a caller asking "box this carrier"
 * asks this one question and must not be free to spell a different reason for
 * it.
 *
 * `storage` is a TEXT, not a member. The recipe is a function of the
 * representation and that text alone: no field key, no struct name, no
 * surrounding statement. So two fields spelling the same carrier spell the
 * same recipe, and the native field table's read hook can render an optional
 * or union carrier's arms ONCE over a slot its key chain selects into
 * (`records.ts`) instead of once per field. `null` is the renderer's own
 * answer that this carrier needs no widening at all.
 */
export const dynamicCarrierBoxText = (carrier: Representation, storage: string): string | null =>
  widenedStoreText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, carrier, storage)

/**
 * A `dynamic` value an async body returns, settled into its `Promise<V>`
 * result. The value may itself be a promise, which the return ADOPTS rather
 * than fulfils with (ECMA-262 27.2.1.3.2), so the choice is made at run time
 * by `gea::detail::promiseFromDynamic` -- the store-direction recipe below.
 */
export const dynamicPromiseAdoptionText = (
  result: Extract<Representation, { kind: 'promise' }>,
  text: string,
  layouts?: RecordLayoutPolicy
): string | null => {
  // A settled value read as a NAMED record is rebuilt from its layout, as a
  // plain `any -> T` read is (`dynamicNamedRecordText`): an async function
  // returns a call typed `any` -- holding a plain object -- from a body
  // declared `Promise<SomeResult>`,
  // and the layout-free load below would unbox it by identity only.
  if (layouts !== undefined && result.value.kind !== 'void') {
    const settledType = cppTypeOf(result.value)
    const settled = dynamicNamedRecordText(layouts, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, result.value, 'gea_settled')
    if (settled !== null)
      return `gea::detail::promiseFromDynamic<${settledType}>(${text}, [](const gea::Value& gea_settled) { return ${settledType}(${settled}); })`
  }
  return widenedStoreText(result, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, text)
}

/**
 * A `Map<K, U>` stored where `ReadonlyMap<K, V>` is declared, `U` narrower
 * than `V`: the SAME map, read through a view that widens each value it hands
 * out (`gea::mapReadOnlyView`). Never a copy -- a copy would lose every later
 * `set` on the source, which the read-only name observes in JavaScript.
 *
 * `null` unless the target is marked `readOnlyView`: a mutable `Map<K, V>`
 * target could be written through, and a view cannot store a `V` the
 * source's `U` does not admit. `null` too where the two value carriers are
 * one C++ type, which needs no view -- `same-cpp-type` shares the object as
 * it stands. The per-value widening is `convertedValueText`'s own answer for
 * `U -> V`, so the view widens exactly as any other store of a `U` into a `V`.
 */
export const readOnlyMapViewText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'keyed-collection' || target.kind !== 'keyed-collection') return null
  if (source.family !== 'map' || target.family !== 'map' || target.readOnlyView !== true) return null
  if (source.recursive !== undefined || target.recursive !== undefined) return null
  if (source.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return null
  if (source.value === null || target.value === null) return null
  if (representationKey(source.key) !== representationKey(target.key)) return null
  const from = cppTypeOf(source.value)
  const to = cppTypeOf(target.value)
  if (from === to) return null
  const widened = tryCandidateText(() => convertedValueText(source.value!, target.value!, 'gea_map_value'))
  if (widened === null) return null
  return `gea::mapReadOnlyView<${to}>(${text}, [](const ${from}& gea_map_value) -> ${to} { return ${widened}; })`
}

/** `readOnlyMapViewText` into its target's own home: the bare collection, an optional of it, or the union arm that is one. */
const readOnlyMapViewStoreText = (held: Representation, written: Representation, text: string): string | null => {
  if (written.kind !== 'keyed-collection') return null
  if (held.kind === 'optional') return readOnlyMapViewStoreText(held.payload, written, text)
  if (held.kind !== 'tagged-union') return readOnlyMapViewText(written, held, text)
  // An arm the written map already IS, or shares a C++ type with, is its
  // home as it stands (`widenedStoreText`); a view is only for the rest.
  if (held.arms.some((arm) => samePhysicalCarrier(arm.value, written))) return null
  for (const [armIndex, arm] of held.arms.entries()) {
    const inner = readOnlyMapViewStoreText(arm.value, written, text)
    if (inner !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${inner})`
  }
  return null
}

/**
 * A typed `Map<K, V>` stored where a union holding `Map<unknown, unknown>` --
 * and no arm of the written map's own C++ type -- is declared: the SAME map,
 * boxed and read back through `unboxDynamicMap`'s `DynamicMapSource` view.
 * A serializer taking `object: Document` walks such a parameter under
 * `object instanceof Map`, so a copy would be a different object and would
 * miss every later `set` (a `Map` subclass that keeps writing after the hand-off).
 */
const dynamicMapArmViewStoreText = (held: Representation, written: Representation, text: string): string | null => {
  if (written.kind !== 'keyed-collection' || written.family !== 'map' || written.ownership !== 'shared-refcount') return null
  if (written.recursive !== undefined || written.value === null) return null
  if (held.kind !== 'tagged-union') return null
  if (held.arms.some((arm) => samePhysicalCarrier(arm.value, written))) return null
  for (const [armIndex, arm] of held.arms.entries()) {
    const target = arm.value
    if (target.kind !== 'keyed-collection' || target.family !== 'map' || target.ownership !== 'shared-refcount') continue
    if (target.recursive !== undefined || target.readOnlyView === true) continue
    if (target.key.kind !== 'dynamic' || target.value?.kind !== 'dynamic') continue
    const view = `gea::detail::unboxDynamicMap(gea::Value::box(gea::Value::Tag::Object, ${text}), ${cppStringLiteral(assertionSite(target))})`
    return `${cppTypeOf(held)}::ofArm<${armIndex}>(${view})`
  }
  return null
}

/** `renderedWidenedStoreText` with its source evaluated once -- see `evaluated-once.ts`. */
export const widenedStoreText = (held: Representation, written: Representation, text: string): string | null =>
  evaluatedOnceText(text, (operand) => renderedWidenedStoreText(held, written, operand))

const renderedWidenedStoreText = (held: Representation, written: Representation, text: string): string | null => {
  if (representationKey(held) === representationKey(written)) return null
  const remappedSet = genericFunctionSetWideningText(written, held, text)
  if (remappedSet !== null) return remappedSet
  // An optional over a union widens twice: the arm becomes the union, and the
  // union assigns into the optional through its converting assignment. Asking
  // recursively is what keeps the two steps from being two separate rules.
  //
  // The payload is asked first and the absence answers only what it leaves
  // unanswered. A payload that really does carry an arm of the written carrier
  // -- an absence arm included -- is that value's own home, and storing the
  // empty optional instead would drop a live value rather than record it.
  if (held.kind === 'optional') return widenedStoreText(held.payload, written, text) ?? emptyOptionalText(held, written)
  if (held.kind === 'native-handle') return emptyHandleText(held, written)
  // The same store once more, for the program's own refcounted instances:
  // `optional.ts` collapses `TreeNode | null` onto `gea::Ref<TreeNode>`, whose
  // default construction IS that `null`. Without this the literal assigns as it
  // stands and renders `left = nullptr`, which `Ref` does not accept.
  if (held.kind === 'class-ref' && held.ownership === 'shared-refcount' && written.kind === 'null') return `${cppTypeOf(held)}()`
  // A dynamic value returned where `Promise<T>` is declared may itself be a
  // promise -- an async method returning an `any`-typed call that yields one
  // -- and an async function's return adopts it (ECMA-262 27.2.1.3.2) rather
  // than fulfilling with the promise object.
  if (held.kind === 'promise' && written.kind === 'dynamic') {
    if (held.value.kind === 'void') return `gea::detail::promiseFromDynamic<void>(${text})`
    const settled = tryCandidateText(() => convertedValueText(written, held.value, 'gea_settled'))
    if (settled === null) return null
    return `gea::detail::promiseFromDynamic<${cppTypeOf(held.value)}>(${text}, [](const gea::Value& gea_settled) { return ${cppTypeOf(held.value)}(${settled}); })`
  }
  // A held `Promise<T>` is the one case ECMAScript itself widens this way: an
  // `async` function's body returns `T` at a `return` terminator whose ABI
  // result is `Promise<T>` -- the checker accepts this because `T` is
  // assignable to `Promise<T>`, and no ordinary binding or field can ever
  // hold `T` where a `Promise<T>` is declared, so this path is reached only
  // from the return terminator (`emit.ts`). Recursing (rather than a direct
  // `gea::Promise<...>(text)` wrap) lets a payload that itself needs
  // widening -- e.g. a tagged-union arm -- widen first; either way the
  // result relies on `gea::Promise<T>`'s own non-explicit converting
  // constructor, the same mechanism `Optional<T>` already uses above.
  if (held.kind === 'promise') return widenedStoreText(held.value, written, text)
  // A `dynamic` cell is the one case this reconciliation widens *into* rather
  // than narrows *out of* -- see citations.md finding 1 for why nothing else
  // in the compiler boxes a concrete value on write. `held.reason` is not
  // consulted: every `DynamicReason` (model.ts) names a boundary that admits
  // any concrete value the checker allows to reach it (declared
  // `any`/`unknown`, an unresolved `JSON.parse`, a thrown carrier,
  // `ToString`'s operand), so the box is unconditional once the cell itself
  // is `dynamic`.
  if (held.kind === 'dynamic') {
    // A value that is ALREADY a box needs no box: a `gea::Value` reaching a
    // `gea::Value` cell is a copy. `dynamicTagFor` answers `null` for a
    // `dynamic` not because it cannot be boxed but because it already is one,
    // so without this the generic tail below read that `null` as a refusal.
    // Two boxes whose carriers state different REASONS are one C++ type, which
    // is why this is a kind test and not a key test -- `dynamic(untyped-
    // callable)` and `dynamic(declared-any-never-narrowed)` are both
    // `gea::Value`, and only the identical pair is caught by this function's
    // own identity gate above.
    if (written.kind === 'dynamic') return text
    // A sum has no single tag: which JavaScript type it is depends on the arm
    // that is live, so the box is built by the same discriminant chain
    // `emit-equality.ts` compares one with. Written out per arm rather than
    // deferred to a runtime helper because `Value::box` needs the payload's
    // STATIC type to record its dispatchers (gea_runtime.h's own note on
    // `box`), and only an arm-indexed `get<I>()` has one.
    //
    // `text` is read once per arm, which is safe for the same reason
    // `absenceComparisonText` reads its operand twice: `operandText` answers an
    // already-materialized SSA name, never an expression with effects.
    //
    // The value is force-cast to the carrier's own declared C++ type
    // (`cppTypeOf`) before it reaches `box`, never left to deduce `box`'s
    // template argument from `text`'s own C++ expression type: `box<T>`
    // records `std::decay_t<T>` as the payload's static type (`gea_runtime.h`'s
    // own comment on `box`), and a checked unboxer downstream (`unboxAs`)
    // compares THAT recorded type against `cppTypeOf` again -- so the two must
    // be the same authority. Deduction gives the wrong one for exactly the
    // case this "already-materialized SSA name" assumption misses: a constant
    // operand's `text` can be the bare literal itself (`emit.ts`'s
    // `emitConstant`/`types.ts`'s `cppConstantLiteral` inline a `dynamic`
    // constant's literal text directly rather than routing it through a
    // variable first), and a bare `41` is a C++ `int`, a bare `"9"` a `const
    // char*` -- neither matches the `double`/`std::string`
    // `Tag::Number`/`Tag::String` promise. `static_cast<double>(41)` converts
    // the literal to the declared type before boxing it -- a plain explicit
    // `box<T>(...)` template argument was tried first and rejected: an
    // ALREADY-typed source read through a `const` accessor (a field read
    // inside a `const` member function, e.g.) is a `const` lvalue, which
    // cannot bind to `box`'s `T&&` when `T` is forced non-const, where
    // `static_cast<T>` copy-constructs a plain prvalue either way and binds
    // cleanly regardless of what qualifiers the source expression carried.
    // An optional value has no single tag either, for a different reason than
    // a union does: which JS value it boxes to depends on whether it is
    // present at all, not on which arm is live. Absent boxes to the exact
    // value its own absence spells (`null` or `undefined`, `written.absence`
    // names which) -- reusing `cppConstantLiteral`'s own spelling for that
    // literal and this SAME function's generic tail below to box it, rather
    // than hand-writing a second `Tag::Null`/`Tag::Undefined` construction
    // that could drift from the one the plain bare-`null`/bare-`undefined`
    // widening already renders. Present recurses one payload down, which
    // reaches the tagged-union case just above when the payload is one.
    if (written.kind === 'optional') {
      const absentRepresentation: Representation = { kind: written.absence }
      const absentText = cppConstantLiteral(written.absence, written.absence, absentRepresentation)
      const boxedAbsent = widenedStoreText(held, absentRepresentation, absentText)
      const boxedPresent = widenedStoreText(held, written.payload, `(*${text})`)
      if (boxedAbsent === null || boxedPresent === null) return null
      return `(${text}.has_value() ? ${boxedPresent} : ${boxedAbsent})`
    }
    if (written.kind === 'tagged-union') {
      const arms: string[] = []
      for (const [index, arm] of written.arms.entries()) {
        const armText = `${text}.get<${index}>()`
        // An arm that is itself a box is stored as-is, and cannot go through
        // the recursion below: this function's identity gate answers `null`
        // for a same-carrier pair -- "no widening needed", which the loop
        // would read as a refusal. A middleware composer carries its `handler` as
        // `tagged-union(dynamic(untyped-callable) | optional(Next))`, and
        // reading that cell as `dynamic` asks exactly this of arm 0.
        if (arm.value.kind === 'dynamic') {
          // A broad Function arm is stored as FunctionValue so the tagged
          // union retains its executable Function-tag discriminator. Both
          // FunctionValue -> Value (base conversion) and Value ->
          // FunctionValue (checked constructor) exist, which makes the two
          // arms of a C++ conditional expression ambiguous unless the live
          // FunctionValue is explicitly viewed as its Value base.
          const dynamicArmText = arm.runtimeDiscriminator.kind === 'callable-tag' ? `static_cast<gea::Value>(${armText})` : armText
          arms.push(`${text}.is<${index}>() ? ${dynamicArmText} : `)
          continue
        }
        const armTag = dynamicTagFor(arm.value)
        // An arm with no tag is not a carrier this box cannot hold -- it is one
        // whose JavaScript type depends on something a level further in.
        // `BodyInit | null | undefined` (a `Response` body parameter) has a
        // `present` arm that is ITSELF a union of seven, every one tagged. So
        // the arm recurses here -- this case and the optional one above answer
        // exactly the shapes `dynamicTagFor` returns `null` for -- and an arm
        // neither reaches still refuses, one level deeper, for the real reason.
        const boxed = armTag === null ? widenedStoreText(held, arm.value, armText) : boxedText(arm.value, armTag, armText)
        if (boxed === null) return null
        arms.push(`${text}.is<${index}>() ? ${boxed} : `)
      }
      return `(${arms.join('')}gea::Value())`
    }
    const tag = dynamicTagFor(written)
    return tag === null ? null : boxedText(written, tag, text)
  }
  // A CALLABLE CELL whose held convention differs from the written one only in
  // its RESULT -- `const slot: (n: number) => any = concrete`, and a
  // `register(handler: A | B)` parameter one union layer up. Asked before the tagged-union
  // gate below because a bare callable cell never reaches the arm loop, and
  // `emitBindingWrite` renders a store through this function rather than
  // through `convertedValueText`, so the pair has no other way in.
  const adaptedStore = resultAdaptedCallableText(written, held, text)
  if (adaptedStore !== null) return adaptedStore
  if (held.kind !== 'tagged-union') return null
  // A bare tagged union has no `has_value()` of its own: it cannot keep an
  // absence flag the way a `held.kind === 'optional'` above does. So a
  // `written` that still arrives optional here -- `a && a.b`'s kept side
  // still wearing its own optional while the merge's own carrier collapsed
  // to a bare union, or `a || b`/`a ?? b`'s kept-present side one absence
  // state narrower than `a` itself -- is read unconditionally rather than
  // refused. That unconditional read is sound, not a risk taken here: the
  // checker never lets a possibly-absent value reach a non-optional carrier
  // unless it has already proven presence at this exact point (the same
  // proof `narrowing`'s own unwrap trusts rather than re-derives,
  // `targets/cpp/conversions.ts`), one level up, at a store instead of a
  // load. The arm search below runs over the optional's *payload* -- no arm
  // an optional target ever selected wraps another optional, so searching
  // the wrapper itself would never match.
  if (written.kind === 'optional') {
    // An arm that IS this optional, whole. The deref below spends the
    // optional's own absence on the grounds that no arm ever wraps one -- and
    // a middleware composer disproves that: `let handler` is a `Function | (Next |
    // undefined)` cell whose arms are the record and `optional(callable)`, so
    // writing `next || undefined` into it stores the optional AS the arm.
    // Dereferencing there would drop the absence the arm exists to hold.
    const wholeIndex = held.arms.findIndex((arm) => representationKey(arm.value) === representationKey(written))
    if (wholeIndex >= 0) return `${cppTypeOf(held)}::ofArm<${wholeIndex}>(${text})`
    const derefText = `(*${text})`
    const payloadKey = representationKey(written.payload)
    const index = held.arms.findIndex((arm) => representationKey(arm.value) === payloadKey)
    if (index >= 0) return `${cppTypeOf(held)}::ofArm<${index}>(${derefText})`
    // The optional's live payload can reach a union arm by the same nominal
    // upcast as a bare class value below. This arises when a mutable local is
    // filled from an optional derived-class property after a presence guard,
    // while its cell holds a union of base classes. The guard has already
    // discharged absence at this store; preserve the live object and select
    // the unique ancestor arm rather than refusing merely because the source
    // still carries its flow-view Optional wrapper.
    if (written.payload.kind === 'class-ref') {
      for (const [armIndex, arm] of held.arms.entries()) {
        if (
          arm.value.kind === 'class-ref' &&
          written.payload.ownership === arm.value.ownership &&
          written.payload.ancestors.includes(arm.value.declaration)
        ) {
          return `${cppTypeOf(held)}::ofArm<${armIndex}>(${cppTypeOf(arm.value)}(${derefText}))`
        }
      }
    }
    for (const [armIndex, arm] of held.arms.entries()) {
      if (arm.value.kind !== 'tagged-union') continue
      const inner = widenedStoreText(arm.value, written.payload, derefText)
      if (inner !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${inner})`
    }
    return null
  }
  const writtenKey = representationKey(written)
  const index = held.arms.findIndex((arm) => representationKey(arm.value) === writtenKey)
  if (index >= 0) return `${cppTypeOf(held)}::ofArm<${index}>(${text})`
  // A join can nest: `string | number | boolean | null | undefined` derives as
  // an outer union over the two absence arms and an *inner* union over the
  // three value arms, so a written `bool` is an arm of an arm and reaches its
  // home in two wraps rather than one. Only a `tagged-union` arm is searched.
  // Every other widening this function performs is lossy about which value
  // arrived -- an `optional` answers the empty optional and a `native-handle`
  // the empty handle when the payload does not match -- and choosing one of
  // those from inside a union would silently store an absence where the
  // program wrote a value.
  for (const [armIndex, arm] of held.arms.entries()) {
    if (arm.value.kind === 'tagged-union') {
      const inner = widenedStoreText(arm.value, written, text)
      if (inner !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${inner})`
      continue
    }
    // A CALLABLE reaches an arm the same way it reaches a plain slot: through
    // one of `gea::CallableObject`'s own implicit converting constructors,
    // which take the value as it stands and are what `convertedValueText`
    // already answers with for the identical pair when the target is not a
    // union. `H = Handler | MiddlewareHandler` is the case -- a
    // middleware `(c, next) => Promise<void>` is assignable to one arm and the
    // exact-key search above cannot see it, because assignability here is not
    // carrier equality.
    //
    // Only these four, and only because each one renders as the value itself:
    // an arm chosen through a LOSSY widening would store something other than
    // what the program wrote, which is the same line the record recasts below
    // stay on.
    if (
      samePhysicalCarrier(written, arm.value) ||
      dropsUnboundParameters(written, arm.value) ||
      dropsAllParametersIntoResultArm(written, arm.value) ||
      widensResultIntoArm(written, arm.value) ||
      discardsResultIntoVoid(written, arm.value)
    ) {
      return `${cppTypeOf(held)}::ofArm<${armIndex}>(${text})`
    }
    if (
      (written.kind === 'class-ref' &&
        arm.value.kind === 'class-ref' &&
        written.ownership === arm.value.ownership &&
        written.ancestors.includes(arm.value.declaration)) ||
      nativeRecordBaseTransportKind(written, arm.value) === 'upcast'
    ) {
      return `${cppTypeOf(held)}::ofArm<${armIndex}>(${cppTypeOf(arm.value)}(${text}))`
    }
    const view = readOnlyMapViewText(written, arm.value, text)
    if (view !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${view})`
    // The fifth pair is not an implicit constructor, so it wraps the text
    // rather than passing it through -- see `resultAdapterOf`. `H =
    // Handler | MiddlewareHandler` reaches its arm exactly here: same frame,
    // a result the arm declares `any`.
    const adaptedArm = resultAdaptedCallableText(written, arm.value, text)
    if (adaptedArm !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${adaptedArm})`
    // A record recasts into a dictionary/array-object ARM the same way
    // `convertedValueText`'s own top level recasts it directly -- identity above never matches an object literal against either.
    const recast =
      written.kind === 'record'
        ? arm.value.kind === 'dictionary'
          ? recastedRecordToDictionaryText(written, arm.value, text)
          : arm.value.kind === 'record'
            ? recastedRecordText(written, arm.value, text)
            : null
        : written.kind === 'record-with-index' && arm.value.kind === 'dictionary'
          ? recastedIndexedRecordToDictionaryText(written, arm.value, text)
          : null
    if (recast !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${recast})`
  }
  return null
}

/**
 * Rebuilding a tagged union at a different arm ordering than the one it was
 * built with.
 *
 * Two declared unions with the same member set do not have to agree on tag
 * order -- `boolean | number` and `number | boolean` are two unrelated C++
 * template instantiations (`gea::TaggedUnion<bool, double>` vs
 * `gea::TaggedUnion<double, bool>`), which is exactly what a control-flow merge
 * produces when its two branches arrive through independently-declared unions.
 * Neither `narrowedLoadText` nor `widenedStoreText` covers it: the target is
 * not one arm of the source, and the source is not one arm of the target. What
 * it needs is the same discriminant `narrowedLoadText` reads, dispatched into
 * the same constructor `widenedStoreText` calls -- read the live arm by
 * whichever tag the source actually holds, and rebuild it at the target's tag
 * for that same value type. `null` when some source arm has no same-typed home
 * in the target: that is a real hole in the target's arm set, not a spelling
 * gap, and inventing a fallback there would silently drop a live value.
 */
/**
 * A sum converted ARM BY ARM into one payload, or `null` when an arm has no
 * way there.
 *
 * A generic visitor `visit<T>` returns `fn === undefined ? node : fn(node, ...)`
 * where `fn` is a visitor function typed over `any`: the conditional merges `T`
 * with a declared `any` into `tagged-union(native-record-ref | dynamic)`, and
 * the function returns `T | undefined`. The typed arm IS the payload; the
 * dynamic arm is the checked unbox every read of a declared-`any` value into
 * a typed cell already performs (`unboxedLoadText`, which aborts naming the
 * carrier on a mismatch). So the load dispatches on the live arm, exactly as
 * `recastedUnionText` does for a sum whose home is another sum. Only a sum
 * WITH a dynamic arm is answered: without one, a same-keyed arm beside
 * others is a narrowing (`narrowedLoadText`), which selects an arm and
 * proves nothing about the rest, and this must not stand in for it.
 * `targets/cpp/conversions.ts`'s `recasting` admits the pair on the same
 * predicate -- through this function -- so the admission and the render
 * cannot drift.
 */
export const sumIntoPayloadText = (
  source: Extract<Representation, { kind: 'tagged-union' }>,
  payload: Representation,
  text: string,
  wrap: (armText: string) => string
): string | null => {
  if (payload.kind === 'dynamic' || payload.kind === 'optional' || payload.kind === 'tagged-union') return null
  if (!source.arms.some((arm) => arm.value.kind === 'dynamic')) return null
  const key = representationKey(payload)
  const homes: string[] = []
  for (const [index, arm] of source.arms.entries()) {
    const armText = `${text}.get<${index}>()`
    const loaded = representationKey(arm.value) === key ? armText : arm.value.kind === 'dynamic' ? unboxedLoadText(payload, armText) : null
    if (loaded === null) return null
    homes.push(wrap(loaded))
  }
  let result = homes[homes.length - 1] ?? null
  if (result === null) return null
  for (let index = homes.length - 2; index >= 0; index--) result = `${text}.is<${index}>() ? ${homes[index]} : (${result})`
  return `(${result})`
}

/**
 * `nodes.ts`'s `armViewFor`, rendered: a census-built sum read as the Map or
 * Array the program asserts, EACH arm converted rather than one selected by its
 * tag -- the collection as it is, another Map through the all-dynamic view of
 * the same object, a box through its checked unbox, an open Document through
 * the object it views (`documentViewedObjectText`). `null` for an arm with no
 * such read, which the printer refuses.
 */
export const armViewText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'tagged-union') return null
  const key = representationKey(target)
  const homes: string[] = []
  for (const [index, arm] of source.arms.entries()) {
    const armText = `${text}.get<${index}>()`
    const loaded =
      representationKey(arm.value) === key
        ? armText
        : arm.value.kind === 'dynamic'
          ? unboxedLoadText(target, armText)
          : isOpenDocument(arm.value)
            ? documentViewedObjectText(arm.value, target, armText)
            : arm.value.kind === 'keyed-collection' && target.kind === 'keyed-collection'
              ? unboxedLoadText(target, `gea::Value::box(gea::Value::Tag::Object, ${armText})`)
              : null
    if (loaded === null) return null
    homes.push(loaded)
  }
  let result = homes[homes.length - 1] ?? null
  if (result === null) return null
  for (let index = homes.length - 2; index >= 0; index--) result = `${text}.is<${index}>() ? ${homes[index]} : (${result})`
  return `[&]() -> ${cppTypeOf(target)} { return ${result}; }()`
}

export const recastedUnionText = (
  source: Extract<Representation, { kind: 'tagged-union' }>,
  target: Extract<Representation, { kind: 'tagged-union' }>,
  text: string,
  // A third resolver for an arm pair this module cannot answer alone. A
  // `native-record-ref` names a layout instead of carrying one, so the field
  // lists a record recast needs are a fact of the EMITTER's context, not of
  // the representation -- `emit-callable.ts`'s `structuralRecordViewText` is
  // where both are in hand. `conversions.ts` already ADMITS that pair, so
  // without this the admission and the render disagree, which is the one
  // failure mode this compiler exists to remove: a generic alias instantiated
  // at a narrower argument (`Init<Narrow>`) passed into `Init<Wide>`
  // -- two shape ids over identical field carriers -- and the arm had no home
  // here even though the conversion graph said it did.
  viaLayout?: (source: Representation, target: Representation, text: string) => string | null
): string | null => {
  // A union with N arms otherwise interpolates BOTH the full target spelling
  // and the source expression at every arm -- and a nested inner-union arm
  // repeats that again inside every outer arm. A `Value | null | undefined`
  // whose `Value` is itself a 32-arm union is a 3-arm outer union over a 32-arm inner one, and
  // one recast of it -- reached from several sibling call sites glued by the
  // caller's own `&&`/`||` -- emitted a single line over 1.29MB: 957
  // `::ofArm<` sites each re-spelling a ~1.3KB template type, because neither
  // the source nor the target type was ever bound to a short name. Binding
  // both once, in an IIFE, is `promiseSourceName`'s own reasoning applied
  // here: `text` is an arbitrary expression that must be evaluated once, and
  // the target's spelling is exactly as repeatable. Skipped for a single-arm
  // source -- there is only one spelling of `text` and one of the target type
  // either way, so the IIFE would add bytes without removing any.
  const multiArm = source.arms.length > 1
  const boundSource = multiArm ? recastUnionSourceName : text
  const homeOf = source.arms.map((arm, index): RecastUnionHome | null => {
    const armText = `${boundSource}.get<${index}>()`
    const key = representationKey(arm.value)
    const exact = target.arms.findIndex((candidate) => representationKey(candidate.value) === key)
    if (exact >= 0) return { index: exact, text: armText }
    // An arm that is ITSELF a union homes as a whole, never candidate by
    // candidate. The candidate probe below asks `convertedValueText(arm,
    // candidate)`, and for a union arm against one of its own members that
    // question is answered by `narrowedLoadText` -- an UNCHECKED `.get<k>()`
    // that assumes the member is live. Taken as a home it reads whichever
    // member sits at that slot regardless of the inner discriminant: the
    // runtime `Request` constructor's `ArrayBuffer.isView(init.body)`, over
    // `undefined | null | (string | Uint8Array | ArrayBuffer | ... |
    // ReadableStream)` narrowed to the four arms the preceding guards left,
    // recast every inner arm as the `Uint8Array` one, answered `true` for a
    // `ReadableStream` body, and read `.buffer`/`.byteOffset` out of it.
    // Certified, compiled, RangeError. The inner union's own discriminant is
    // what decides the target arm, so the whole inner union narrows (or
    // recasts) into the whole target, one level down where that discriminant
    // is in scope -- `narrowedUnionSubsetText`'s collision rule, applied here.
    if (arm.value.kind === 'tagged-union') {
      const inner = arm.value
      const whole = tryCandidateText(() => narrowedLoadText(inner, target, armText)) ?? recastedUnionText(inner, target, armText, viaLayout)
      return whole === null ? null : { index: -1, text: whole, whole: true }
    }
    const homes: RecastUnionHome[] = []
    for (const [candidateIndex, candidate] of target.arms.entries()) {
      // An absence arm is never the home of a live value: the chain's
      // `unreachable-value` step would answer it by DISCARDING the value
      // (correct only for a flow-proved `undefined` read), and as the first
      // home found it silently turned every such arm into `undefined`.
      const absence = candidate.value.kind === 'undefined' || candidate.value.kind === 'null' || candidate.value.kind === 'void'
      if (absence && candidate.value.kind !== arm.value.kind) continue
      // `convertedValueText` and not `widenedStoreText` alone: an arm can
      // reach its home by a recast rather than a widening -- two records that
      // declare the same fields under two interned shapes, which is what a
      // generic result alias instantiated twice is made of -- and only the superset tries all of
      // them.
      const stored = tryCandidateText(() => convertedValueText(arm.value, candidate.value, armText))
      const home = stored ?? viaLayout?.(arm.value, candidate.value, armText) ?? null
      if (home !== null) homes.push({ index: candidateIndex, text: home })
    }
    return homes.length > 1 ? (undefinedFieldChoice(arm.value, target, homes, armText) ?? homes[0]!) : (homes[0] ?? null)
  })
  if (homeOf.some((home) => home === null)) return null
  return recastedUnionFromHomes(source, target, text, homeOf as readonly RecastUnionHome[])
}

/**
 * Two target arms a record arm converts into, told apart by a dynamic field.
 *
 * A record whose field is dynamic converts into every target arm whose field
 * a checked unbox can reach -- `ReadableStreamReadResult<unknown>`'s
 * `{ done, value }` into both `{ done: true, value: undefined }` and
 * `{ done: false, value: Uint8Array }` -- and taking the first one unboxed a
 * live chunk as `undefined`. Which arm holds is the field's own run-time tag.
 */
const undefinedFieldChoice = (
  source: Representation,
  target: Extract<Representation, { kind: 'tagged-union' }>,
  homes: readonly RecastUnionHome[],
  armText: string
): RecastUnionHome | null => {
  if (source.kind !== 'record' || homes.length !== 2) return null
  const arrow = source.ownership === 'shared-refcount' ? '->' : '.'
  for (const field of source.fields) {
    if (field.value.kind !== 'dynamic' || !field.required) continue
    const fieldKinds = homes.map((home) => {
      const arm = target.arms[home.index]?.value
      return arm?.kind === 'record' ? arm.fields.find((candidate) => candidate.key === field.key)?.value.kind : undefined
    })
    const absent = fieldKinds.findIndex((kind) => kind === 'undefined')
    const present = fieldKinds.findIndex((kind) => kind !== undefined && kind !== 'undefined' && kind !== 'dynamic')
    if (absent < 0 || present < 0) continue
    const type = cppTypeOf(target)
    const wrap = (home: RecastUnionHome): string => `${type}::ofArm<${home.index}>(${home.text})`
    const test = `${armText}${arrow}${cppRecordFieldName(field.key)}.tag() == gea::Value::Tag::Undefined`
    return { index: -1, whole: true, text: `(${test} ? ${wrap(homes[absent]!)} : ${wrap(homes[present]!)})` }
  }
  return null
}

export interface RecastUnionHome {
  readonly index: number
  readonly text: string
  /** `text` is already a complete value of the target union (a nested union arm homed as a whole), not an arm payload to wrap in `ofArm`. */
  readonly whole?: true
}

/** The text an arm of a multi-arm source is read through, bound by `recastedUnionFromHomes`; a single-arm source reads the value itself. */
export const recastUnionArmText = (source: Extract<Representation, { kind: 'tagged-union' }>, text: string, index: number): string =>
  `${source.arms.length > 1 ? recastUnionSourceName : text}.get<${index}>()`

/**
 * The dispatch over a sum's arms, given each arm's home in the target: the
 * discriminant read and the `ofArm` rebuild are one answer, whoever decided
 * the homes -- the chain probe above or a plan the census owns
 * (`conversion/record-view.ts`).
 */
export const recastedUnionFromHomes = (
  source: Extract<Representation, { kind: 'tagged-union' }>,
  target: Extract<Representation, { kind: 'tagged-union' }>,
  text: string,
  homes: readonly RecastUnionHome[]
): string | null => {
  const multiArm = source.arms.length > 1
  const boundSource = multiArm ? recastUnionSourceName : text
  const targetType = multiArm ? recastUnionAliasName : cppTypeOf(target)
  const last = homes.length - 1
  const lastHome = homes[last]
  if (!lastHome) return null
  const homeText = (home: RecastUnionHome): string => (home.whole ? home.text : `${targetType}::ofArm<${home.index}>(${home.text})`)
  let result = homeText(lastHome)
  for (let index = last - 1; index >= 0; index--) {
    const home = homes[index]
    if (!home) return null
    result = `${boundSource}.is<${index}>() ? ${homeText(home)} : (${result})`
  }
  if (!multiArm) return result
  // Parameter, not body-local -- see the nested chain above for why a
  // same-named `const auto&` in the body reads itself.
  return (
    `([&](const ${cppTypeOf(source)}& ${recastUnionSourceName}) -> ${cppTypeOf(target)} { using ${recastUnionAliasName} = ${cppTypeOf(target)}; ` +
    `return ${result}; }(${text}))`
  )
}

/**
 * One record rebuilt as another whose declared shape it satisfies.
 *
 * `type A = Named & { age: number }` and `({ ...base, ...extra })` describe one
 * shape and intern as two -- an `intersection` and an `object` -- so they derive
 * two `record` carriers under two shape ids, which this backend spells as two
 * structs. A value of one is not a value of the other in C++ even though every
 * member matches, and `return ({ ...base, ...extra })` out of a function
 * declared to return the intersection is exactly that meeting.
 *
 * This is `recastedUnionText`'s structural twin, and it is written for the same
 * reason: neither a narrowing nor a widening covers a pair where each side is
 * the whole of the other, just carried under a different identity.
 *
 * The relation admitted is TypeScript's own structural one, not shape equality,
 * because that equality was never the question a return conversion asks.
 * `return this.options` out of a method declared to return a narrower options
 * type is legal TypeScript and lowers to exactly this pair, and options-heavy
 * programs are built out of it: every options producer hands a record
 * carrying dozens of fields to a slot declaring an overlapping, differently
 * ordered, differently optional subset. So:
 *
 * - A source field the target does not declare is DROPPED. TypeScript already
 *   erased it at the boundary -- the declared type is what any later read goes
 *   through -- so the rebuild loses nothing the program could still see. (An
 *   `any`-typed re-read is not a counter-example: it reads the target carrier,
 *   which is what the declaration says the value is.)
 * - A target field the source lacks is filled with the carrier's own absent
 *   value, and only when the carrier HAS one -- `gea::Optional<T>{}` and
 *   `gea::Undefined{}`. A missing field whose carrier is a bare `T` is a real
 *   hole and still refuses.
 * - Requiredness may WIDEN (source required, target optional) and never
 *   narrow. There is no physical presence bit -- `records.ts` stores exactly
 *   `cppTypeOf(field.value)` -- so `in` answers from `staticKeyPresenceOf`'s
 *   reading of the field list, which proves presence from `required`. Going
 *   the other way would turn a runtime presence flag into a constant `true`:
 *   a silent wrong answer, so it stays refused.
 *
 * A field's own carrier is matched by key, by being a bare `T` poured into the
 * `Optional<T>` the target declares (`gea::Optional`'s converting constructor
 * performs it, and two optionals over one payload are one C++ type since
 * `cppTypeOf` never reads `.absence`), or by being the same recast one level
 * down. The nominal-identity split this exists for does not stop at the top:
 * a nested tuple like `[Pattern, string, [Handler, ParamIndexMap]]` handed to
 * a generic `Route<T>` slot whose innermost tuple interned under a second shape id with
 * a byte-identical field list, so the OUTER pair matched everywhere but there.
 * Refusing would refuse the identical question one level in.
 *
 * A lambda, not a repeated expression: `text` is evaluated once however many
 * fields the record has, which a comma-separated aggregate would not guarantee
 * for a source that is a call. `depth` names the parameter, so a nested rebuild
 * does not shadow its parent's.
 */
const absentFieldTexts = new WeakMap<Representation, string | null>()

const absentFieldText = (value: Representation): string | null => {
  // Remembered per carrier: an unspellable carrier answers by CATCHING a
  // thrown refusal, and the recast admission below asks about the same
  // absent target field once per candidate source -- thousands of throws
  // for one field on a large program.
  const remembered = absentFieldTexts.get(value)
  if (remembered !== undefined) return remembered
  const built = absentFieldTextOf(value)
  absentFieldTexts.set(value, built)
  return built
}

const absentFieldTextOf = (value: Representation): string | null => {
  // A carrier the one type mapping cannot spell has no default it could be
  // absent AS, so the field is not recastable -- a refusal, not a throw. This
  // is asked from the conversion registry's ADMISSION (`conversions.ts`'s
  // `recasting`), whose own `cppTypeOf(target)` guard spells the record by
  // shape id and never looks inside it: a large program put an
  // `optional(function(...))` whose ABI still carried an unmonomorphized type
  // parameter in a field here, and the throw took the whole compile down
  // instead of costing this one pair. Same idiom as `manifest.ts`'s
  // `isSpellable`: the mapping's throw IS the answer, not a second predicate.
  const spelled = spelledOrNull(value)
  if (spelled === null) return null
  if (value.kind === 'optional' || value.kind === 'undefined') return `${spelled}{}`
  // A property that is not there reads back as `undefined`, and a
  // default-constructed box is exactly that -- `gea::Value`'s own doc says so
  // ("a hoisted cell holds *some* value from the moment it exists").
  if (value.kind === 'dynamic') return `${spelled}{}`
  // A union declaring an `undefined` arm can state absence too, but its
  // default constructor builds ARM 0 whichever arm that is, so the arm is
  // named rather than assumed.
  if (value.kind === 'tagged-union') {
    const index = value.arms.findIndex((arm) => arm.value.kind === 'undefined')
    const arm = value.arms[index]
    if (arm !== undefined) return `${spelled}::ofArm<${index}>(${cppTypeOf(arm.value)}{})`
  }
  return null
}

const spelledOrNull = (value: Representation): string | null => {
  try {
    return cppTypeOf(value)
  } catch {
    return null
  }
}

/**
 * The arm of `union` that carries exactly `from`, or `null` when none or
 * several do.
 *
 * Several is a refusal rather than a pick: `A | B` where both lower to one C++
 * type has two right answers and the discriminant records which, so choosing
 * one here would decide a question the source value does not answer.
 */
const soleArmIndexFor = (union: Extract<Representation, { kind: 'tagged-union' }>, from: Representation): number | null => {
  const key = representationKey(from)
  const matches = union.arms.flatMap((arm, index) => (representationKey(arm.value) === key ? [index] : []))
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/** Two array carriers of one element and ownership whose only difference is the extension an interface adds -- one C++ type. */
export const sameArrayUpToExtension = (left: Representation, right: Representation): boolean =>
  left.kind === 'array-object' &&
  right.kind === 'array-object' &&
  left.ownership === right.ownership &&
  representationKey(left.element) === representationKey(right.element) &&
  arrayExtensionKey(left.extension) !== arrayExtensionKey(right.extension)

const recastableFieldValue = (from: Representation, to: Representation, seen: Set<string>): boolean => {
  if (representationKey(from) === representationKey(to)) return true
  if (to.kind === 'optional') {
    const payload = representationKey(to.payload)
    if (payload === representationKey(from)) return true
    if (from.kind === 'optional' && payload === representationKey(from.payload)) return true
    // An `undefined` source field IS the optional's own absent value: the copy
    // `EvaluatorResult<undefined>` returned into a slot declared as the
    // default `EvaluatorResult` writes `value: undefined` into `value?: string
    // | number`. There is no payload to convert; `recastFieldText` renders the
    // empty optional.
    if (from.kind === 'undefined') return true
    const fromPayload = from.kind === 'optional' ? from.payload : from
    // A payload that is one ARM of the optional's tagged-union payload is the
    // same admission the bare tagged-union branch below makes, one presence
    // flag deeper -- and the same render, `recastFieldText`'s optional branch
    // already descends into its payload before spelling the arm. Without it
    // `return result(0)` -- the copy `Result<number>` with `value: number`,
    // returned where `Result` (default `T`, `value: string | number |
    // undefined`) is declared -- had the renderer but not the admission.
    if (to.payload.kind === 'tagged-union' && soleArmIndexFor(to.payload, fromPayload) !== null) return true
    // A structural conversion does not stop at a presence flag. A required
    // source record can fill an optional target record of another interned
    // shape, and an optional source does the same conversion only on its live
    // payload. ColorManagement's two concrete color-space records flowing
    // into its common dictionary value are this exact shape.
    return recordsRecastableIn(fromPayload, to.payload, seen)
  }
  if (to.kind === 'tagged-union' && soleArmIndexFor(to, from) !== null) return true
  // A field declared `unknown`/`any` holds any value boxed: the chunk of a
  // `ReadableStreamReadResult<Uint8Array>` read as `ReadableStreamReadResult<unknown>`.
  if (to.kind === 'dynamic') return tryCandidateText(() => dynamicCarrierBoxText(from, 'gea_probe')) !== null
  // A callable field whose convention differs from the declared one's is
  // copied through the same adapter a direct store of it takes.
  // A convention naming a lattice-bottom carrier has no C++ type to adapt
  // through; that is a "no", not a crash of the whole conversion registry.
  if (from.kind === 'function-value-dispatch' && to.kind === 'function-value-dispatch')
    return !containsUnresolved(from) && !containsUnresolved(to) && resultAdapterOf(from, to) !== null
  // Containers copy element by element (`array-copy-recast`,
  // `record-to-dictionary`), so a field holding one recasts when its
  // elements convert.
  // A dynamic field is read out of its box the way any assertion reads one.
  if (
    (from.kind === 'array-object' && to.kind === 'array-object') ||
    (from.kind === 'dictionary' && to.kind === 'dictionary') ||
    from.kind === 'dynamic'
  )
    return (
      tryCandidateText(() => convertedValueText(from, to, 'gea_field')) !== null || emptyContainerRecastText(from, to, 'gea_field') !== null
    )
  return recordsRecastableIn(from, to, seen)
}

/** A record's fields by key, built once per carrier object. */
const fieldIndexes = new WeakMap<Representation, ReadonlyMap<string, RecordField>>()
const fieldIndexOf = (record: Extract<Representation, { kind: 'record' }>): ReadonlyMap<string, RecordField> => {
  const remembered = fieldIndexes.get(record)
  if (remembered !== undefined) return remembered
  const built = new Map<string, RecordField>()
  for (const field of record.fields) built.set(field.key, field)
  fieldIndexes.set(record, built)
  return built
}

/** The top-level pairs whose answer is being computed. */
const recordRecastPending = new WeakMap<Representation, WeakSet<Representation>>()

/** Top-level `recordsRecastable` answers, per (source, target) carrier pair. */
const recordRecastAnswers = new WeakMap<Representation, WeakMap<Representation, boolean>>()

/**
 * `seen` is the coinductive cycle guard: `null` at the top level, and the set
 * of every pair on the current descent once a field's own carrier makes the
 * walk recurse. A record with a field that cites the record again would recur
 * forever; the pair is admitted on the assumption under test, which can only
 * ever admit a cycle, never a pair that fails for a reason the walk would
 * otherwise have reached.
 *
 * The guard's key and set exist only once a descent happens. The conversion
 * registry asks this about every ordered pair of record carriers a program
 * has (`conversion/build.ts`), and a large program has enough of
 * them, with enough fields each, that a key string, a fresh set and a linear
 * field scan per target field, per pair, WAS the representations stage (the
 * main thread sat at 100% for an hour past the previous run's total). Fields
 * are matched through a per-record index, and a top-level answer is
 * remembered per pair, which `recastedRecordText` reads back for the pairs
 * the graph kept.
 */
const recordsRecastableIn = (source: Representation, target: Representation, seen: Set<string> | null): boolean => {
  if (source.kind !== 'record' || target.kind !== 'record') return false
  if (standInRefuses(source, target)) return false
  if (source.accessors.length > 0 || target.accessors.length > 0) return false
  if (seen !== null) {
    const pairKey = `${representationKey(source)}->${representationKey(target)}`
    if (seen.has(pairKey)) return true
    seen.add(pairKey)
    return recordFieldsRecastable(source, target, seen)
  }
  const remembered = recordRecastAnswers.get(source)?.get(target)
  if (remembered !== undefined) return remembered
  // A container field re-enters here through `convertedValueText`, outside
  // the `seen` descent; the pair already under test is admitted on the same
  // coinductive assumption.
  const pending = recordRecastPending.get(source)
  if (pending?.has(target)) return true
  if (pending === undefined) recordRecastPending.set(source, new WeakSet([target]))
  else pending.add(target)
  let answer: boolean
  try {
    answer = recordFieldsRecastable(source, target, null)
  } finally {
    recordRecastPending.get(source)?.delete(target)
  }
  let byTarget = recordRecastAnswers.get(source)
  if (byTarget === undefined) {
    byTarget = new WeakMap()
    recordRecastAnswers.set(source, byTarget)
  }
  byTarget.set(target, answer)
  return answer
}

const recordFieldsRecastable = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'record' }>,
  seen: Set<string> | null
): boolean => {
  const sourceFields = fieldIndexOf(source)
  let descent = seen
  for (const field of target.fields) {
    const match = sourceFields.get(field.key)
    if (match === undefined) {
      if (field.required || absentFieldText(field.value) === null) return false
      continue
    }
    if (!match.required && field.required) return false
    if (match.value === field.value || representationKey(match.value) === representationKey(field.value)) continue
    // The first descent starts the guard with this pair on it, exactly as the
    // eager form recorded the pair before walking any field.
    descent ??= new Set<string>([`${representationKey(source)}->${representationKey(target)}`])
    if (!recastableFieldValue(match.value, field.value, descent)) return false
  }
  return true
}

export const recordsRecastable = (source: Representation, target: Representation): boolean => recordsRecastableIn(source, target, null)

/**
 * Whether an admitted record recast moves any field across the dynamic
 * boundary: boxes a native field into a `dynamic` destination (the
 * `to.kind === 'dynamic'` admission of `recastableFieldValue`) or unboxes a
 * `dynamic` source field into a native one -- through an optional's payload,
 * a nested record, or a container's element.
 *
 * `targets/cpp/conversions.ts` states `nativeFieldProtocol: 'unused'` for a
 * record recast, which `ir/reflection-demand.ts` reads as "this copy asks no
 * dynamic field table, so the fields it copies keep their sealed keys-only
 * protocol". That is true of a recast that only copies native storage. A
 * recast that boxes a field hands the boxed payload to every later dynamic
 * read, and those reads DO go through the payload's field protocol -- so the
 * claim must not be made for it, or the boxed child is emitted without the
 * protocol the box needs (`reflection-demand.test.ts`, "a boxed destination
 * still exposes its payload").
 */
export const recordRecastCrossesDynamic = (source: Representation, target: Representation): boolean =>
  recastCrossesDynamicIn(source, target, new Set<string>())

const recastCrossesDynamicIn = (source: Representation, target: Representation, seen: Set<string>): boolean => {
  if (source.kind !== 'record' || target.kind !== 'record') return false
  const pairKey = `${representationKey(source)}->${representationKey(target)}`
  if (seen.has(pairKey)) return false
  seen.add(pairKey)
  for (const field of target.fields) {
    const match = source.fields.find((candidate) => candidate.key === field.key)
    if (match !== undefined && recastFieldCrossesDynamic(match.value, field.value, seen)) return true
  }
  return false
}

const recastFieldCrossesDynamic = (from: Representation, to: Representation, seen: Set<string>): boolean => {
  const source = from.kind === 'optional' ? from.payload : from
  const target = to.kind === 'optional' ? to.payload : to
  if (representationKey(source) === representationKey(target)) return false
  if ((source.kind === 'dynamic') !== (target.kind === 'dynamic')) return true
  if (source.kind === 'array-object' && target.kind === 'array-object')
    return recastFieldCrossesDynamic(source.element, target.element, seen)
  if (source.kind === 'dictionary' && target.kind === 'dictionary') return recastFieldCrossesDynamic(source.value, target.value, seen)
  return recastCrossesDynamicIn(source, target, seen)
}

const recastedRecordText = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'record' }>,
  text: string,
  depth = 0
): string | null => {
  if (!recordsRecastable(source, target)) return null
  const arrow = source.ownership === 'shared-refcount' ? '->' : '.'
  const holder = `gea_from${depth === 0 ? '' : `_${depth}`}`
  const recastFieldText = (from: Representation, to: Representation, read: string, nestedDepth: number): string | null => {
    if (representationKey(from) === representationKey(to)) {
      const arithmetic = to.kind === 'scalar' && to.domain !== 'bigint'
      return arithmetic ? `static_cast<${cppTypeOf(to)}>(${read})` : read
    }
    if (to.kind === 'optional') {
      // The absent value, admitted by `recastableFieldValue` for an
      // `undefined` source; the source field is storage-free and is not read.
      if (from.kind === 'undefined') return `${cppTypeOf(to)}()`
      const fromPayload = from.kind === 'optional' ? from.payload : from
      const payloadRead = from.kind === 'optional' ? `(*${read})` : read
      const converted = recastFieldText(fromPayload, to.payload, payloadRead, nestedDepth)
      if (converted === null) return null
      const targetType = cppTypeOf(to)
      return from.kind === 'optional'
        ? `(${read}.has_value() ? ${targetType}(${converted}) : ${targetType}())`
        : `${targetType}(${converted})`
    }
    if (to.kind === 'tagged-union') {
      const index = soleArmIndexFor(to, from)
      return index === null ? null : `${cppTypeOf(to)}::ofArm<${index}>(${read})`
    }
    if (to.kind === 'dynamic') return tryCandidateText(() => dynamicCarrierBoxText(from, read))
    if (from.kind === 'function-value-dispatch' && to.kind === 'function-value-dispatch') return resultAdaptedCallableText(from, to, read)
    if (
      (from.kind === 'array-object' && to.kind === 'array-object') ||
      (from.kind === 'dictionary' && to.kind === 'dictionary') ||
      from.kind === 'dynamic'
    )
      return tryCandidateText(() => convertedValueText(from, to, read)) ?? emptyContainerRecastText(from, to, read)
    if (from.kind !== 'record' || to.kind !== 'record') return null
    return recastedRecordText(from, to, read, nestedDepth + 1)
  }
  const reads = target.fields.map((field) => {
    const read = tailAwareFieldReadText(source.fields, field.key, `${holder}${arrow}`)
    const match = source.fields.find((candidate) => candidate.key === field.key)
    // A field the target declares and the source does not: the carrier's own
    // absent value, which `recordsRecastable` already proved exists.
    if (match === undefined) return absentFieldText(field.value)
    // Inside braces [dcl.init.list]/7 forbids a narrowing every other argument
    // position allows: a field the integer census holds in a `long long` is a
    // hard error written into a `double` member, though both carriers say
    // `scalar(number)`. `static_cast` spells that same conversion explicitly --
    // `emit-arrays.ts`'s `packElementText` answers the identical rule this way,
    // `bigint` excluded on its terms too, and it is a no-op where both agree.
    const converted = recastFieldText(match.value, field.value, read, depth)
    if (converted === null || field.value.kind !== 'scalar' || field.value.domain === 'bigint') return converted
    // `cppTypeOf` answers what the CARRIER is; the struct answers what the
    // MEMBER is, and the integer-storage census makes those two disagree --
    // a `scalar(number)` field the census proved integral is declared
    // `long long`. Inside braces that disagreement is a hard error
    // ([dcl.init.list]/7), not a silent conversion. Naming the member's own
    // declared type is the only spelling that cannot drift from it; the
    // census is not reachable from here and a second opinion about which
    // fields it narrowed is exactly the drift that keeps producing defects.
    return `static_cast<decltype(${cppRecordStructName(target.shapeId)}::${cppRecordFieldName(field.key)})>(${converted})`
  })
  if (reads.some((read) => read === null)) return null
  // Presence bits are ASSIGNED after the build, never initialized by
  // position. `records.ts` lays out one bit per field, required ones included,
  // and makes a required bit a `static` member only when the program never
  // deletes/freezes a declared field -- so a positional list that skips the
  // required bits lands each optional bit on a REQUIRED one whenever that
  // census says no. An `'optionalKey' in options` check then answered
  // false for a key the program had set. Left alone, every
  // bit keeps its declared default (required present, optional absent).
  const target_ = target.ownership === 'shared-refcount' ? '->' : '.'
  const presences = target.fields.flatMap((field) => {
    if (field.required) return []
    const match = source.fields.find((candidate) => candidate.key === field.key)
    if (match === undefined) return []
    const present = match.required ? 'true' : `${holder}${arrow}${cppRecordFieldPresenceName(field.key)}`
    return [`gea_recast${target_}${cppRecordFieldPresenceName(field.key)} = ${present};`]
  })
  // A target whose layout moved fields behind its `RecordTail` has no
  // positional form, and storing an absent field would allocate the tail for
  // nothing, so it is filled by name, present fields only.
  if (tailFieldsOf({ fields: target.fields }).size > 0) {
    const structName = cppRecordStructName(target.shapeId)
    const stores = target.fields.flatMap((field, index) => {
      const match = source.fields.find((candidate) => candidate.key === field.key)
      if (match === undefined) return []
      const store = `gea_recast${target_}${tailAwareFieldWriteText(target.fields, field.key)} = ${reads[index]!};`
      if (field.required) return [store]
      const present = match.required ? 'true' : `${holder}${arrow}${cppRecordFieldPresenceName(field.key)}`
      return [`if (${present}) { ${store} gea_recast${target_}${cppRecordFieldPresenceName(field.key)} = true; }`]
    })
    const declared =
      target.ownership === 'shared-refcount' ? `auto gea_recast = gea::makeRef<${structName}>();` : `${structName} gea_recast{};`
    return `[](const ${cppTypeOf(source)}& ${holder}) { return ([&]() { ${declared} ${stores.join(' ')} return gea_recast; }()); }(${text})`
  }
  const structure = `${cppRecordStructName(target.shapeId)}{${reads.join(', ')}}`
  const allocated =
    target.ownership === 'shared-refcount' ? `gea::makeRef<${cppRecordStructName(target.shapeId)}>(${structure})` : structure
  const built =
    presences.length === 0 ? allocated : `([&]() { auto gea_recast = ${allocated}; ${presences.join(' ')} return gea_recast; }())`
  return `[](const ${cppTypeOf(source)}& ${holder}) { return ${built}; }(${text})`
}

/**
 * A record recast into a dictionary, one level out from `recordsRecastable`
 * above.
 *
 * A `record`'s field set is CLOSED and known at compile time; a `dictionary`'s
 * is open and string/number-keyed. Going from the closed shape to the open one
 * loses no information -- every field the record has, the dictionary can hold
 * -- so the direction is always sound, unlike the reverse (`derive.ts`'s own
 * `dictionary` case: "Product needs a complete frozen field list", never
 * derivable from an open one). Concretely this is `return {}` reaching a
 * function whose declared result is `Record<string, V>`: TypeScript types the
 * empty literal as the record with zero fields it is, not as the dictionary
 * its ABI slot wants, and the two carriers stay genuinely different even
 * though the empty case rebuilds to zero inserts.
 *
 * Every field's own value must have an installed conversion into the
 * dictionary's declared value carrier. This is the same store each field
 * would perform if the source literal had been contextualized as the index
 * signature in the first place: a scalar into a declared `any` slot boxes at
 * that explicit dynamic boundary, and a typed slot keeps its ordinary native
 * conversion. A field with no such conversion refuses the whole recast before
 * any output is rendered.
 */
export const recordCastableToDictionary = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'dictionary' }>
): boolean => {
  if (source.accessors.length > 0) return false
  // A record field names a compile-time key. A symbol-indexed dictionary is
  // keyed by the runtime Symbol value, and a field's `sym(<declaration>)`
  // identity cannot manufacture that value at this conversion site. Admitting
  // the cast would either stringify the symbol (wrong identity) or box it.
  if (target.key === 'symbol') return source.fields.length === 0
  if (target.key === 'number' && source.fields.some((field) => !isCanonicalNumberPropertyKeyText(field.key))) return false
  if (containsUnresolved(source) || containsUnresolved(target)) return false
  return source.fields.every((field) => {
    try {
      return convertedValueText(field.value, target.value, 'gea_record_field') !== null
    } catch (error) {
      // This function is queried while the conversion graph is being built.
      // A nested narrowing recipe can reject its own source/target pair by
      // throwing the backend's named refusal; in this predicate that means the
      // field is not convertible, not that graph construction itself failed.
      // Unexpected errors still escape so internal defects remain visible.
      if (isCppEmitBlockedError(error)) return false
      throw error
    }
  })
}

const recastedRecordToDictionaryText = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'dictionary' }>,
  text: string,
  sourceType: string = cppTypeOf(source),
  inCreationOrder = true
): string | null => {
  if (!recordCastableToDictionary(source, target)) return null
  const fieldArrow = source.ownership === 'shared-refcount' ? '->' : '.'
  const dictArrow = target.ownership === 'shared-refcount' ? '->' : '.'
  const container =
    target.key === 'number' ? 'gea::NumericDictionary' : target.key === 'symbol' ? 'gea::SymbolDictionary' : 'gea::Dictionary'
  const storage = `${container}<${cppTypeOf(target.value)}>`
  const inserts = source.fields.map((field) => {
    if (target.key === 'symbol') return null
    const key = cppStringLiteral(field.key)
    const read = `gea_from${fieldArrow}${cppRecordFieldName(field.key)}`
    const converted = convertedValueText(field.value, target.value, read)
    if (converted === null) return null
    const insert = `gea_dict${dictArrow}operator[](${key}) = ${converted};`
    // An optional field never written is no own property, and the dictionary
    // must not gain the key: a serializer walking it would write it as `null`.
    return field.required ? insert : `if (gea_from${fieldArrow}${cppRecordFieldPresenceName(field.key)}) ${insert}`
  })
  if (inserts.some((insert) => insert === null)) return null
  const statements = (inserts as string[]).join(' ')
  const construct = target.ownership === 'shared-refcount' ? `auto gea_dict = gea::makeRef<${storage}>();` : `${storage} gea_dict{};`
  // A key the record gained outside its layout is one of its own keys too; the
  // dictionary takes it, in creation order, as the indexed recast below does.
  const ordered = inCreationOrder ? creationOrderedDictionaryCopyText(source, target) : ''
  return `[](const ${sourceType}& gea_from) { ${ordered}${construct} ${statements} return gea_dict; }(${text})`
}

/**
 * A record with an open string index poured into an open string dictionary:
 * a generic query type -- named operator fields plus
 * `[key: string]: any` -- handed to a `filter: Document` parameter. The named
 * fields go in as `recastedRecordToDictionaryText` puts them, and every
 * enumerable entry of the index sidecar after them, converted into the
 * dictionary's value carrier; a non-enumerable one is not an own property a
 * copy sees. Admitted on `recordCastableToDictionary`'s terms plus one index,
 * over string keys, whose values convert too.
 */
export const indexedRecordCastableToDictionary = (
  source: Extract<Representation, { kind: 'record-with-index' }>,
  target: Extract<Representation, { kind: 'dictionary' }>
): boolean => {
  if (target.key !== 'string' || source.indexes.length !== 1) return false
  const index = source.indexes[0]!
  if (index.key !== 'string') return false
  if (
    !recordCastableToDictionary(
      { kind: 'record', shapeId: source.shapeId, ownership: source.ownership, fields: source.fields, accessors: [] },
      target
    )
  )
    return false
  return tryCandidateText(() => convertedValueText(index.value, target.value, 'gea_index_value')) !== null
}

export const recastedIndexedRecordToDictionaryText = (
  source: Extract<Representation, { kind: 'record-with-index' }>,
  target: Extract<Representation, { kind: 'dictionary' }>,
  text: string,
  sourceType: string = cppTypeOf(source)
): string | null => {
  if (!indexedRecordCastableToDictionary(source, target)) return null
  const index = source.indexes[0]!
  const fieldArrow = source.ownership === 'shared-refcount' ? '->' : '.'
  const dictArrow = target.ownership === 'shared-refcount' ? '->' : '.'
  const named = recastedRecordToDictionaryText(
    { kind: 'record', shapeId: source.shapeId, ownership: source.ownership, fields: source.fields, accessors: [] },
    target,
    'gea_from',
    sourceType,
    false
  )
  const entry = convertedValueText(index.value, target.value, `gea_from${fieldArrow}${cppRecordIndexSidecarName}.read(gea_key)`)
  if (named === null || entry === null) return null
  return (
    `[](const ${sourceType}& gea_from) { ${creationOrderedDictionaryCopyText(source, target)}auto gea_dict = ${named}; ` +
    `for (const std::string& gea_key : gea_from${fieldArrow}${cppRecordIndexSidecarName}.enumerableKeys()) gea_dict${dictArrow}operator[](gea_key) = ${entry}; ` +
    `return gea_dict; }(${text})`
  )
}

/**
 * The recast above in the source's creation order, as a statement returning
 * the dictionary, or nothing when the copy cannot take that path.
 *
 * The static copy lists the named fields before the index entries, which is
 * the record's own order only until it has a key outside its layout -- a
 * command document gains its options that way, and a serialized command whose
 * first key is its name has to keep that key first. The runtime then knows the order
 * (`gea::copyOwnPropertiesInCreationOrder`); each value it hands over is a
 * property read through the record's own protocol, converted into the
 * dictionary's carrier.
 */
const creationOrderedDictionaryCopyText = (
  source: { readonly ownership: Ownership },
  target: Extract<Representation, { kind: 'dictionary' }>
): string => {
  if (source.ownership !== 'shared-refcount' || target.key !== 'string') return ''
  const converted = tryCandidateText(() =>
    convertedValueText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target.value, 'gea_value')
  )
  if (converted === null) return ''
  const storage = `gea::Dictionary<${cppTypeOf(target.value)}>`
  const shared = target.ownership === 'shared-refcount'
  const construct = shared ? `auto gea_ordered = gea::makeRef<${storage}>();` : `${storage} gea_ordered{};`
  return (
    `{ ${construct} if (gea::copyOwnPropertiesInCreationOrder(gea_from, [&](const std::string& gea_key, const gea::Value& gea_value) { ` +
    `gea_ordered${shared ? '->' : '.'}operator[](gea_key) = ${converted}; })) return gea_ordered; } `
  )
}

/**
 * The indexed record a carrier holds: itself, or the layout a named interface
 * resolves to when that layout declares an index -- a mapped alias like
 * `WithoutId<TSchema>` is a name. A named layout with NO index is the plain record recast's.
 */
export const indexedRecordViewOf = (
  source: Representation,
  layouts: RecordLayoutPolicy
): Extract<Representation, { kind: 'record-with-index' }> | null => {
  if (source.kind === 'record-with-index') return source
  if (source.kind !== 'native-record-ref' || source.native !== null || source.recursive) return null
  const fields = layouts.forShape(source.shapeId)
  const indexes = layouts.indexesForShape(source.shapeId)
  if (fields === null || indexes.length === 0) return null
  return { kind: 'record-with-index', shapeId: source.shapeId, fields, indexes, ownership: source.ownership }
}

export const INDEXED_RECORD_TO_DICTIONARY = 'gea::record::recastIndexedToDictionary'
export const INDEXED_RECORD_INTO_DICTIONARY_ARM = 'gea::TaggedUnion::ofIndexedRecordArm'

/** The ONE dictionary arm of `target` an indexed record pours into, or null when there is none or more than one. */
export const indexedRecordDictionaryArmOf = (
  source: Extract<Representation, { kind: 'record-with-index' }>,
  target: Representation
): number | null => {
  if (target.kind !== 'tagged-union') return null
  const homes = target.arms.flatMap((arm, index) =>
    arm.value.kind === 'dictionary' && indexedRecordCastableToDictionary(source, arm.value) ? [index] : []
  )
  return homes.length === 1 ? homes[0]! : null
}

/**
 * A class instance handed where an open `{ [key: string]: any }` document is
 * declared, as a live VIEW of the instance (`gea::dictionary::aliasOf`): the
 * same object, read and written through its own property protocol.
 *
 * Not a copy. A method declared `(): Document` may return a class instance
 * its caller goes on to use as that class, and a consumer may read
 * `document.someCount` -- a PROTOTYPE getter -- off a response class. A table of the instance's own
 * fields answers neither, and loses every write made through either name
 * afterwards; the view answers all of it because it is the object. Only the
 * one dictionary whose values are already `any` can view: every value read
 * through it is dynamic anyway, so viewing boxes nothing the program typed,
 * and the instance keeps its own native carrier everywhere else.
 */
/**
 * Whether an open `any` Document can view `source` as the very object it is.
 * A union of such objects is viewable too -- `{ message; code } |
 * SomeError | OtherError` into an open description record -- because its box
 * names whichever arm is live; so is the intrinsic Error.
 */
export const documentViewable = (source: Representation): boolean => {
  // A `dynamic` arm beside them is the rest of the same declared Document --
  // already a box, so the view (`aliasOf(const Value&)`) boxes nothing typed.
  if (source.kind === 'tagged-union')
    return source.arms.every((arm) => arm.value.kind === 'dynamic' || isOpenDocument(arm.value) || documentViewable(arm.value))
  const viewable =
    source.kind === 'class-ref' ||
    source.kind === 'record' ||
    source.kind === 'record-with-index' ||
    (source.kind === 'native-record-ref' && !source.recursive) ||
    // An Array or a Map is an object as well: a recursive document serializer
    // holds every nested value -- plain, array or Map -- in one `Document`
    // frame field, then walks it by what it turned out to be.
    source.kind === 'array-object' ||
    (source.kind === 'keyed-collection' && source.family === 'map')
  return viewable && source.ownership === 'shared-refcount'
}

export const classDocumentViewText = (source: Representation, target: Representation, text: string): string | null => {
  // A shared record a copy could not be made of views the same way: a
  // named interface-typed field handed to a `Document | null` slot.
  // A record a Document adopted (`gea::dictionary::adopt`) is that Document.
  if (!isOpenDocument(target) || !documentViewable(source)) return null
  if (source.kind === 'tagged-union') {
    const entries = source.arms.map((arm, index) => {
      const value = `gea_source.template get<${index}>()`
      if (arm.value.kind === 'dynamic') return `gea::dictionary::aliasOf(${value})`
      return isOpenDocument(arm.value) ? value : classDocumentViewText(arm.value, target, value)
    })
    if (entries.some((entry) => entry === null)) return null
    const tail = entries[entries.length - 1]
    if (tail === undefined) return null
    const selected = entries
      .slice(0, -1)
      .reduceRight((next, entry, index) => `gea_source.template is<${index}>() ? ${entry} : (${next})`, tail)
    return `[](const ${cppTypeOf(source)}& gea_source) -> ${cppTypeOf(target)} { return ${selected}; }(${text})`
  }
  return `gea::dictionary::aliasOf(${text})`
}

/**
 * An open `any` Document read as a class instance or a byte view: only the
 * object the Document views (`gea::dictionary::aliasOf`) can be one, so the
 * read is that object's checked unbox, and a Document holding its own entries
 * refuses. A `Buffer.isBuffer(options.someDocument)` guard reaches it.
 */
const documentViewedObjectText = (source: Representation, target: Representation, text: string): string | null => {
  // `options.someDocument?: Document` is optional; the guard that narrows it to a
  // Buffer has already proved it present, and an absent one refuses like any
  // other value that is not a Buffer.
  const optional = source.kind === 'optional' && isOpenDocument(source.payload)
  if (!optional && !isOpenDocument(source)) return null
  // A document serializer reads a frame's `Document` back `as unknown[]` under
  // `Array.isArray`, and `as Map<string, unknown>` under `instanceof Map`.
  const viewable =
    target.kind === 'typed-array' ||
    target.kind === 'class-ref' ||
    target.kind === 'array-object' ||
    (target.kind === 'keyed-collection' && target.family === 'map')
  if (!viewable) return null
  const object = optional ? '*gea_document' : 'gea_document'
  const method =
    target.kind === 'keyed-collection' && target.family === 'map' && target.key.kind === 'dynamic' && target.value?.kind === 'dynamic'
      ? 'gea::dictionary::viewedDynamicMap'
      : `gea::dictionary::viewedObjectAs<${cppTypeOf(target)}>`
  const load = `${method}(${object}, ${cppStringLiteral(assertionSite(target))})`
  return (
    `[](const ${cppTypeOf(source)}& gea_document) -> ${cppTypeOf(target)} { ` +
    (optional
      ? `if (!gea_document.has_value()) return ${cppTypeOf(target)}${source.kind === 'optional' && source.absence === 'undefined' ? '::undefined()' : '()'}; `
      : '') +
    `return ${load}; }(${text})`
  )
}

const dictionaryToRecordText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'dictionary' || source.key !== 'string' || source.value.kind !== 'dynamic' || source.ownership !== 'shared-refcount')
    return null
  if (target.kind === 'record-with-index') return null
  if (target.kind !== 'record' || target.accessors.length !== 0 || target.ownership === 'borrowed') return null
  if (target.ownership === 'shared-refcount') return null
  const boxed = dynamicCarrierBoxText(source, text)
  return boxed === null ? null : unboxedLoadText(target, boxed)
}

export const DYNAMIC_DICTIONARY_TO_NAMED_RECORD = 'gea::record::fromDynamicDictionary'

export const CONSTRUCTOR_STATIC_VIEW = 'gea::constructorStaticView'

/**
 * Whether a class's constructor object can be viewed as a record shape: the
 * view is the constructor's own properties for that shape
 * (`gea::constructorStaticView`), so every field must be one a constructor
 * may not have -- optional -- and the shape must be a plain shared record
 * whose identity the view can be.
 */
export const constructorStaticViewAdmitted = (
  source: Representation,
  target: Representation,
  fields: readonly RecordField[] | null
): boolean => {
  if (source.kind !== 'constructor-family' && source.kind !== 'constructor-identity') return false
  if (source.kind === 'constructor-family' && source.members.some((member) => member.includes('@'))) return false
  if (target.kind === 'record') {
    if (target.ownership !== 'shared-refcount' || target.accessors.length !== 0) return false
    return target.fields.every((field) => !field.required)
  }
  if (target.kind !== 'native-record-ref' || target.native !== null || target.recursive || target.ownership !== 'shared-refcount')
    return false
  return fields !== null && fields.every((field) => !field.required)
}

/** The class evaluation a constructor carrier names, then its own view as `target`'s struct. */
export const constructorStaticViewText = (source: Representation, target: Representation, text: string): string | null => {
  if (target.kind !== 'record' && target.kind !== 'native-record-ref') return null
  const state =
    source.kind === 'constructor-identity'
      ? `(${text}).get()`
      : source.kind === 'constructor-family'
        ? `static_cast<gea::NativeClassMethodState*>((${text}).environment)`
        : null
  if (state === null) return null
  return `gea::constructorStaticView<${cppRecordStructName(target.shapeId)}>(${state})`
}

type NamedRecordIndexes = readonly { readonly value: Representation; readonly key: 'string' | 'number' | 'symbol' }[]

/**
 * Whether an open `{ [key: string]: any }` document rebuilds as a named
 * interface's native record: every field has a checked unbox out of a
 * `gea::Value`, and every index the layout declares is a string index of
 * `any` the leftover keys can go into unchanged.
 */
export const dynamicDictionaryToNamedRecordAdmitted = (
  source: Representation,
  target: Representation,
  fields: readonly RecordField[] | null,
  indexes: NamedRecordIndexes
): boolean => {
  if (source.kind !== 'dictionary' || source.key !== 'string' || source.value.kind !== 'dynamic' || source.ownership !== 'shared-refcount')
    return false
  if (target.kind !== 'native-record-ref' || target.native !== null || target.recursive || target.ownership !== 'shared-refcount')
    return false
  if (fields === null || indexes.length > 1) return false
  if (indexes.some((index) => index.key !== 'string' || index.value.kind !== 'dynamic')) return false
  // A probe, so a field whose carrier never resolved answers `false` here
  // (see `containsUnresolved`) instead of throwing out of `cppTypeOf`.
  return fields.every(
    (field) =>
      field.value.kind === 'dynamic' ||
      (!containsUnresolved(field.value) &&
        withoutUnitFunctions(() => tryCandidateText(() => unboxedLoadText(field.value, 'gea_value'))) !== null)
  )
}

/**
 * The text a `convert` renders to, or `null` when nothing installed performs it.
 *
 * A convert is a carrier change the graph asked for by name -- a merge that
 * keeps one side, an optional chain's absent arm -- so unlike a narrowing read
 * it may widen, and unlike a widening store it may be handed an absence rather
 * than a payload.
 *
 * The absence cases are not spelled here. They used to be, and that private
 * copy was the defect: `widenedStoreText` -- which every ordinary store site
 * asks, and which this function's own tail already delegates to -- carried no
 * absence rule, so a `null` reaching a binding, a field or a return came out
 * unconverted while the same `null` reaching an explicit `convert` came out
 * right. One question, two answers, and only the quieter one was wrong. The
 * rule now lives once, on the store side, and this function reaches it through
 * the same tail it already used for every other widening.
 */
/**
 * The calling convention of a carrier the backend spells
 * `gea::CallableObject<...>`, or `null` for anything else.
 *
 * The constructor carriers are deliberately absent even though they also state
 * one convention: they spell `gea::ConstructorObject<...>`, which declares no
 * converting constructor, so the rule below does not hold for them.
 * `function-and-constructor` is absent for a different reason -- it states two
 * conventions, and picking one here would answer a question the value does not.
 */
export const callableObjectAbi = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return representation.abi
    default:
      return null
  }
}

/**
 * The callable half of a value that also carries `[[Construct]]`.
 *
 * The target's callable ABI is the authority that makes selecting this half
 * unambiguous: its exact key must equal the source's published `call` ABI.
 * The new `CallableObject` keeps the same function pointer, environment and
 * owning reference, so extracting the view preserves both behavior and
 * lifetime while dropping only the construction entry the target cannot use.
 */
const callablePartText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'function-and-constructor') return null
  const targetAbi = callableObjectAbi(target)
  if (targetAbi === null || abiKey(source.call) !== abiKey(targetAbi)) return null
  const sourceType = cppTypeOf(source)
  const targetType = cppTypeOf(target)
  return (
    `[](const ${sourceType}& gea_from) { ${targetType} gea_callable{}; ` +
    `gea_callable.invoke = gea_from.invoke; gea_callable.environment = gea_from.environment; ` +
    `gea_callable.environmentOwner = gea_from.environmentOwner; gea_callable.functionObject = gea_from.functionObject; return gea_callable; }(${text})`
  )
}

/**
 * The same positional read, for a rest slot carried as a closed TUPLE rather
 * than an open Array.
 *
 * `Function.prototype.call` is where that shape comes from. Under
 * `strictBindCallApply` its signature is `call<T, A extends any[], R>(this:
 * (this: T, ...args: A) => R, thisArg: T, ...args: A): R`, and the checker
 * infers `A` from the call's OWN arguments -- so
 * `callback.call(thisArg, value, key, parent)` states the `this` slot as
 * `(this: unknown, ...args: [string, string, Headers]) => void`, whose rest
 * parameter derives to a `record` of numeric keys and not to the
 * `array-object` the open `(...args: any[])` idiom produces. The positions are
 * the same positions; only the carrier differs.
 *
 * A source parameter past the tuple's end is refused rather than defaulted:
 * the open-array case has an element TYPE to default, while a tuple that does
 * not declare the position states nothing to stand in for it. An optional
 * field is refused for the same reason -- its absence is a presence flag the
 * caller must read, not a value.
 *
 * A headers class's `forEach` is the measured case: it
 * forwards to the caller's `(value, key, parent) => void` through
 * `callback.call(thisArg, value, key, this)`.
 */
const restTupleFieldActual = (
  slot: Extract<Representation, { kind: 'record' }>,
  restOrdinal: number,
  position: number,
  parameter: AbiParameter
): string | null => {
  const field = slot.fields[position]
  if (field === undefined || !field.required) return null
  const arrow = slot.ownership === 'shared-refcount' ? '->' : '.'
  const access = `${adapterFormalName(restOrdinal)}${arrow}${cppRecordFieldName(field.key)}`
  if (samePhysicalCarrier(field.value, parameter.value)) return access
  try {
    return convertedValueText(field.value, parameter.value, access)
  } catch (error) {
    if (isCppEmitBlockedError(error)) return null
    throw error
  }
}

/**
 * One source parameter read out of the slot's own rest Array -- the positional
 * read ECMA-262 performs when a function is called with an argument list the
 * caller assembled. A position the array does not reach is `undefined`, which
 * is exactly what a JavaScript call passes there, so the element's own default
 * stands in rather than an invented value.
 */
const restElementActual = (to: CallableAbi, restOrdinal: number, position: number, parameter: AbiParameter): string | null => {
  const slot = to.parameters[restOrdinal]
  if (slot === undefined) return null
  if (slot.value.kind === 'record') return restTupleFieldActual(slot.value, restOrdinal, position, parameter)
  if (slot.value.kind !== 'array-object') return null
  const element = slot.value.element
  const rest = adapterFormalName(restOrdinal)
  const elementType = cppTypeOf(element)
  const access =
    `(${rest}.get() == nullptr || ${rest}->size() <= static_cast<std::size_t>(${position}) ` +
    `? ${elementType}() : ${rest}->readElement(${position}))`
  if (samePhysicalCarrier(element, parameter.value)) return access
  try {
    return convertedValueText(element, parameter.value, access)
  } catch (error) {
    if (isCppEmitBlockedError(error)) return null
    throw error
  }
}

/** `gea::detail::emptyContainerAs` for a shared array or dictionary field whose elements do not convert. */
const emptyContainerRecastText = (from: Representation, to: Representation, read: string): string | null => {
  const container = (carrier: Representation): boolean =>
    ((carrier.kind === 'array-object' && !carrier.recursive && !carrier.extension) ||
      (carrier.kind === 'dictionary' && carrier.key === 'string')) &&
    carrier.ownership === 'shared-refcount'
  if (from.kind !== to.kind || !container(from) || !container(to)) return null
  return `gea::detail::emptyContainerAs<${cppTypeOf(to, 'owned')}>(${read}, "a container recast")`
}

/**
 * An object the program asserts (`env as unknown as Bindings`) or narrows
 * (`body instanceof Uint8Array` over a declared `string | ReadableStream`)
 * into a union none of whose arms it can become, even as a structural view. The
 * assertion went through `unknown`, so it is carried as that: boxed, then
 * read back out with the exact-type check every box read makes, which aborts
 * by name when the value is not what the program claimed rather than
 * inventing a layout. The last resort after `structuralRecordViewText`, and
 * asked only there and in the census's matching fallback.
 */
export const boxedAssertionText = (source: Representation, target: Representation, text: string): string | null => {
  const objectLike = (carrier: Representation): boolean =>
    (carrier.kind === 'record' || carrier.kind === 'native-record-ref' || carrier.kind === 'class-ref') &&
    carrier.ownership === 'shared-refcount'
  const union = target.kind === 'optional' ? target.payload : target
  if (!objectLike(source) || union.kind !== 'tagged-union') return null
  if (!boxLandsInAnArm(source, union)) return null
  const boxed = dynamicCarrierBoxText(source, text)
  if (boxed === null) return null
  return tryCandidateText(() => convertedValueText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target, boxed))
}

/**
 * Whether the box `boxedAssertionText` makes of `source` can pass the
 * dispatch `unboxedLoadText` runs over `union`: the union has a dynamic
 * remainder arm, or some arm's own discriminant matches what boxing `source`
 * records -- the same tag and C++ payload type, or, for a class arm, a class
 * allocation whose family the run-time identity check may find it in (a
 * downcast the program asserted).
 *
 * Anything else is a box no arm reads back: the dispatch's final
 * `refusePayloadMismatch` is the only path it has, so every value, however
 * well it satisfies the union's TypeScript type, aborts at run time. A
 * named `[key: string]: any` interface handed to `Document | Document[]` was
 * the measured case, before its own recast existed. Refusing here turns that
 * certain abort into the missing-conversion row certify names.
 */
const boxLandsInAnArm = (source: Representation, union: Extract<Representation, { kind: 'tagged-union' }>): boolean => {
  if (union.arms.some((arm) => arm.value.kind === 'dynamic' && arm.value.reason !== 'untyped-callable')) return true
  const boxed = boxDiscriminantsOf(source)
  if (boxed === null) return false
  const payload = cppTypeOf(source)
  const admits = (accept: BoxDiscriminant, box: BoxDiscriminant): boolean => {
    if (accept.callableMembers !== null || accept.tag !== box.tag) return false
    if (accept.nominal !== null) return box.nominal !== null
    return accept.payload === null || accept.payload === payload
  }
  return union.arms.some((arm) => boxDiscriminantsOfArm(arm)?.some((accept) => boxed.some((box) => admits(accept, box))) === true)
}

/** The slot parameters from `first` on, packed into the source's rest Array -- see `restPack` in `resultAdapterOf`. */
const restPackedActual = (slots: readonly AbiParameter[], first: number, element: Representation): string | null => {
  const elementType = cppTypeOf(element)
  const elements: string[] = []
  for (const [offset, slot] of slots.entries()) {
    const formal = adapterFormalName(first + offset)
    if (cppTypeOf(slot.value) === elementType) {
      elements.push(formal)
      continue
    }
    try {
      const converted = convertedValueText(slot.value, element, formal)
      if (converted === null) return null
      elements.push(converted)
    } catch (error) {
      if (isCppEmitBlockedError(error)) return null
      throw error
    }
  }
  return `gea::arrayOf<${elementType}>({${elements.join(', ')}})`
}

/** The lambda's own names, kept out of every body-local namespace this text can be spliced into. */
const adapterEnvironmentName = 'gea_adapt_environment'
const adapterReceiverName = 'gea_adapt_receiver'
const adapterResultName = 'gea_adapt_result'
const adapterFormalName = (ordinal: number): string => `gea_adapt_arg_${ordinal}`

/** The local a promise-to-promise conversion binds its source to, for the same reason the adapter names above are what they are. */
const promiseSourceName = 'gea_promise_source'

/** `promiseSourceName`'s twins: the promise a payload reconciliation settles, and the rejection it forwards. */
const promiseTargetName = 'gea_promise_target'
const promiseRejectionName = 'gea_promise_rejection'
/** The fulfilment value a pending source hands the payload reconciliation, once it exists. */
const promiseValueName = 'gea_promise_value'

/**
 * The local `recastedUnionText` binds its source to, and the alias it binds
 * the target's spelling to, once per multi-arm recast -- not per arm.
 *
 * A fixed name rather than a generated one, same as `promiseSourceName`
 * above: every use sits inside its own IIFE's block scope (or, for a nested
 * inner-union arm, inside an IIFE nested textually inside this one), and a
 * C++ inner scope shadowing an outer one by the same name is ordinary,
 * unambiguous re-declaration -- not a collision -- because the argument that
 * feeds the inner IIFE is evaluated in the OUTER scope before the inner
 * parameter's own binding takes over.
 */
const recastUnionSourceName = 'gea_recast_source'
const recastUnionAliasName = 'GeaRecastArm'

/**
 * A callable whose declared parameters or result convert into its slot's ABI.
 *
 * `gea::CallableObject` declares four converting constructors and every one of
 * them hands the source's result through untouched -- they change the ARITY
 * (`dropArguments`, `dropTrailingArguments`, `spreadRestOverLeading`) or read
 * a result the runtime can already reach by arm index (`widenResultIntoArm`,
 * whose `ResultWidensIntoArm` trait needs a `TaggedUnion` target whose arm IS
 * the source result). None of them can BOX one, and that is not an omission
 * to fix in the header: which `Value::Tag` a carrier boxes to is
 * `dynamicTagFor`'s table, it lives in this emitter, and a second copy of it
 * in `gea_runtime.h` is precisely the two-authorities defect this compiler
 * exists to avoid.
 *
 * A handler union `H = Handler | MiddlewareHandler` is the case that needs it:
 * `Handler<E, P, I, R = any>` defaults its result parameter to `any`, so both
 * arms take `(Context, Next)` and return `any`/`Promise<any>` while every
 * handler a program writes returns something concrete. Same frame, boxed
 * result.
 *
 * So the adapter is rendered HERE, where the tag table is, through
 * `CallableObject`'s own public `(Invoke, void*)` constructor: a CAPTURELESS
 * lambda (`+[]` decays it to the `Result (*)(void*, Arguments...)` pointer
 * that constructor takes) over a heap copy of the source, which is the exact
 * environment-carrying shape the header's own four constructors use.
 *
 * What it refuses, and why each is not a case to widen into later:
 *
 * - A source receiver that the target does not supply. A receiver-free
 *   source, however, can fill a method slot: its ABI proves the body consumes
 *   no dynamic receiver, so the adapter ignores the target's receiver. This
 *   is how an arrow assigned to an instance method keeps its lexical `this`.
 *   Two receiver-bearing conventions adapt the
 *   target receiver into the source receiver exactly like an ordinary
 *   parameter; it is the first physical formal in both ABIs.
 * - A source frame wider than its slot, or a different rest placement. The
 *   adapter may ignore target arguments after the source's declared prefix,
 *   just as an ordinary JavaScript call does; it never invents arguments the
 *   source declared but the target does not supply.
 * - A void source result flowing anywhere except void or dynamic. Calling a
 *   JavaScript function that returns no value produces `undefined`, so a
 *   genuinely dynamic result receives the runtime's default Undefined box;
 *   no other concrete carrier may be invented from it.
 * - A pair whose parameters and result already share C++ spellings. It needs
 *   no adapter and must not get one, or an identity store would allocate.
 */
const resultAdapterOf = (
  source: Representation,
  target: Representation,
  viaView?: LayoutConversion
): {
  readonly from: CallableAbi
  readonly to: CallableAbi
  readonly receiverActual: string | null
  readonly actuals: readonly string[]
  readonly convertedResult: string | null
  readonly nativeFieldProtocolUnused: boolean
} | null => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return null
  if (from.argumentsFrame !== to.argumentsFrame && !(from.restFrom === 0 && to.restFrom === 0)) return null
  if (from.receiver !== null && to.receiver === null) return null
  const ignoresReceiver = from.receiver === null && to.receiver !== null
  // A fixed-arity source filling a slot whose trailing frame is ONE rest array:
  // `(...args: any[]) => void`, JavaScript's "some function, arguments not my
  // business" idiom. A family of assertion helpers passes itself through it --
  // `assertDefined(value, message, mark || checkDefined)` -- and every such
  // argument refused to lower, hundreds of rows in one module, because
  // the rest placements did not match. They do not have to: the language
  // defines the call exactly, the slot binds one Array and the source reads its
  // own parameters positionally out of it. The rest ELEMENT is what makes this
  // sound rather than a guess -- a slot declared `any[]` is a genuine dynamic
  // boundary, so each source parameter is filled through the same conversion an
  // ordinary dynamic argument already takes, and a slot whose element cannot
  // convert leaves `null` here and keeps the refusal.
  // The slot's trailing frame is one rest parameter whichever way the checker
  // spelled it: an open `any[]` Array, or the closed TUPLE
  // `Function.prototype.call`'s `A extends any[]` infers from the call's own
  // arguments -- see `restTupleFieldActual` for why those are the same
  // positions in two carriers.
  const restSlotKind = to.restFrom === null ? undefined : to.parameters[to.restFrom]?.value.kind
  const restSpread =
    from.restFrom === null &&
    to.restFrom !== null &&
    to.parameters.length === to.restFrom + 1 &&
    from.parameters.length >= to.restFrom &&
    (restSlotKind === 'array-object' || restSlotKind === 'record')
  // A source formal past the end of the slot's frame is OMITTED at every call
  // the slot admits, and ECMA-262 10.2.1 binds an omitted parameter to
  // `undefined` -- a value the language supplies, not one the adapter invents.
  // So the refusal is not "the source frame is wider" but "a source formal
  // past the slot's frame cannot hold the absence", which `cppUndefinedIn`
  // (the one authority `paddedArguments` already asks at a direct call that
  // omits a trailing argument) answers. The measured case is
  // `export const getParam: (url, key?) => ... = _getParam as
  // (...)`, where `_getParam` declares a third `multiple?: boolean`; the
  // slot is the only contract any caller has, so the third formal is
  // `Optional<bool>()` at every one of them.
  //
  // A rest parameter is not an omitted argument -- what a caller owes one is
  // an allocated array -- so a source with a rest keeps the arity refusal.
  const omitted = !restSpread && from.restFrom === null && from.parameters.length > to.parameters.length
  // The mirror: a source whose trailing frame is one rest Array filling a
  // slot of fixed parameters. The slot's parameters from the rest position on
  // are the arguments the source's Array binds, so the adapter packs them.
  // An optional slot parameter is packed even when a caller omitted it, so
  // the Array's length counts every slot position.
  const restParameter = from.restFrom === null ? undefined : from.parameters[from.restFrom]
  const restPack =
    !restSpread &&
    from.restFrom !== null &&
    to.restFrom === null &&
    from.parameters.length === from.restFrom + 1 &&
    to.parameters.length >= from.restFrom &&
    restParameter?.value.kind === 'array-object' &&
    restParameter.value.ownership === 'shared-refcount' &&
    !restParameter.value.recursive
  if (!restSpread && !restPack) {
    if (from.restFrom !== to.restFrom) return null
    if (from.parameters.length > to.parameters.length && !omitted) return null
    if (omitted && from.parameters.slice(to.parameters.length).some((parameter) => cppUndefinedIn(parameter.value) === null)) return null
  }

  let receiverActual: string | null = null
  if (from.receiver !== null && to.receiver !== null) {
    const narrowedReceiver = receiverDowncastText(to.receiver, from.receiver, adapterReceiverName)
    if (samePhysicalCarrier(from.receiver, to.receiver)) {
      receiverActual = adapterReceiverName
    } else if (narrowedReceiver !== null) {
      receiverActual = narrowedReceiver
    } else {
      try {
        receiverActual = convertedValueText(to.receiver, from.receiver, adapterReceiverName)
      } catch (error) {
        if (isCppEmitBlockedError(error)) return null
        throw error
      }
      if (receiverActual === null) return null
    }
  }
  const actuals: string[] = []
  const restOrdinal = to.restFrom
  for (const [ordinal, parameter] of from.parameters.entries()) {
    if (restSpread && restOrdinal !== null && ordinal >= restOrdinal) {
      const spread = restElementActual(to, restOrdinal, ordinal - restOrdinal, parameter)
      if (spread === null) return null
      actuals.push(spread)
      continue
    }
    if (restPack && ordinal === from.restFrom && parameter.value.kind === 'array-object') {
      const packed = restPackedActual(to.parameters.slice(ordinal), ordinal, parameter.value.element)
      if (packed === null) return null
      actuals.push(packed)
      continue
    }
    const slot = to.parameters[ordinal]
    if (slot === undefined) {
      const absent = omitted ? cppUndefinedIn(parameter.value) : null
      if (absent === null) return null
      actuals.push(absent)
      continue
    }
    const formal = adapterFormalName(ordinal)
    if (cppAbiParameterType(parameter) === cppAbiParameterType(slot)) {
      actuals.push(formal)
      continue
    }
    let converted: string | null
    try {
      converted = convertedValueText(slot.value, parameter.value, formal)
    } catch (error) {
      if (!isCppEmitBlockedError(error)) throw error
      converted = null
    }
    converted ??= viaView?.(slot.value, parameter.value, formal) ?? null
    if (converted === null) return null
    actuals.push(converted)
  }

  let convertedResult: string | null
  if (to.result.kind === 'void') {
    convertedResult = null
  } else if (from.result.kind === 'void') {
    // A body that completes without a value returns `undefined`, so a slot
    // whose result can hold `undefined` (`PromiseLike.then`'s
    // `TResult | PromiseLike<TResult>` at `TResult = void`) receives exactly
    // that; a slot that cannot is a genuine mismatch.
    convertedResult = cppUndefinedIn(to.result)
    if (convertedResult === null) return null
  } else if (samePhysicalCarrier(from.result, to.result)) {
    convertedResult = adapterResultName
  } else if (
    from.overloadJoined === true &&
    from.result.kind === 'optional' &&
    to.result.kind !== 'optional' &&
    samePhysicalCarrier(from.result.payload, to.result)
  ) {
    // A call naming one overload of a callback-joined set
    // (`host-abi.ts`'s `callbackOverloadJoinedAbi`): that overload answers
    // the value, so the joined frame's `undefined` is the OTHER overload's
    // answer -- the callee broke its own declaration, a TypeError, never a
    // default-constructed payload.
    convertedResult = `(*gea::host::presentOrThrow(${adapterResultName}))`
  } else {
    try {
      convertedResult = convertedValueText(from.result, to.result, adapterResultName)
    } catch (error) {
      if (!isCppEmitBlockedError(error)) throw error
      convertedResult = null
    }
    convertedResult ??= assertedResultNarrowingText(from.result, to.result, adapterResultName)
    if (convertedResult === null) return null
  }

  const receiverChanges = receiverActual !== null && receiverActual !== adapterReceiverName
  const nativeReceiverTransport =
    from.receiver !== null && to.receiver !== null && classRefTransportKind(to.receiver, from.receiver) !== null
  const ignoresParameters = from.parameters.length < to.parameters.length
  const parametersChange = actuals.some((actual, ordinal) => actual !== adapterFormalName(ordinal))
  const resultChanges = from.result.kind !== to.result.kind || (from.result.kind !== 'void' && !samePhysicalCarrier(from.result, to.result))
  // A source whose fixed frame ends before the slot's rest reads no element
  // of that Array: nothing is unboxed and the Array itself is never passed.
  // A program handing `() => new SomeClass(...)`-shaped thunks to `(...args: any[])
  // => void` slots is the case; counting that as a spread made the census publish the
  // thunk's result class, and everything it reaches, to full reflection.
  const spreadsRest = restSpread && to.restFrom !== null && from.parameters.length > to.restFrom
  const nativeFieldProtocolUnused =
    !spreadsRest &&
    !restPack &&
    (!receiverChanges || nativeReceiverTransport) &&
    !parametersChange &&
    (from.result.kind === 'void' || to.result.kind === 'void' || samePhysicalCarrier(from.result, to.result))
  return ignoresReceiver || ignoresParameters || receiverChanges || parametersChange || resultChanges
    ? { from, to, receiverActual, actuals, convertedResult, nativeFieldProtocolUnused }
    : null
}

/**
 * A callable's result read into a slot whose result union is NARROWER -- arms
 * of the source's result the slot does not declare.
 *
 * The checker admits a callable into such a slot only through an assertion:
 * a function's result must be assignable to its slot's, so the pair exists
 * because the program wrote `f as (...) => Narrower`. The measured case
 * is a helper whose `string | undefined |
 * Record<string, string> | string[] | Record<string, string[]>` asserted to
 * `string | undefined | Record<string, string>`, the two array arms reachable
 * only through the third parameter the slot omits. The assertion is checked
 * per call, the same `CHECKED_ARM_NARROWING` a union read into a slot homing
 * only some of its arms takes: each declared arm converts, and an undeclared
 * one is a `TypeError`, never read as another. An optional layer on both
 * sides passes its absence through.
 */
const assertedResultNarrowingText = (from: Representation, to: Representation, text: string): string | null => {
  if (from.kind === 'tagged-union' && to.kind === 'tagged-union') return checkedArmNarrowingText(from, to, text)
  if (from.kind !== 'optional' || to.kind !== 'optional' || from.absence !== to.absence) return null
  if (from.payload.kind !== 'tagged-union' || to.payload.kind !== 'tagged-union') return null
  const targetType = cppTypeOf(to)
  const present = checkedArmNarrowingText(from.payload, to.payload, '(*gea_adapt_present)')
  if (present === null) return null
  return (
    `([&](const ${cppTypeOf(from)}& gea_adapt_present) -> ${targetType} { ` +
    `if (!gea_adapt_present.has_value()) return ${targetType}(); return ${targetType}(${present}); }(${text}))`
  )
}

/**
 * A callable whose `this` is a descendant class (or the copies of a split
 * generic class, `derive.ts`'s `anyCopyFamilyOf`) filling a slot whose
 * receiver is an ancestor: node's `EventEmitter` calls every listener with
 * `fn.apply(this, args)`, and a program may register `function
 * onClose(this: BaseClass)` on instances of its own subclasses. The function
 * only ever runs against the object that emitted, so the receiver narrows to
 * the arm whose class the allocation extends -- most specific arm first, read
 * off the allocation's own `classBase` chain, which is emitted only from
 * checker-proven bases. A receiver no arm claims is a TypeError, never a
 * reinterpretation: TypeScript accepted the pair only through a `this`-free
 * signature, so nothing proved the call's receiver fits.
 */
const receiverDowncastText = (held: Representation, wanted: Representation, text: string): string | null => {
  if (held.kind !== 'class-ref') return null
  const arms =
    wanted.kind === 'class-ref'
      ? [{ arm: wanted, index: -1 }]
      : wanted.kind === 'tagged-union' && wanted.arms.every((arm) => arm.value.kind === 'class-ref')
        ? wanted.arms.map((arm, index) => ({ arm: arm.value as Extract<Representation, { kind: 'class-ref' }>, index }))
        : null
  if (arms === null || arms.length === 0) return null
  if (!arms.every(({ arm }) => arm.ownership === held.ownership && arm.ancestors.includes(held.declaration))) return null
  const ordered = [...arms].sort((left, right) => {
    const leftBelow = left.arm.ancestors.includes(right.arm.declaration)
    const rightBelow = right.arm.ancestors.includes(left.arm.declaration)
    return leftBelow === rightBelow ? left.index - right.index : leftBelow ? -1 : 1
  })
  const wantedType = cppTypeOf(wanted)
  const identity = `gea::detail::refPayloadIdentity(${text})`
  const branches = ordered.map(({ arm, index }) => {
    const narrowed = `gea::host::downcastClassRef<${cppClassName(arm.declaration)}>(${text})`
    const value = index < 0 ? narrowed : `${wantedType}::ofArm<${index}>(${narrowed})`
    return `if (gea::detail::classIdentityExtends(${identity}, &gea::detail::RefOperationsFor<${cppClassName(arm.declaration)}>::table)) return ${value};`
  })
  return (
    `[&]() -> ${wantedType} { ${branches.join(' ')} ` +
    `gea::host::throwRuntimeError("TypeError", "a function was called with a receiver its this parameter does not accept"); }()`
  )
}

/** Whether `source` reaches `target` through a result adapter -- see `resultAdapterOf`. Exported so `conversions.ts` asks the identical question the render below answers. */
export const adaptsResultIntoTarget = (source: Representation, target: Representation): boolean => resultAdapterOf(source, target) !== null

/** The same adapter selection used by the printer publishes its transport facts to the conversion census. */
export const resultAdapterTransportOf = (
  source: Representation,
  target: Representation
): { readonly nativeConventions: { readonly from: CallableAbi; readonly to: CallableAbi } | null } | null => {
  const adapter = resultAdapterOf(source, target)
  return adapter === null ? null : { nativeConventions: adapter.nativeFieldProtocolUnused ? { from: adapter.from, to: adapter.to } : null }
}

/** The adapter itself, or `null` for a pair that needs none -- see `resultAdapterOf`. */
/**
 * A conversion only the emitter's layouts can answer: a structural record view
 * (`emit-record-view.ts`), whose `native-record-ref` arms name a layout rather
 * than carry one. The chain is layout-free, so it asks this only when its
 * caller -- the census's `staticRecipe`, the printer's `recipeText` -- has the
 * layouts in hand.
 */
export type LayoutConversion = (source: Representation, target: Representation, text: string) => string | null

/**
 * The materializer id of a callable adapter one of whose PARAMETERS converts
 * only through a structural view: a platform-selected byte-utility slot
 * `(Uint8Array | ArrayBufferView | ArrayBuffer) => Uint8Array` holding an
 * implementation declared over `Uint8Array | (ArrayBufferView & { [Symbol.toStringTag]?: string })
 * | ArrayBuffer`. The slot's `ArrayBufferView` arm is a `native-record-ref`
 * reaching the method's intersection record by a record view; the chain's
 * adapter has no layouts and could only select the arms the two share.
 */
export const VIEW_ADAPTED_CALLABLE = 'view:adapted-callable'

/**
 * A union read into a slot some of whose arms it homes and some of which it
 * does not, where no view homes them all -- the census's last recipe before
 * the boxed assertion (`conversions.ts`'s `staticRecipe`). The homed arms
 * convert as the chain's narrowing converts them; each unhomed arm is a
 * checked `TypeError` (`gea::host::unhomedUnionArm`), never read as another.
 * The chain's own narrowing refuses the pair instead (`partialWidening`), so
 * a whole-sum view is still asked first.
 */
export const CHECKED_ARM_NARROWING = 'view:checked-arm-narrowing'

/**
 * An `Array<any>` arm (`unknown[]`, `any[]`) the program asserts to an array
 * of a typed element, rebuilt element-wise: each element is admitted by its own
 * check (a `TypeError` for one that cannot be the element) and then unboxed.
 * The result is a fresh array -- the typed carrier cannot alias storage whose
 * elements are boxes. `null` for any other pair, and for an element with no
 * checked unbox.
 */
const dynamicArrayRebuildText = (arm: Representation, target: Representation, text: string): string | null => {
  if (arm.kind !== 'array-object' || target.kind !== 'array-object') return null
  if (arm.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return null
  if (arm.extension !== null || target.extension !== null) return null
  if (arm.element.kind !== 'dynamic' || arm.element.reason === 'untyped-callable' || target.element.kind === 'dynamic') return null
  const element = 'gea_element'
  const load = unboxedLoadText(target.element, element)
  if (load === null) return null
  const admission =
    target.element.kind === 'class-ref' && target.element.ownership === 'shared-refcount'
      ? `gea::host::boxedClassRefAdmits<${cppClassName(target.element.declaration)}>(${element})`
      : dynamicFieldAdmissionText(target.element, element)
  const body =
    (admission === null
      ? ''
      : `if (!(${admission})) gea::host::throwRuntimeError("TypeError", "an array element cannot be the element type the array is asserted to"); `) +
    `return ${load};`
  return `gea::host::rebuildDynamicArray<${cppTypeOf(target.element)}>(${text}, [](const gea::Value& ${element}) -> ${cppTypeOf(target.element)} { ${body} })`
}

/**
 * `nodes.ts`'s `assertedUnionFor`, rendered: the live arm is dispatched on, never
 * assumed. An arm with a conversion into the target converts; an `Array<any>`
 * arm is rebuilt element-wise (`dynamicArrayRebuildText`) only where
 * `copyAllowed`, since the rebuild is a copy; an arm that cannot be the target
 * (or may not be copied) is a `TypeError` (`gea::host::unhomedUnionArm`). `null` when no arm
 * can be the target at all, which the printer refuses.
 */
export const assertedUnionText = (source: Representation, target: Representation, text: string, copyAllowed: boolean): string | null => {
  // An absent-capable union: the absence converts as its own constant, the
  // present payload dispatches per arm below.
  if (source.kind === 'optional' && source.payload.kind === 'tagged-union') {
    const payload = source.payload
    return tryCandidateText(() =>
      evaluatedOnceText(text, (operand) => {
        const present = assertedUnionText(payload, target, `(*${operand})`, copyAllowed)
        const absent = convertedValueText({ kind: source.absence }, target, source.absence === 'null' ? 'nullptr' : 'gea::Undefined{}')
        return present === null || absent === null ? null : `(${operand}.has_value() ? ${present} : ${absent})`
      })
    )
  }
  if (source.kind !== 'tagged-union') return null
  const targetKey = representationKey(target)
  return tryCandidateText(() =>
    evaluatedOnceText(text, (operand) => {
      const homes = source.arms.map((arm, index) => {
        const slot = `${operand}.get<${index}>()`
        if (representationKey(arm.value) === targetKey) return slot
        return (
          tryCandidateText(() => convertedValueText(arm.value, target, slot) ?? narrowedLoadText(arm.value, target, slot)) ??
          (copyAllowed ? dynamicArrayRebuildText(arm.value, target, slot) : null)
        )
      })
      if (homes.every((home) => home === null)) return null
      let result = `gea::host::unhomedUnionArm<${cppTypeOf(target)}>(${operand}.index())`
      for (let index = homes.length - 1; index >= 0; index -= 1) {
        const home = homes[index]
        if (home !== null && home !== undefined) result = `${operand}.is<${index}>() ? ${home} : (${result})`
      }
      return `(${result})`
    })
  )
}

/**
 * `nodes.ts`'s `assertedViewFor`: a record asserted into a slot whose object
 * homes are classes. Each class arm the plan names, descendant first, is tested
 * by the view's origin and loads that allocation through its cited node; no
 * origin is the assertion failing.
 */
const assertedViewText = (ctx: ConversionSite, node: ConversionNode, plan: AssertedViewPlan, text: string): string | null => {
  const { source, target } = node
  return tryCandidateText(() =>
    evaluatedOnceText(text, (operand) => {
      const held = source.kind === 'optional' ? `(*${operand})` : operand
      let present = `gea::host::unhomedAssertedRecord<${cppTypeOf(target)}>()`
      for (const arm of [...plan.arms].reverse()) {
        const name = cppClassName(arm.declaration)
        const home = recipeText(ctx, arm.load, `gea::record::viewOriginClassRef<${name}>(${held})`)
        if (home === null) return null
        present = `(gea::record::viewOriginClassIs<${name}>(${held}) ? ${home} : ${present})`
      }
      if (source.kind !== 'optional') return present
      if (plan.absent === null) return null
      const absent = recipeText(ctx, plan.absent, source.absence === 'null' ? 'nullptr' : 'gea::Undefined{}')
      return absent === null ? null : `(${operand}.has_value() ? ${present} : ${absent})`
    })
  )
}

export const checkedArmNarrowingText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'tagged-union' || target.kind !== 'tagged-union') return null
  return tryCandidateText(() => evaluatedOnceText(text, (operand) => taggedUnionArmText(source, target, operand, 'throw')))
}

export const resultAdaptedCallableText = (
  source: Representation,
  target: Representation,
  text: string,
  viaView?: LayoutConversion,
  knownFunction?: FunctionId
): string | null => {
  const adapter = resultAdapterOf(source, target, viaView)
  if (adapter === null) return null
  const sourceType = cppTypeOf(source)
  const formals = [
    `void* ${adapterEnvironmentName}`,
    ...(adapter.to.receiver === null ? [] : [`${cppTypeOf(adapter.to.receiver)} ${adapterReceiverName}`]),
    ...adapter.to.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${adapterFormalName(ordinal)}`)
  ]
  const sourceActuals = [...(adapter.receiverActual === null ? [] : [adapter.receiverActual]), ...adapter.actuals]
  // A source that names its one function -- by its representation, or because the
  // emitter saw the expression allocate it -- is called through that function's
  // thunk on the environment it already has, so the adapted view allocates nothing
  // (`CallableObject::adaptSourceInPlace`); any other source is held in a block.
  const knownId = source.kind === 'function' ? source.functionId : (knownFunction ?? null)
  const known = knownId === null ? null : cppThunkName(knownId)
  const call =
    known === null
      ? `static_cast<${sourceType}*>(${adapterEnvironmentName})->call(${sourceActuals.join(', ')})`
      : `${known}(${[adapterEnvironmentName, ...sourceActuals].join(', ')})`
  const bodyOf = (invocation: string): string =>
    adapter.from.result.kind === 'void'
      ? `${invocation};${adapter.convertedResult === null ? '' : ` return ${adapter.convertedResult};`}`
      : adapter.to.result.kind === 'void'
        ? `${invocation};`
        : `${cppTypeOf(adapter.from.result)} ${adapterResultName} = ${invocation}; return ${adapter.convertedResult};`
  if (known === null && adapter.from.receiver === null) {
    const receiverActual =
      adapter.to.receiver === null
        ? 'gea::NativeCallReceiver::undefined()'
        : nativeCallReceiverText(adapter.to.receiver, adapterReceiverName)
    const invokeWith = (receiver: string): string =>
      `static_cast<${sourceType}*>(${adapterEnvironmentName})->callWithReceiver(${[receiver, ...adapter.actuals].join(', ')})`
    const receiverFormals = [`void* ${adapterEnvironmentName}`, 'const gea::NativeCallReceiver& gea_adapt_this', ...formals.slice(1)]
    return (
      `${cppTypeOf(target)}::adaptSourceWithReceiver<${cppCallableFrameArguments(adapter.to)}>(${sourceType}{${text}}, ` +
      `[](${formals.join(', ')}) -> ${cppResultTypeOf(adapter.to.result)} { ${bodyOf(invokeWith(receiverActual))} }, ` +
      `[](${receiverFormals.join(', ')}) -> ${cppResultTypeOf(adapter.to.result)} { ${bodyOf(invokeWith('gea_adapt_this'))} })`
    )
  }
  const frame = cppCallableFrameArguments(adapter.to)
  const adapt = known === null ? `adaptSource<${frame}>` : `adaptSourceInPlace<&${known}, ${frame}>`
  return `${cppTypeOf(target)}::${adapt}(${sourceType}{${text}}, [](${formals.join(', ')}) -> ${cppResultTypeOf(adapter.to.result)} { ${bodyOf(call)} })`
}

/**
 * A class stored into a construct-signature slot whose convention differs from
 * the class's own -- `const bindings: { Impl: ImplConstructor } =
 * { Impl: NativeImpl }`, where the slot's `new` answers an
 * interface and the class's answers its own instance.
 *
 * The adapter keeps the class evaluation as its environment, so the value is
 * still the same constructor object: `===`, its `FunctionObjectIdentity` own
 * table and the class dispatch a property read performs
 * (`emit-dynamic-properties.ts`'s `constructorValueDispatchGetText`) all key on
 * that environment, not on the construct entry. Only the entry is rewritten, to
 * convert each slot argument into the class's formal and the class's instance
 * into the slot's result. Any piece that has no installed conversion refuses
 * the whole adapter, and the store with it.
 */
const constructorDispatchAdapterText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'constructor-family' || target.kind !== 'constructor-value-dispatch') return null
  const members = source.members
  if (members.length === 0) return null
  const from = source.abi
  const to = target.abi
  if (from.receiver !== null || to.receiver !== null) return null
  if (from.restFrom !== null || to.restFrom !== null) return null
  if (from.parameters.slice(to.parameters.length).some((parameter) => cppUndefinedIn(parameter.value) === null)) return null
  const formals = to.parameters.map((parameter, index) => `${cppAbiParameterType(parameter)} gea_argument_${index}`)
  const actuals: string[] = []
  for (const [index, slot] of from.parameters.entries()) {
    const parameter = to.parameters[index]
    if (parameter === undefined) {
      actuals.push(cppUndefinedIn(slot.value)!)
      continue
    }
    const name = `gea_argument_${index}`
    if (cppAbiParameterType(parameter) === cppAbiParameterType(slot)) {
      actuals.push(`std::forward<${cppAbiParameterType(parameter)}>(${name})`)
      continue
    }
    const converted = tryCandidateText(() => convertedValueText(parameter.value, slot.value, name))
    if (converted === null) return null
    actuals.push(converted)
  }
  if (from.result.kind === 'void' || to.result.kind === 'void') return null
  const invocationOf = (member: DeclarationId): string =>
    `${cppConstructThunkName(member)}(gea_environment${actuals.map((actual) => `, ${actual}`).join('')})`
  const resultType = cppResultTypeOf(to.result)
  let body: string
  const [sole] = members
  if (members.length === 1 && sole !== undefined) {
    const invocation = invocationOf(sole)
    const result = samePhysicalCarrier(from.result, to.result)
      ? invocation
      : tryCandidateText(() => convertedValueText(from.result, to.result, invocation))
    if (result === null) return null
    body = `return ${result};`
  } else {
    // Several classes: a construct entry cannot capture the one it replaces, so
    // the member is recognized by the class evaluation the environment IS --
    // the declaration token `allocateNativeClassMethodEnvironment` stamped --
    // and each member's own thunk runs, its instance handed back through the
    // slot's class-ref (`gea::Ref`'s converting constructor, which only
    // admits a derived-to-base pair). A class this family does not name
    // refuses rather than constructing through another body.
    if (to.result.kind !== 'class-ref') return null
    const arms = members.map(
      (member) =>
        `if (gea_class == &gea::nativeClassMethodDeclaration<${cppClassName(member)}>) return ${resultType}(${invocationOf(member)}); `
    )
    body =
      `const void* gea_class = static_cast<gea::NativeClassMethodState*>(gea_environment)->declaration; ${arms.join('')}` +
      `gea::detail::refusePayloadMismatch("a constructor family value holds a class its family does not name");`
  }
  return (
    `[](const ${cppTypeOf(source)}& gea_from) { ${cppTypeOf(target)} gea_to; ` +
    `gea_to.construct_ = +[](void* gea_environment${formals.map((formal) => `, ${formal}`).join('')}) -> ${resultType} { ` +
    `${body} }; ` +
    `gea_to.environment = gea_from.environment; gea_to.environmentOwner = gea_from.environmentOwner; return gea_to; }(${text})`
  )
}

/** Whether a class reaches a construct-signature slot through `constructorDispatchAdapterText`. Exported so `conversions.ts` asks the identical question the render answers. */
export const adaptsConstructorIntoDispatch = (source: Representation, target: Representation): boolean =>
  source.kind === 'constructor-family' &&
  target.kind === 'constructor-value-dispatch' &&
  !samePhysicalCarrier(source, target) &&
  constructorDispatchAdapterText(source, target, 'gea_probe') !== null

/**
 * A callable filling a slot that declares MORE parameters than it does, the
 * extra ones landing after every one the source itself names./**
 * A callable filling a slot that declares MORE parameters than it does, the
 * extra ones landing after every one the source itself names.
 *
 * ECMA-262 does not bind the extra arguments, so `() => void` really is a
 * `(time: number) => void` and TypeScript accepts it everywhere, and the same
 * is true one prefix over: a class field may merge two
 * `(request: Request) => string` values into a field declared
 * `(request: Request, options?: {env?}) => string` -- one shared leading
 * parameter, one trailing parameter neither physical function looks at.
 * `gea::CallableObject`'s own converting constructor (gea_runtime.h) performs
 * both shapes, so the value converts by being written where the wider one is
 * expected and needs no text of its own.
 *
 * The source's own parameters must be a TYPE-MATCHING PREFIX of the target's,
 * not merely a shorter count: converting an arbitrary prefix without proving
 * each shared position's type matches would let a wrong guess pass a value
 * into a slot expecting something else, which is what the runtime
 * constructor's own `IsTypePrefix` proves at compile time rather than
 * assumes, and this predicate re-asks the identical question so the two
 * cannot disagree about which pairs the constructor actually accepts. Every
 * position through the source's own last one has to agree, not only the
 * first -- `(a: string) => void` is not a sound stand-in for
 * `(a: string, b: number, c: string) => void` merely because position 0
 * matches; every position the source declares has to. The result and the
 * receiver must still agree exactly -- neither is dropped by a call, so a
 * difference in either is a real mismatch, not a binding the language elides.
 */
export const dropsUnboundParameters = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return false
  // Receivers are not part of the runtime constructor's own proof (it
  // matches on `Arguments...` alone), so a callable wearing one on either
  // side is not this shape.
  if (from.receiver !== null || to.receiver !== null) return false
  if (from.parameters.length >= to.parameters.length) return false
  if (representationKey(from.result) !== representationKey(to.result)) return false
  return from.parameters.every((parameter, index) => representationKey(parameter.value) === representationKey(to.parameters[index]!.value))
}

/**
 * A zero-parameter callable filling a slot that declares at least one
 * parameter AND whose result is a tagged union naming the source's own
 * result as one of its arms -- `dropsUnboundParameters`'s zero-arity special
 * case (`gea_runtime.h`'s `dropArguments`) composed with
 * `gea::TaggedUnion::ofArm`, for a source neither alone accepts:
 * `dropsUnboundParameters` requires an IDENTICAL result, and a bare `ofArm`
 * conversion has no arity adaptation of its own.
 *
 * A lazily defaulted field: `this.#handler ??=
 * () => makeResponse()` merges a `() => Response` into a field
 * declared `(c: Context) => Response | Promise<Response>`.
 * `gea_runtime.h`'s `ResultWidensIntoArm` proves the identical pairing at
 * the type level; this re-asks the same two-part question so the two cannot
 * disagree about which pairs the runtime constructor actually accepts.
 *
 * Deliberately narrower than `dropsUnboundParameters`: a nonzero source
 * arity is left entirely to that function (its PREFIX proof does not carry
 * over once the result itself also changes), and a target result that is
 * not a tagged union, or a source result that is not EXACTLY one of its
 * arms, is refused -- the same fail-closed discipline `ResultWidensIntoArm`
 * documents in the runtime.
 */
export const dropsAllParametersIntoResultArm = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return false
  if (from.receiver !== null || to.receiver !== null) return false
  if (from.parameters.length !== 0 || to.parameters.length === 0) return false
  if (to.result.kind !== 'tagged-union') return false
  const resultKey = representationKey(from.result)
  return to.result.arms.some((arm) => representationKey(arm.value) === resultKey)
}

/**
 * A callable filling a slot whose declared result is `void`, its own result
 * being anything else -- same parameters, in the same order, with the same
 * types; only the RESULT differs, and only in the direction of being
 * discarded.
 *
 * ECMA-262 makes this sound for a reason distinct from the other two
 * predicates above: a call's result is simply not read unless something
 * reads it, so a function returning `T` really is a valid `() => void` (or
 * any arity's `void`-returning form) wherever the caller never names the
 * result -- `Array.prototype.forEach`'s callback contract is the textbook
 * case, and this port's own is `node:http`'s `RequestListener = (req, res)
 * => void`: `createServer(async (req, res) => { ... })` is an everyday Node
 * idiom, and TypeScript accepts a
 * `Promise<void>`-returning callback there for the identical reason -- a
 * `void`-returning function TYPE is satisfied by ANY return type, precisely
 * so a caller who ignores the result is never forced to wrap it.
 *
 * `gea_runtime.h`'s `CallableObject` composed converting constructor this
 * asks for discards whatever the source returns; see that constructor's own
 * comment for why doing so is never lossy for an async body specifically --
 * the promise is only the caller's handle on the outcome: a suspended async
 * body's frame is owned by the reaction it is parked on, not by the promise
 * the call returned, so dropping that promise cancels nothing and the body
 * still runs to completion from the job queue.
 *
 * Gated the mirror of `dropsAllParametersIntoResultArm` above: parameters
 * must agree in COUNT and in every position's TYPE (this is not an arity
 * change, `dropsUnboundParameters`'s own axis -- it is a pure result
 * change), the receiver must agree exactly on both sides (a call's receiver
 * is never dropped), and the target's result must actually BE `void` --
 * anything else stays a hard compile error, this file's shared fail-closed
 * rule. Source and target already sharing `void` needs no constructor at
 * all: `cppTypeOf` equality above already renders that as the identity
 * text, so this predicate is never even asked.
 *
 * Zero parameters is excluded on the runtime constructor's own account, not
 * this predicate's: `gea_runtime.h`'s matching constructor collapses to the
 * textually identical signature the `ResultWidensIntoArm`-gated one above it
 * already declares once `Arguments...` is empty, which fails to COMPILE
 * (every zero-arity `CallableObject<Result()>` in the header, `Result=void`
 * or not) rather than merely fails to be selected -- see that constructor's
 * own comment. Asking this predicate to answer `false` there keeps the two
 * files agreeing about which pairs the runtime actually accepts, the same
 * discipline `dropsUnboundParameters` and `dropsAllParametersIntoResultArm`
 * both already state for their own exclusions.
 */
/**
 * A callable whose parameters already agree with the slot's, position for
 * position, and whose RESULT is exactly one arm of the tagged union the slot
 * declares -- `dropsAllParametersIntoResultArm` with the arity change taken
 * back out, leaving only the widening half.
 *
 * That predicate requires a ZERO-parameter source and `dropsUnboundParameters`
 * an IDENTICAL result, so a pair moving along only the result axis at a nonzero
 * arity satisfies neither -- e.g. a `(Context) =>
 * Response` assigned into a field declared `(Context) => Response |
 * Promise<Response>`. Sound for exactly the reason `gea_runtime.h`'s
 * `ResultWidensIntoArm` states, and asked in the same terms so the two cannot
 * disagree: the result must equal one arm EXACTLY and every other position --
 * receiver, arity, each parameter's carrier, the rest slot -- exactly, none
 * being adapted here. `widenResultIntoArm` is the constructor performing it.
 */
export const widensResultIntoArm = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return false
  if (from.receiver !== null || to.receiver !== null) return false
  if (from.parameters.length === 0 || from.parameters.length !== to.parameters.length) return false
  if (from.restFrom !== to.restFrom || from.argumentsFrame !== to.argumentsFrame || to.result.kind !== 'tagged-union') return false
  if (!from.parameters.every((parameter, index) => representationKey(parameter.value) === representationKey(to.parameters[index]!.value)))
    return false
  const resultKey = representationKey(from.result)
  return to.result.arms.some((arm) => representationKey(arm.value) === resultKey)
}

/**
 * A source whose rest parameter sits at a LATER position than the target's.
 *
 * ECMAScript has one calling convention, so `(base?: string, sub?: string,
 * ...rest: string[]) => string` and `(...paths: string[]) => string` are the
 * same function -- a module may declare exactly that pair on one
 * `const mergePath`, the annotation stating the second and the initializer
 * being the first. C++ sees two unrelated function types, and the store
 * refused.
 *
 * The target has to be a single rest parameter, because that array is the
 * whole of what the thunk has to unpack. Every leading source parameter has
 * to be `optional(E, undefined)` over the same element the rest carries: a
 * position the call never reached has to be ABSENT, and a leading slot must
 * never be handed an element of a type it did not declare. The source's own
 * rest must sit exactly after its leading run, since the tail is what is
 * left when those are taken.
 *
 * `gea_runtime.h`'s `RestRebaseAdmits` states the identical conditions over
 * the C++ types, so a pair this admits and that one does not is a compile
 * error rather than a wrong call -- the same fail-closed pairing every other
 * predicate here has with its constructor.
 */
export const rebasesRestOverLeadingParameters = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return false
  if (from.argumentsFrame === 'actual' || to.argumentsFrame === 'actual') return false
  if (from.receiver !== null || to.receiver !== null) return false
  if (representationKey(from.result) !== representationKey(to.result)) return false
  if (to.restFrom !== 0 || to.parameters.length !== 1) return false
  const leading = from.parameters.length - 1
  if (leading < 1 || from.restFrom !== leading) return false
  const slot = to.parameters[0]?.value
  const tail = from.parameters[leading]?.value
  if (!slot || !tail || slot.kind !== 'array-object') return false
  if (representationKey(slot) !== representationKey(tail)) return false
  const elementKey = representationKey(slot.element)
  return from.parameters
    .slice(0, leading)
    .every(
      (parameter) =>
        parameter.value.kind === 'optional' &&
        parameter.value.absence === 'undefined' &&
        representationKey(parameter.value.payload) === elementKey
    )
}

export const discardsResultIntoVoid = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to) return false
  if (from.restFrom !== to.restFrom || from.argumentsFrame !== to.argumentsFrame) return false
  if (from.receiver !== null || to.receiver !== null) return false
  if (to.result.kind !== 'void') return false
  if (to.parameters.length === 0) return false
  if (from.parameters.length !== to.parameters.length) return false
  return from.parameters.every((parameter, index) => representationKey(parameter.value) === representationKey(to.parameters[index]!.value))
}

/**
 * Reading a concrete value back OUT of a box -- the direction this backend did
 * not have.
 *
 * `x as unknown as string` is an ASSERTION, not a coercion: the program states
 * what the value is and TypeScript erases the statement, so what has to happen
 * at runtime is a read of the payload the box holds, not a `ToString` of
 * whatever it happens to be. `gea::unboxValue` (gea_runtime.h) is exactly that
 * read -- it checks the box's tag AND its payload type and aborts by name when
 * either disagrees, which is where the consequence of a wrong assertion
 * belongs. The identical primitive `emit-dynamic-properties.ts` already reads
 * a dynamic property back through; this states the same fact for an ordinary
 * carrier reconciliation.
 *
 * Every tag that has a payload to read, not only the three primitive ones.
 * This paragraph used to say the opposite -- that a record, a class instance,
 * a callable or an array was a box whose payload type the target carrier does
 * not determine, so there was no `T` to name -- and that premise is false: the
 * target carrier is exactly what determines the `T`, because `cppTypeOf`
 * spells it and `Value::box` recorded that same spelling's address in
 * `payloadType()`. `unboxValue` compares the two, so naming the wrong one
 * refuses by name instead of reinterpreting bytes.
 *
 * The stale claim outlived the code it described and was still being cited as
 * settled by `targets/cpp/conversions.ts`'s own header, which is how that
 * file's `classRefMaterializer` stayed uninstalled while the load it needed
 * was already being rendered right here.
 */
/**
 * Every `(tag, payload type)` pair a box can carry for this carrier.
 *
 * `dynamicTagFor` answers ONE tag and `null` for a sum, which is the right
 * answer to "what tag does `Value::box` write for this" and the wrong one to
 * "which tags could a box holding this carrier have". A union arm, and an
 * optional's two states, each answer to several. `payload` is `null` where the
 * tag IS the whole value (`undefined`, `null`) and there is therefore no
 * recorded payload type to tiebreak a tag collision with -- two such arms under
 * one tag are genuinely indistinguishable, and compare equal here so the
 * caller refuses rather than guessing.
 */
export type BoxDiscriminant = {
  tag: string
  payload: string | null
  nominal: string | null
  /** Exact checker-closed FunctionId membership; null for a non-callable discriminator. */
  callableMembers: readonly FunctionId[] | null
}

const callableMembershipOf = (carrier: Representation): readonly FunctionId[] | null | undefined => {
  switch (carrier.kind) {
    case 'function':
      return [carrier.functionId]
    case 'function-family':
    case 'function-value-family':
      return carrier.members.length > 0 ? [...new Set(carrier.members)].sort() : null
    case 'function-value-dispatch':
    case 'function-and-constructor':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'generic-function-set':
      return null
    case 'dynamic':
      return carrier.reason === 'untyped-callable' ? null : undefined
    default:
      return undefined
  }
}

export const boxDiscriminantsOf = (carrier: Representation): BoxDiscriminant[] | null => {
  if (carrier.kind === 'tagged-union') {
    const parts = carrier.arms.map(boxDiscriminantsOfArm)
    return parts.some((part) => part === null) ? null : (parts.flat() as BoxDiscriminant[])
  }
  if (carrier.kind === 'optional') {
    const payload = boxDiscriminantsOf(carrier.payload)
    if (payload === null) return null
    return [{ tag: carrier.absence === 'null' ? 'Null' : 'Undefined', payload: null, nominal: null, callableMembers: null }, ...payload]
  }
  const callableMembers = callableMembershipOf(carrier)
  // A Function tag and a C++ signature authenticate only callability and an
  // ABI. They cannot select a source union member. Generic/evaluated callable
  // arms therefore fail closed; exact functions and closed families carry the
  // FunctionId tokens installed on their shared Function object.
  if (callableMembers === null) return null
  // The static Ref wrapper recorded in payloadType() is not an object brand:
  // a Derived allocation can cross the dynamic boundary through Ref<Base>.
  // Nominal union selection therefore reads the authenticated allocation
  // family retained by Value, which is the same fact class projection uses.
  if (carrier.kind === 'class-ref' && carrier.ownership === 'shared-refcount')
    return [{ tag: 'Object', payload: null, nominal: cppClassName(carrier.declaration), callableMembers: null }]
  const tag = dynamicTagFor(carrier)
  if (tag === null) return null
  return [
    {
      tag,
      payload: tag === 'Undefined' || tag === 'Null' ? null : cppTypeOf(carrier),
      nominal: null,
      callableMembers: callableMembers ?? null
    }
  ]
}

/** The representation arm's carried discriminator and the executable classifier must agree. */
export const boxDiscriminantsOfArm = (arm: TaggedUnionArm): BoxDiscriminant[] | null => {
  // Broad `Function` is an already-dynamic boundary.  It has no static ABI or
  // declaration identity to recover, but its Value tag is executable evidence
  // against a non-callable arm.  A second callable arm shares this exact tag;
  // the pairwise collision check in unboxedLoadText then rejects the overlap
  // because this entry deliberately carries no invented FunctionId set.
  if (arm.runtimeDiscriminator.kind === 'callable-tag') {
    return arm.value.kind === 'dynamic' && arm.value.reason === 'untyped-callable'
      ? [{ tag: 'Function', payload: null, nominal: null, callableMembers: null }]
      : null
  }
  const discriminants = boxDiscriminantsOf(arm.value)
  if (arm.runtimeDiscriminator.kind === 'unverifiable-callable') return null
  if (discriminants === null) return null
  if (arm.runtimeDiscriminator.kind === 'carrier' || arm.runtimeDiscriminator.kind === 'record-literal') {
    return discriminants.some((entry) => entry.callableMembers !== null) ? null : discriminants
  }
  const expected = [...arm.runtimeDiscriminator.members].sort()
  if (expected.length === 0) return null
  return discriminants.every(
    (entry) => entry.callableMembers !== null && [...entry.callableMembers].sort().join('\0') === expected.join('\0')
  )
    ? discriminants
    : null
}

/**
 * The site string a failed unbox aborts with.
 *
 * `gea::detail::refusePayloadMismatch` prints this verbatim, and in a release
 * build it is the ONLY evidence the abort carries: the generated C++ ships with
 * no debug info, so the backtrace names an enclosing function and nothing more.
 * A function that unboxes twice then has two indistinguishable aborts, and
 * finding which one fired costs a rebuild. Naming the carrier the read demanded
 * makes the message itself the answer.
 */
const assertionSite = (target: Representation): string => `an assertion out of a dynamic value to ${cppTypeOf(target)}`

/**
 * Whether reading `target` out of a box reaches a record through
 * `unboxedLoadText`'s own record conversion -- the one a runtime element rule
 * (`DynamicCarrier`) cannot restate, since only the compiler knows which
 * struct is a record rather than a class.
 */
export const adoptsDynamicRecord = (target: Representation): boolean => {
  if (target.kind === 'optional') return adoptsDynamicRecord(target.payload)
  if (target.kind === 'array-object') return adoptsDynamicRecord(target.element)
  const record = (target.kind === 'record' && target.accessors.length === 0) || target.kind === 'record-with-index'
  return record && target.ownership === 'shared-refcount'
}

/**
 * The condition `unboxedLoadText(target, value)` itself checks before its
 * exact payload load, for the carriers that load is the generic tag-and-payload
 * read of (an optional adds its own absence). A record's dynamic conversion
 * asks it first, so a mistyped field is a TypeError rather than the load's
 * abort. `null` for every carrier with a load of its own: those refuse (or
 * throw, for a nested record) themselves, and restating their rules here would
 * be a second authority.
 */
const dynamicFieldAdmissionText = (target: Representation, value: string): string | null => {
  if (target.kind === 'optional') {
    const payload = dynamicFieldAdmissionText(target.payload, value)
    if (payload === null) return null
    return `${value}.tag() == gea::Value::Tag::${target.absence === 'null' ? 'Null' : 'Undefined'} || (${payload})`
  }
  if (callableObjectAbi(target) !== null || isNativeError(target)) return null
  switch (target.kind) {
    case 'dynamic':
    case 'class-ref':
    case 'tagged-union':
    case 'array-object':
    case 'keyed-collection':
    case 'dictionary':
    case 'record':
    case 'record-with-index':
    case 'promise':
      return null
  }
  const tag = dynamicTagFor(target)
  if (tag === null) return null
  if (tag === 'Undefined' || tag === 'Null') return `${value}.tag() == gea::Value::Tag::${tag}`
  return `${value}.tag() == gea::Value::Tag::${tag} && ${value}.payloadType() == gea::detail::payloadTypeTagFor<${cppTypeOf(target)}>()`
}

/**
 * The checked load of `text`, a `gea::Value`, into `target`'s carrier.
 *
 * The load depends on nothing but the target, and the same one recurs at
 * every dynamic read of that carrier: each field of an `any -> record`
 * rebuild, each branch of a spread's key routing, each sidecar read of a
 * record view. A load longer than the call that replaces it is therefore
 * defined once as a unit function over its operand and called by name
 * (`unitFunctionName`); the operand is then evaluated once, where a load that
 * names it in a test and again in the payload read pasted it twice.
 */
/**
 * The unit function that moves an unboxed `double` into a member the integer
 * census narrowed (`long long`), refusing what the storage cannot hold; see
 * the dynamic-to-record rebuild below for why the refusal is right.
 */
const narrowedIntegerFromDynamicName = (): string => {
  const body =
    'if (!(gea_value == gea_value) || gea_value != std::floor(gea_value) || gea_value > 9007199254740992.0 || gea_value < -9007199254740992.0) ' +
    'gea::host::throwRuntimeError("TypeError", "a dynamic record\'s number field holds a value its integer storage cannot"); ' +
    `return static_cast<${cppNarrowedIntegerType}>(gea_value);`
  const named = unitFunctionName('gea_narrowed_integer_from_dynamic', (name) => `${cppNarrowedIntegerType} ${name}(double gea_value)`, body)
  return named ?? `[](double gea_value) -> ${cppNarrowedIntegerType} { ${body} }`
}

/**
 * `freshObject`: the box holds an object the RUNTIME just built and nothing
 * else references (`Reflect.getOwnPropertyDescriptor`'s descriptor), so a
 * shared record is materialized field by field into a new allocation -- there
 * is no program identity for the rebuild to lose.
 */
export const unboxedLoadText = (target: Representation, text: string, receiverFactory?: string, freshObject = false): string | null => {
  const formal = 'gea_unboxed'
  const load = unboxedLoadTextAt(target, formal, receiverFactory, freshObject)
  if (load === null) return null
  if (load.length <= unitLoadInlineLimit) return unboxedLoadTextAt(target, text, receiverFactory, freshObject)
  const named = unitFunctionName('gea_unbox', (name) => `${cppTypeOf(target)} ${name}(const gea::Value& ${formal})`, `return ${load};`)
  return named === null ? unboxedLoadTextAt(target, text, receiverFactory, freshObject) : `${named}(${text})`
}

/** A load no longer than this stays inline: naming a unit function costs about as much as it saves. */
const unitLoadInlineLimit = 64

const unboxedLoadTextAt = (target: Representation, text: string, receiverFactory?: string, freshObject = false): string | null => {
  // A `Function` arm remains a Value because its ABI is unknown. Loading it
  // out of a broader dynamic boundary is an identity-preserving copy guarded
  // by the Function tag, not an adaptation to an invented signature.
  if (target.kind === 'dynamic' && target.reason === 'untyped-callable') {
    return `gea::detail::unboxFunctionValue(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  // A dynamic Function does not carry one statically recoverable declaration
  // identity, but an evaluated dispatch needs only callability plus its own
  // ABI. `DynamicCarrier<CallableObject<...>>::in` checks the Function tag and
  // either recovers an exact payload or builds the checked argument/result
  // adapter described in gea_runtime.h. This is deliberately separate from
  // the generic `unboxValue<T>` below: that exact-payload load cannot adapt a
  // callable whose source and reader ABIs differ.
  const callableAbi = callableObjectAbi(target)
  if (callableAbi !== null) {
    const type = cppTypeOf(target)
    const value = 'gea_callable_value'
    const restFrom = callableAbi.restFrom
    const load =
      restFrom === null
        ? callableAbi.receiver === null
          ? `gea::detail::DynamicCarrier<${type}>::in(${value}, 0)`
          : `gea::detail::DynamicCarrier<${type}>::inWithReceiver(${value}, 0${receiverFactory === undefined ? '' : `, ${receiverFactory}`})`
        : callableAbi.receiver === null
          ? `gea::detail::DynamicCarrier<${type}>::template inWithRest<${restFrom}, ${callableAbi.argumentsFrame === 'actual'}>(${value}, 0)`
          : `gea::detail::DynamicCarrier<${type}>::template inWithReceiverAndRest<${restFrom + 1}, ${callableAbi.argumentsFrame === 'actual'}>(${value}, 0${receiverFactory === undefined ? '' : `, ${receiverFactory}`})`
    const members =
      target.kind === 'function'
        ? [target.functionId]
        : target.kind === 'function-family' || target.kind === 'function-value-family'
          ? target.members
          : null
    if (members === null) return `[](const gea::Value& ${value}) -> ${type} { return ${load}; }(${text})`
    if (members.length === 0) return null
    const membership = [...new Set(members)]
      .sort()
      .map((member) => `${value}.callableDeclarationIdentity() == gea::detail::callableDeclarationTagFor<&${cppThunkName(member)}>()`)
      .join(' || ')
    return (
      `[](const gea::Value& ${value}) -> ${type} { ` +
      `if (${value}.tag() != gea::Value::Tag::Function || !(${membership})) ` +
      `gea::detail::refusePayloadMismatch("an assertion to an authenticated callable"); return ${load}; }(${text})`
    )
  }
  // A class assertion is a checked projection of the authenticated allocation
  // the box retained, not an exact match against the writer's static Ref<T>
  // wrapper.  That distinction admits a Derived instance carried through an
  // `any` Base boundary while still refusing an arbitrary object-shaped Value.
  // Borrowed and owned class carriers never had a box-safe lifetime contract,
  // so keep them outside this path rather than rendering a plausible cast.
  if (target.kind === 'class-ref') {
    if (target.ownership !== 'shared-refcount') return null
    // `T | null` never reaches here as an `optional` target at all --
    // `representation/optional.ts` folds it onto this same bare `class-ref`,
    // since `gea::Ref<T>` already default-constructs to the JS `null` state
    // (the identical fact `widenedStoreText`'s own `written.kind === 'null'`
    // branch relies on for the store direction). A dynamic boundary must
    // honor that folding on the READ side too: a box tagged `Null` is this
    // carrier's own absence, not a payload mismatch, so it is read first and
    // produces the empty `Ref`, exactly as the `optional` branch above reads
    // its stated absence tag before falling through to the payload load.
    // Skipping this let `unknown` values that were legitimately `null`
    // (`x as SomeClass | null`) abort at `unboxClassRef`'s `Tag::Object`
    // check instead of producing the empty handle the type says they can be.
    const type = cppTypeOf(target)
    return `(${text}.tag() == gea::Value::Tag::Null ? ${type}() : gea::detail::unboxClassRef<${cppClassName(target.declaration)}>(${text}, ${cppStringLiteral(assertionSite(target))}))`
  }
  // A sum has no single tag -- which JavaScript type the box holds depends on
  // the arm that is live -- so `dynamicTagFor` answers `null` for it and this
  // used to refuse. Refusing here was not a refusal anywhere the caller could
  // see: `emit-return.ts` fell through to the bare operand text and emitted
  // `return <gea::Value>;` from a function declared to return
  // `gea::TaggedUnion<...>`, which certifies, passes preflight, and is
  // rejected by clang. A JSDoc `@returns {number|string}` on a JS function
  // whose parameter's call sites disagree is enough to reach it.
  //
  // The recipe is the exact mirror of the per-arm boxing chain
  // `widenedStoreText` renders in the other direction: discriminate on the
  // BOX's own tag and build the matching arm. Written as a chain rather than a
  // runtime helper for the same reason boxing is -- each arm needs its
  // payload's STATIC C++ type, which only an arm-indexed `ofArm<I>` has.
  if (target.kind === 'tagged-union') {
    // A union with exactly one boxed arm is a typed sum with a dynamic
    // REMAINDER: the descriptor `objectDescriptorReturnTypeAt` mints for a
    // record read through a runtime key is the measured shape -- `number`
    // for the declared field, and whatever the object's dynamic-property
    // sidecar holds for any other key. A box whose tag names a typed arm
    // lands in that arm (a number never lives boxed beside the number arm,
    // so the union's own equality keeps working), and every other box is
    // the remainder. Two boxed arms would leave the remainder ambiguous.
    const boxedArms = target.arms.filter((arm) => arm.value.kind === 'dynamic' && arm.value.reason !== 'untyped-callable')
    if (boxedArms.length > 1) return null
    const catchAll = target.arms.findIndex((arm) => arm.value.kind === 'dynamic' && arm.value.reason !== 'untyped-callable')
    const arms = target.arms.map((arm, index) => (index === catchAll ? [] : boxDiscriminantsOfArm(arm)))
    // One arm this backend cannot name a tag for: the box cannot say which
    // arm is live, and guessing would reinterpret bytes. Refuse, and let the
    // obligation say so out loud.
    if (arms.some((arm) => arm === null)) return null
    const sets = arms as BoxDiscriminant[][]
    // Two arms sharing a JS tag -- `Response` and `Promise<Response>` both
    // read `typeof x === 'object'` -- are still distinguishable if they
    // record DIFFERENT C++ payload types: `Value::payloadType()`, the second
    // half of the exact check `gea::detail::unboxValue` performs on every
    // read below. Only when two arms agree on BOTH the tag AND the payload
    // type is there nothing left to discriminate on; refuse there, the one
    // case the tag-only check below used to refuse broadly for any collision.
    for (let i = 0; i < sets.length; i++)
      for (let j = i + 1; j < sets.length; j++)
        for (const left of sets[i]!)
          for (const right of sets[j]!)
            if (left.tag === right.tag && left.payload === right.payload && left.nominal === right.nominal) {
              const a = target.arms[i]!.runtimeDiscriminator
              const b = target.arms[j]!.runtimeDiscriminator
              if (
                a.kind === 'record-literal' &&
                b.kind === 'record-literal' &&
                a.key === b.key &&
                (a.primitive !== b.primitive || a.text !== b.text)
              )
                continue
              if (left.callableMembers === null || right.callableMembers === null) return null
              if (left.callableMembers.some((member) => right.callableMembers!.includes(member))) return null
            }
    const targetType = cppTypeOf(target)
    // An arm classifier selects one executable runtime member before its exact
    // payload load runs. TypeScript union annotations do not license
    // ToNumber/ToString coercion at this boundary.
    const loads = target.arms.map((arm, index) =>
      index === catchAll ? text : convertedValueText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, arm.value, text)
    )
    if (loads.some((load) => load === null)) return null
    const armText = (index: number): string => `${targetType}::ofArm<${index}>(${loads[index]})`
    // A tag shared with another arm is not enough to pick this one -- the
    // payload's own recorded C++ type is the tiebreaker, asked here as a
    // CONDITION (rather than left to `unboxValue`'s internal abort) so
    // dispatch lands on the right arm instead of merely refusing the wrong
    // one once already committed to it.
    //
    // An arm claims a SET of tags, not one, because an arm can itself be a
    // union or an optional -- `number | string | null` reaching a cell typed
    // `undefined | null | (number | string)` is ordinary TypeScript, and the
    // outer sum's third arm answers to both `Number` and `String`. Asking for
    // one tag per arm refused every such shape outright, and refusing here is
    // invisible to the caller: `emit-return.ts` used to fall through to the
    // bare operand and hand clang a `gea::Value` where a `gea::TaggedUnion`
    // was declared. The condition is the disjunction over the arm's own
    // discriminants, and the recursive load below builds the inner chain.
    const test = (discriminant: BoxDiscriminant): string => {
      if (discriminant.callableMembers !== null) {
        const membership = discriminant.callableMembers
          .map((member) => `${text}.callableDeclarationIdentity() == gea::detail::callableDeclarationTagFor<&${cppThunkName(member)}>()`)
          .join(' || ')
        return `(${text}.tag() == gea::Value::Tag::Function && (${membership}))`
      }
      return discriminant.nominal !== null
        ? `(${text}.tag() == gea::Value::Tag::Object && ${text}.classObject() && ` +
            `gea::detail::classIdentityExtends(${text}.classIdentity(), &gea::detail::RefOperationsFor<${discriminant.nominal}>::table))`
        : discriminant.payload !== null
          ? `(${text}.tag() == gea::Value::Tag::${discriminant.tag} && ` +
            `${text}.payloadType() == gea::detail::payloadTypeTagFor<${discriminant.payload}>())`
          : `${text}.tag() == gea::Value::Tag::${discriminant.tag}`
    }
    const condition = (index: number): string => {
      const discriminator = target.arms[index]!.runtimeDiscriminator
      if (discriminator.kind !== 'record-literal') return sets[index]!.map((entry) => test(entry)).join(' || ')
      const tag = discriminator.primitive === 'string' ? 'String' : discriminator.primitive === 'number' ? 'Number' : 'Boolean'
      const type = discriminator.primitive === 'string' ? 'std::string' : discriminator.primitive === 'number' ? 'double' : 'bool'
      const literal = discriminator.primitive === 'string' ? cppStringLiteral(discriminator.text) : discriminator.text
      return (
        `([](const gea::Value& object, bool nativeRecord) { if (object.tag() != gea::Value::Tag::Object) return false; ` +
        `const auto value = gea::detail::dynamicRecordDiscriminator(object, ${cppStringLiteral(discriminator.key)}, nativeRecord); ` +
        `return value.tag() == gea::Value::Tag::${tag} && ` +
        `gea::detail::unboxValue<${type}>(value, gea::Value::Tag::${tag}, "a union discriminator") == ${literal}; ` +
        `}(${text}, ${sets[index]!.map((entry) => test(entry)).join(' || ')}))`
      )
    }
    // The final arm must not be an implicit fallback. An exact load used to
    // refuse a nonmatching tag by itself, but a coercive Number/String arm
    // would otherwise turn (for example) Boolean into whichever arm happens
    // to be last. A box matching no published member is invalid for this
    // union and refuses before any member coercion can run.
    const refused = `([]() -> ${targetType} { gea::detail::refusePayloadMismatch("a dynamic value admitted by no union arm"); }())`
    const typed = target.arms.map((_, index) => index).filter((index) => index !== catchAll)
    let result = catchAll >= 0 ? armText(catchAll) : refused
    for (let position = typed.length - 1; position >= 0; position--) {
      const index = typed[position]!
      result =
        position === typed.length - 1 && catchAll < 0
          ? `${condition(index)} ? ${armText(index)} : ${result}`
          : `${condition(index)} ? ${armText(index)} : (${result})`
    }
    return typed.length > 1 || (typed.length === 1 && catchAll >= 0) ? `(${result})` : result
  }
  // `gea::Optional<T>` read straight out of a box: the tag decides which of
  // the two states the box holds, exactly the way `dynamicTagFor` already
  // decides it for the boxing direction (`Value::box` writes `Tag::Null`/
  // `Tag::Undefined` for the two absent values and nothing else needs
  // recording, since an absent optional carries no payload). A box tagged
  // with the OTHER absent value, or any present value, unboxes the payload
  // exactly as a bare (non-optional) target would -- the whole reason this is
  // an `if`, not a further tag branch, is that only ONE tag reads as empty and
  // every other live tag still has to reach the ordinary payload load below.
  if (target.kind === 'optional') {
    // The wrapper owns only its stated absence. Every other dynamic tag is an
    // exact assertion into its payload; `null` must not become an absent
    // `undefined` optional (or vice versa), and a typed payload must never
    // acquire ToNumber/ToString semantics merely by crossing this boundary.
    const payload = target.payload.kind === 'dynamic' ? text : unboxedLoadText(target.payload, text)
    if (payload === null) return null
    const targetType = cppTypeOf(target)
    const absentTag = target.absence === 'null' ? 'Null' : 'Undefined'
    return `(${text}.tag() == gea::Value::Tag::${absentTag} ? ${targetType}() : ${targetType}(${payload}))`
  }
  // A dynamic container commonly carries dynamic elements even when the
  // assertion names a typed Array. A binary document decoder is the concrete case:
  // it builds `Array<Value>` because each element is decided by the wire type,
  // then its public result is asserted as `string[]`, `Document[]`, and so on.
  // The runtime bridge preserves an exact typed payload by identity and
  // otherwise rebuilds it element by element through `DynamicCarrier`, so the
  // result is a native `ArrayObject<Element>` and a bad element refuses rather
  // than being reinterpreted or leaving the whole Array boxed.
  if (target.kind === 'array-object') {
    // A record element is not a carrier `DynamicCarrier` can rebuild: which
    // struct is a record rather than a class is a compiler fact, and the
    // runtime's `Ref<T>` rule reads a box back by identity alone -- so a
    // parsed or decoded document element aborted. The element takes this function's own
    // record conversion instead, the one every other `any -> record` read takes.
    if (adoptsDynamicRecord(target.element)) {
      const element = 'gea_dynamic_element'
      const load = unboxedLoadText(target.element, element)
      if (load === null) return null
      return (
        `gea::detail::unboxDynamicArrayWith<${cppTypeOf(target.element)}>(${text}, ${cppStringLiteral(assertionSite(target))}, ` +
        `[](const gea::Value& ${element}) -> ${cppTypeOf(target.element)} { return ${load}; })`
      )
    }
    return `gea::detail::unboxDynamicArray<${cppTypeOf(target.element)}>(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  // `conversions.ts`'s `dynamicPromiseAdoptionMaterializer`, spelled: the
  // boxed promise adopted, each fulfilment value through the payload's own
  // checked load -- the same `promiseFromDynamic` an async `return` runs.
  if (target.kind === 'promise') {
    if (target.value.kind === 'void') return `gea::detail::promiseFromDynamic<void>(${text})`
    const settledType = cppTypeOf(target.value)
    const settled = target.value.kind === 'dynamic' ? 'gea_settled' : unboxedLoadText(target.value, 'gea_settled')
    if (settled === null) return null
    return `gea::detail::promiseFromDynamic<${settledType}>(${text}, [](const gea::Value& gea_settled) { return ${settledType}(${settled}); })`
  }
  // `conversions.ts`'s `dynamicMapViewMaterializer`, spelled: any boxed Map,
  // read through a view of the same object.
  if (
    target.kind === 'keyed-collection' &&
    target.family === 'map' &&
    target.ownership === 'shared-refcount' &&
    target.recursive === undefined &&
    target.readOnlyView !== true &&
    target.key.kind === 'dynamic' &&
    target.value?.kind === 'dynamic'
  ) {
    return `gea::detail::unboxDynamicMap(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  if (target.kind === 'dictionary' && target.key === 'string' && target.ownership === 'shared-refcount') {
    return `gea::detail::unboxDynamicDictionary<${cppTypeOf(target.value)}>(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  // A generic shared structural load requires the selected live field plan.
  // A context-free identity cast cannot stand in for that plan. Nominal and
  // accessor payload recovery below keep their independent exact contracts.
  if ((target.kind === 'record' && target.accessors.length === 0) || target.kind === 'record-with-index') {
    if (target.ownership === 'borrowed') return null
    const shared = target.ownership === 'shared-refcount'
    if (shared && !freshObject) return null
    if (target.kind === 'record-with-index') return null
    const targetType = cppTypeOf(target)
    const structName = cppRecordStructName(target.shapeId)
    const holder = 'gea_dynamic_record'
    const fields = target.fields.map((field, index) => {
      const present = `gea_dynamic_record_present_${index}`
      const value = `gea_dynamic_record_value_${index}`
      const unboxed = field.value.kind === 'dynamic' ? value : unboxedLoadText(field.value, value)
      // A member the integer census narrowed is a `long long`, and a braced
      // initializer refuses the `double` a box unboxes to. The census admitted
      // this rebuild because the box carries exactly this struct, which the
      // exact-payload branch above answers by identity; a foreign object
      // reaching this field-by-field path has already broken the program's
      // contract, so a value the storage cannot hold is the same TypeError.
      const load =
        unboxed !== null && storageSlotIsNarrowed(integerStorageSlot(structName, field.key))
          ? `${narrowedIntegerFromDynamicName()}(${unboxed})`
          : unboxed
      return { field, present, value, load, admission: dynamicFieldAdmissionText(field.value, value) }
    })
    if (fields.some((field) => field.load === null)) return null
    const refused = (message: string): string => `gea::host::throwRuntimeError("TypeError", ${cppStringLiteral(message)});`
    const checks = fields
      .filter(({ field }) => field.required)
      .map(({ field, present }) => `if (!${present}) ${refused(`a dynamic record lacks required field ${field.key}`)}`)
    const values = fields.map(
      ({ field, present, value }) =>
        `const gea::Value ${value} = ${present} ? gea::detail::dynamicRecordField(${holder}, ${cppStringLiteral(field.key)}) : gea::Value();`
    )
    const admissions = fields
      .filter(({ admission }) => admission !== null)
      .map(
        ({ field, present, admission }) =>
          `if (${present} && !(${admission})) ${refused(`a dynamic record's field ${field.key} is not of the declared type`)}`
      )
    const reads = fields.map(({ field, present, load }) => {
      const materialized = load!
      return field.required ? materialized : `(${present} ? ${materialized} : ${cppTypeOf(field.value)}{})`
    })
    // A layout that moved fields behind its `RecordTail` no longer declares
    // them positionally, and storing an absent one would allocate the tail
    // for nothing, so it is filled by name, present fields only.
    const tailed = tailFieldsOf({ fields: target.fields }).size > 0
    const product = (): string => {
      if (shared) {
        const assignments = fields.map(({ field, present, load }) => {
          const store = `gea_built->${tailAwareFieldWriteText(target.fields, field.key)} = ${load!};`
          return field.required ? store : `if (${present}) { ${store} gea_built->${cppRecordFieldPresenceName(field.key)} = true; }`
        })
        return `[&]() { auto gea_built = gea::makeRef<${structName}>(); ${assignments.join(' ')} return gea_built; }()`
      }
      if (tailed) {
        const assignments = fields.map(({ field, present, load }) => {
          const store = `gea_built.${tailAwareFieldWriteText(target.fields, field.key)} = ${load!};`
          return field.required ? store : `if (${present}) { ${store} gea_built.${cppRecordFieldPresenceName(field.key)} = true; }`
        })
        return `[&]() { ${structName} gea_built{}; ${assignments.join(' ')} return gea_built; }()`
      }
      const presences = fields.filter(({ field }) => !field.required).map(({ present }) => present)
      return `${structName}{${[...reads, ...presences].join(', ')}}`
    }
    const body =
      `if (${holder}.tag() != gea::Value::Tag::Object && ${holder}.tag() != gea::Value::Tag::Function) ` +
      `${refused('an assertion to a record requires an object')} ` +
      `${fields.map(({ field, present }) => `const bool ${present} = gea::detail::dynamicRecordHasField(${holder}, ${cppStringLiteral(field.key)});`).join(' ')} ` +
      `${checks.join(' ')} ${values.join(' ')} ${admissions.join(' ')} return ${product()};`
    // The text depends on the target alone, so a unit defines it once and
    // every site calls it -- see `unitFunctionName`.
    const named = unitFunctionName(
      `gea_from_${shared ? 'fresh_' : ''}dynamic_${structName}`,
      (name) => `${targetType} ${name}(const gea::Value& ${holder})`,
      body
    )
    if (named !== null) return `${named}(${text})`
    return `[](const gea::Value& ${holder}) -> ${targetType} { ${body} }(${text})`
  }
  // The exact inverse of the boxing table, asked of the same function, so a
  // carrier can never be boxed under one tag and read back under another.
  const tag = dynamicTagFor(target)
  if (tag === null) return null
  // `undefined` has no payload to read out of the box at all -- the tag IS
  // the whole value -- so this is a verify-then-produce, never a load:
  // `gea::detail::unboxUndefinedValue` checks the tag alone (there is no
  // payload-type half of the check `unboxValue` performs for everything
  // else, because there is no payload to have recorded one for) and hands
  // back the one value `undefined` ever is, `gea::Undefined{}`
  // (`cppConstantLiteral`'s own spelling, unreachable from here without a
  // `ConstantLiteral` this function was never handed).
  if (tag === 'Undefined') return `gea::detail::unboxUndefinedValue(${text}, ${cppStringLiteral(assertionSite(target))})`
  // `null` is the same verify-then-produce, and this used to refuse it on a
  // false premise ("neither has a C++ value this read can produce"). No
  // PAYLOAD is not no VALUE: `null`'s carrier is `std::nullptr_t`, whose one
  // inhabitant is `nullptr`, so the tag check plus that inhabitant is a
  // complete read. BigInt has an ordinary payload: `Value::box` records the
  // `gea::BigInt` type and `unboxValue` checks it like every other scalar.
  if (tag === 'Null') return `gea::detail::unboxNullValue(${text}, ${cppStringLiteral(assertionSite(target))})`
  // The intrinsic `Error` carrier is the one object a box may hold under
  // ANOTHER payload type and still be: a compiled subclass's handle.
  if (isNativeError(target)) return `gea::detail::unboxNativeError(${text}, ${cppStringLiteral(assertionSite(target))})`
  // `gea::detail::unboxValue` checks BOTH the tag and the payload's recorded
  // C++ type (`payloadTypeTagFor`), so a box holding a different struct than
  // the narrowing claimed refuses by name instead of reinterpreting bytes.
  // That is what makes reading an object out of a box safe here at all: the
  // tag alone says only "some object".
  if (target.kind === 'scalar' && target.integerWidth !== undefined) {
    const numeric = `gea::detail::unboxValue<double>(${text}, gea::Value::Tag::Number, ${cppStringLiteral(assertionSite(target))})`
    return `gea::toDeclaredInteger<${cppTypeOf(target)}>(${numeric})`
  }
  return `gea::detail::unboxValue<${cppTypeOf(target)}>(${text}, gea::Value::Tag::${tag}, ${cppStringLiteral(assertionSite(target))})`
}

/**
 * `generic-function-set` into a superset: each source index becomes the
 * target's index of the same member. A one-member source is a constant; a
 * wider one is a table lookup. `null` when the pair is not a set widening
 * (a member the target lacks is a narrowing, and no store performs one).
 */
export const genericFunctionSetWideningText = (source: Representation, target: Representation, text: string): string | null => {
  if (target.kind !== 'generic-function-set') return null
  // A member's own name, read as a callable: the one member is index 0. The
  // callable's text is a cell read with no effect to keep.
  if (source.kind !== 'generic-function-set') {
    return (source.kind === 'function' ||
      source.kind === 'function-family' ||
      source.kind === 'function-value-family' ||
      source.kind === 'function-value-dispatch') &&
      target.members.length === 1
      ? 'static_cast<std::uint8_t>(0)'
      : null
  }
  const indexes = source.members.map((member) => target.members.indexOf(member))
  if (indexes.some((index) => index < 0)) return null
  if (indexes.every((index, position) => index === position)) return text
  if (indexes.length === 1) return `static_cast<std::uint8_t>(${indexes[0]})`
  return `([&]() -> std::uint8_t { static constexpr std::uint8_t gea_set_remap[] = {${indexes.join(', ')}}; return gea_set_remap[${text}]; }())`
}

/**
 * `never[]` read where `E[]` is wanted: the one empty array of `E`. See
 * `conversions.ts`'s `gea::emptyArraySentinel` recipe for why identity, not a
 * fresh `[]`, is the answer, and which pairs it admits. The dynamic target
 * decides at runtime (`emptyArraySentinelOrBoxed`): an empty source is the
 * sentinel, a populated one -- a real `undefined[]`, which the carrier cannot
 * tell apart -- is boxed element by element.
 */
export const emptyArraySentinelText = (source: Representation, target: Representation, text: string): string | null => {
  if (source.kind !== 'array-object' || target.kind !== 'array-object' || source.element.kind !== 'undefined') return null
  if (source.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return null
  if (target.element.kind === 'dynamic') return `gea::emptyArraySentinelOrBoxed(${text})`
  if (carriesUndefined(target.element)) return null
  return `gea::emptyArraySentinel<${cppTypeOf(target.element)}>(${text})`
}

/**
 * Any callable read where a function IDENTITY is wanted -- the carrier of
 * `(...args: never[]) => R`, TypeScript's `AnyFunction`.
 *
 * Nothing is fabricated: `gea::CallableObject` already stores a
 * `Ref<FunctionObjectIdentity>` beside its thunk, precisely so that copying or
 * adapting a callable cannot mint a second ECMAScript identity, and this reads
 * that field. Offered for the carriers `cppTypeOf` spells as a `CallableObject`
 * or a `CallableConstructorObject`; `gea::ConstructorObject` carries no such
 * field, so the constructor-only kinds keep the refusal rather than get a
 * fabricated one.
 *
 * There is deliberately no reverse: an identity carries no calling convention,
 * so a call through it has nothing to use and must refuse.
 */
const callableIdentityText = (source: Representation, target: Representation, text: string): string | null => {
  if (target.kind !== 'callable-identity') return null
  switch (source.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'function-and-constructor':
      return `(${text}).functionObjectIdentity()`
    default:
      return null
  }
}

/**
 * A call-only function object viewed under a type that ALSO names its
 * `[[Construct]]` -- `Factory as typeof Factory & (new (v: number) => T)`.
 *
 * Nothing is rebuilt. ECMA-262 gives a pre-`class` constructor function both
 * internal methods when it is created; the assertion changes only which of
 * them the program may name, so the widened view keeps the source's
 * environment, its owner and its `FunctionObjectIdentity` -- one own-property
 * table, one `===` answer. `gea::withConstructEntry` is that one step.
 *
 * The construct entry is looked up at run time by the source's own invoke
 * pointer, published beside the construct thunk
 * (`translation-unit.ts`'s `constructThunkOf`). That keeps the conversion a
 * property of the VALUE: this step never has to decide which declaration a
 * cell holds, and a function whose declaration published no such entry refuses
 * by name instead of constructing through another body.
 *
 * The call halves must be the SAME frame. An adapted one is a different
 * function object, and the identity this preserves is the whole point.
 */
const callableConstructEntryText = (source: Representation, target: Representation, text: string): string | null => {
  if (target.kind !== 'function-and-constructor') return null
  const call =
    source.kind === 'function' ||
    source.kind === 'function-family' ||
    source.kind === 'function-value-family' ||
    source.kind === 'function-value-dispatch'
      ? source.abi
      : null
  if (call === null || abiKey(call) !== abiKey(target.call)) return null
  return `gea::withConstructEntry<${cppTypeOf(target)}>(${text})`
}

/**
 * One step of the conversion chain. `undefined` means the step does not
 * claim the pair and the chain continues; `null` means it claims the pair
 * and cannot render it, which ends the chain with no rendering (the chain's
 * original early returns); a string is the rendering.
 */
export interface ConversionStep {
  readonly id: string
  readonly apply: (source: Representation, target: Representation, text: string) => string | null | undefined
}

const claimed = (text: string | null): string | null | undefined => (text === null ? undefined : text)

/**
 * The chain, in the order it has always run. Each entry is one recipe with a
 * stable id; `conversionRecipeOf` names the entry that claims a pair without
 * rendering it, so the conversion census (`conversion/nodes.ts`) can state
 * the same answer this printer gives, from the same table.
 */
/**
 * A promise adopting another's state with its fulfilment payload converted:
 * the chain's `promise-payload` step renders it with the chain's own payload
 * conversion, and `recipeText` with a structural record view when that is
 * what carries the payload (`IteratorResult<T>`'s arms are named interfaces a
 * `{ value, done: false }` literal reaches only by a view).
 *
 * A source still PENDING links through `observe`: a request's body cache is one
 * callable returning `Promise<string | ArrayBuffer | Blob | ...>` that every
 * reader (`text()`, `json()`, `formData()`) adapts to its own `Promise<T>` at
 * the call, and the promise it hands back is the body read that has not
 * arrived yet. Snapshotting it (`if (!settled()) return Target()`) minted a
 * target nothing ever settled -- every `await request.json()` hung and the POST
 * never answered. The conversion runs when the value exists; a conversion that
 * throws (a dynamic arm not of the declared type) becomes the target's
 * rejection, which is what the same failure inside a `then` handler is.
 */
const promiseAdoptionText = (
  source: Extract<Representation, { kind: 'promise' }>,
  target: Extract<Representation, { kind: 'promise' }>,
  text: string,
  payload: (value: string) => string | null
): string | null => {
  const settledPayload = payload(`${promiseSourceName}.value()`)
  if (settledPayload === null) return null
  const pendingPayload = payload(promiseValueName)
  if (pendingPayload === null) return null
  return (
    `([&]() -> ${cppTypeOf(target)} { const auto& ${promiseSourceName} = ${text}; ` +
    `if (${promiseSourceName}.rejected()) return ${cppTypeOf(target)}::rejected_with(${promiseSourceName}.rejection()); ` +
    `if (${promiseSourceName}.settled()) return ${cppTypeOf(target)}(${settledPayload}); ` +
    `${cppTypeOf(target)} ${promiseTargetName}; ` +
    `${promiseSourceName}.observe([${promiseTargetName}](const ${cppTypeOf(source.value)}& ${promiseValueName}) mutable ` +
    `{ try { ${promiseTargetName}.resolveInline(${pendingPayload}); } catch (...) { ${promiseTargetName}.rejectInline(std::current_exception()); } }, ` +
    `[${promiseTargetName}](const std::exception_ptr& ${promiseRejectionName}) mutable ` +
    `{ ${promiseTargetName}.rejectInline(${promiseRejectionName}); }); ` +
    `return ${promiseTargetName}; }())`
  )
}

const promiseCompletionText = (
  source: Extract<Representation, { kind: 'promise' }>,
  target: Extract<Representation, { kind: 'promise' }>,
  text: string,
  plan: PromiseAdoptionRecipe,
  payload: (node: ConversionNode, value: string) => string | null
): string | null => {
  if (plan.kind === 'payload-transfer') return promiseAdoptionText(source, target, text, (value) => payload(plan.conversion, value))
  const fulfillment =
    plan.kind === 'rejection-only'
      ? `gea::host::throwRuntimeError("TypeError", "a Promise<never> fulfilled"); co_return${target.value.kind === 'void' ? '' : ` gea::host::unreachableValue<${cppTypeOf(target.value)}>()`};`
      : `co_return${plan.fulfillment === 'void' ? '' : ` ${plan.fulfillment === 'dynamic' ? 'gea::Value()' : cppUndefinedValue}`};`
  return `([](${cppTypeOf(source)} ${promiseSourceName}) -> ${cppTypeOf(target)} { co_await ${promiseSourceName}; ${fulfillment} }(${text}))`
}

/**
 * The `rebuild: 'unshared-array'` conversion (`ir/model.ts`'s `ConvertOperation`):
 * a call result lowering proved no other reference holds, rebuilt once at the
 * published element carrier. The rebuild allocates, which is exactly what makes
 * this unsound for any array another alias can reach -- so it is rendered only
 * for the instruction that carries the proof, never from the pair alone, and a
 * pending promise rebuilds when its array arrives (`promiseAdoptionText`).
 */
export const unsharedArrayRebuildText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string,
  elementNode: ConversionNode
): string | null => {
  if (source.kind === 'promise' && target.kind === 'promise') {
    return promiseAdoptionText(source, target, text, (value) =>
      unsharedArrayRebuildText(ctx, source.value, target.value, value, elementNode)
    )
  }
  if (source.kind !== 'array-object' || target.kind !== 'array-object') return null
  const element = namedConversionText(ctx, 'emit-narrowing.ts:unshared-array', elementNode, 'gea_element')
  if (element === null) return null
  return (
    `([&]() -> ${cppTypeOf(target)} { const auto& gea_fresh = ${text}; ` +
    `auto gea_rebuilt = gea::makeRef<${cppTypeOf(target, 'owned')}>(); ` +
    `gea_rebuilt->appendRangeConverted(*gea_fresh, 0, [&](const ${cppTypeOf(source.element)}& gea_element) { return ${element}; }); ` +
    `return gea_rebuilt; }())`
  )
}

export const conversionChain: readonly ConversionStep[] = [
  { id: 'native-sum-widening', apply: (source, target, text) => claimed(widenedNativeSumText(source, target, text)) },
  // A choice among generic functions widening into a superset: the index is
  // remapped, member by member. Before the identical-spelling identity below,
  // which would pass the SOURCE's index through unchanged -- both sets are one
  // `std::uint8_t`, and `0` means a different member in each.
  { id: 'generic-set-remap', apply: (source, target, text) => claimed(genericFunctionSetWideningText(source, target, text)) },
  // Two carriers with one physical storage convert by identity. The
  // representation tells them apart for reasons storage does not carry --
  // `constructor-family` names the class its `new` reaches and
  // `constructor-value-dispatch` does not -- but a value of one already IS a
  // value of the other. `physicalCarrierKey` (representation/physical-carrier.ts)
  // states which distinctions are storage, callable packing frames included.
  {
    id: 'declared-integer-scalar',
    apply: (source, target, text) => {
      const numberTarget = numberStorageTarget(source, target)
      return numberTarget === null ? undefined : numberStorageText(numberTarget, text, cppTypeOf)
    }
  },
  {
    id: 'same-cpp-type',
    apply: (source, target, text) => (samePhysicalCarrier(source, target) ? text : undefined)
  },
  { id: 'empty-array-sentinel', apply: (source, target, text) => claimed(emptyArraySentinelText(source, target, text)) },
  { id: 'callable-identity', apply: (source, target, text) => claimed(callableIdentityText(source, target, text)) },
  { id: 'callable-construct-entry', apply: (source, target, text) => claimed(callableConstructEntryText(source, target, text)) },
  {
    id: 'constructor-upcast',
    apply: (source, target, text) => {
      const member = constructorUpcastMember(source, target)
      return member === null ? undefined : `gea::upcastConstructor<${cppTypeOf(target)}, &${cppConstructThunkName(member)}>(${text})`
    }
  },
  {
    id: 'constructor-family-upcast',
    apply: (source, target, text) => {
      const members = constructorFamilyUpcastMembers(source, target)
      if (members === null) return undefined
      const thunks = members.map((member) => `&${cppConstructThunkName(member)}`).join(', ')
      return `gea::upcastConstructorFamily<${cppTypeOf(target)}, ${cppTypeOf(source)}, ${thunks}>(${text})`
    }
  },
  {
    // The same store when the two conventions also disagree on a parameter
    // (`global.Request = LightweightRequest`, whose `input` names its own class
    // where the base's names the base): the wrapper converts each argument the
    // base convention hands it into the one the derived thunk takes.
    id: 'constructor-adapter',
    apply: (source, target, text) => {
      if (source.kind !== 'constructor-family' || target.kind !== 'constructor-family') return undefined
      const [member] = source.members
      if (member === undefined || source.members.length !== 1 || !target.members.includes(member)) return undefined
      if (source.abi.receiver !== null || target.abi.receiver !== null) return undefined
      if (
        source.abi.restFrom !== target.abi.restFrom ||
        source.abi.argumentsFrame !== target.abi.argumentsFrame ||
        source.abi.parameters.length !== target.abi.parameters.length
      )
        return undefined
      if (classRefTransportKind(source.abi.result, target.abi.result) !== 'upcast') return undefined
      const formals: string[] = []
      const actuals: string[] = []
      for (const [index, parameter] of target.abi.parameters.entries()) {
        const slot = source.abi.parameters[index]!
        const name = `gea_argument_${index}`
        formals.push(`${cppAbiParameterType(parameter)} ${name}`)
        if (cppAbiParameterType(parameter) === cppAbiParameterType(slot)) {
          actuals.push(`std::forward<${cppAbiParameterType(parameter)}>(${name})`)
          continue
        }
        const converted = tryCandidateText(() => convertedValueText(parameter.value, slot.value, name))
        if (converted === null) return undefined
        actuals.push(converted)
      }
      const result = cppResultTypeOf(target.abi.result)
      return (
        `[](const ${cppTypeOf(source)}& gea_from) { ${cppTypeOf(target)} gea_to; ` +
        `gea_to.construct_ = +[](void* gea_environment${formals.map((formal) => `, ${formal}`).join('')}) -> ${result} { ` +
        `return ${result}(${cppConstructThunkName(member)}(gea_environment${actuals.map((actual) => `, ${actual}`).join('')})); }; ` +
        `gea_to.environment = gea_from.environment; gea_to.environmentOwner = gea_from.environmentOwner; return gea_to; }(${text})`
      )
    }
  },
  {
    id: 'constructor-dispatch-adapter',
    apply: (source, target, text) => claimed(constructorDispatchAdapterText(source, target, text))
  },
  { id: 'regexp-match-array-base', apply: (source, target, text) => claimed(regexpMatchArrayBaseText(source, target, text)) },
  // A derived class-ref stored where a base class-ref is declared, rendered as
  // an EXPLICIT construction of the target. Checks the same ancestry direction as
  // the conversion authority: this chain is also queried speculatively while
  // matching union arms, where a BASE arm and a DERIVED target do not imply the
  // base value survived the control-flow guard. Treating that downcast as a store
  // would make a union recast consume an arm the narrowing excluded, then ask
  // `gea::Ref` for a constructor C++ does not provide. A real base-to-derived
  // narrowing falls through to `narrowedLoadText`'s checked downcast.
  {
    id: 'class-upcast',
    apply: (source, target, text) =>
      source.kind === 'class-ref' &&
      target.kind === 'class-ref' &&
      source.ownership === target.ownership &&
      source.ancestors.includes(target.declaration)
        ? `${cppTypeOf(target)}(${text})`
        : undefined
  },
  // An instance of a class extending a native collection stored where that
  // collection is declared: the struct derives from the runtime's collection
  // object (`records.ts`'s native collection link), so this is `class-upcast`
  // one base over. Refused for a family that redeclares a collection member
  // (`class-ref.nativeBaseOverridden`) -- held as the bare collection, the
  // member would answer natively and skip the override. A read of one member
  // the family does not redeclare takes the census's `nativeBaseViewFor` node
  // instead, which renders this same upcast.
  {
    id: 'native-collection-upcast',
    apply: (source, target, text) =>
      isNativeCollectionUpcast(source, target) && source.kind === 'class-ref' && !source.nativeBaseOverridden
        ? `${cppTypeOf(target)}(${text})`
        : undefined
  },
  // The same one base over for a class extending the intrinsic `Error`: its
  // struct derives from `gea::runtime::Error` in place (`records.ts`'s native
  // link), so a subclass instance stored where `Error` is declared is `Ref`'s own
  // converting constructor. `nativeRecordBaseTransportKind` states when a
  // family's overrides refuse it.
  // An instance of a class extending the intrinsic `Promise` stored where a
  // promise is declared: the struct derives from `gea::Promise<V>` in place,
  // so the store copies the base handle, which shares the instance's state.
  // A promise of another payload goes on through the ordinary promise chain
  // (`Promise<never>` into `Promise<T>`).
  {
    id: 'native-promise-upcast',
    apply: (source, target, text) => {
      const base = nativePromiseBaseOf(source)
      if (base === null || target.kind !== 'promise') return undefined
      const viewed = `${cppTypeOf(base)}(static_cast<const ${cppTypeOf(base)}&>(*(${text})))`
      if (representationKey(base) === representationKey(target)) return viewed
      return claimed(tryCandidateText(() => convertedValueText(base, target, viewed)))
    }
  },
  {
    id: 'native-record-upcast',
    apply: (source, target, text) =>
      nativeRecordBaseTransportKind(source, target) === 'upcast' ? `${cppTypeOf(target)}(${text})` : undefined
  },
  // A host handle stored where one of its own base types is declared, the same
  // rule as `class-upcast` above for a hierarchy this compiler did not lay out.
  // An `NSStackView` IS an `NSView`: the host stated the inheritance
  // (`PluginCapabilities.nativeBases`, carried here on the carrier itself) and
  // the generated bridge gives the wrapper structs that same inheritance, so
  // the target performs this one implicitly and for free. Rendered as an
  // explicit construction of the base for `class-upcast`'s reason -- this chain
  // is also probed speculatively while matching union arms, where the opposite
  // direction is a downcast no store may perform, and the ancestry check is
  // what tells the two apart.
  //
  // Before this step the pair had no node in the conversion census, so every
  // program that passed a derived host handle to a base-typed parameter was
  // refused by the certificate ("no runtime conversion is installed") while the
  // printer sitting behind it had known how to render it all along.
  {
    id: 'native-handle-upcast',
    apply: (source, target, text) =>
      source.kind === 'native-handle' && target.kind === 'native-handle' && target.native !== null && source.bases.includes(target.native)
        ? `${cppTypeOf(target)}(${text})`
        : undefined
  },
  {
    id: 'native-handle-view',
    apply: (source, target, text) => {
      if (source.kind !== 'native-handle' || target.kind !== 'native-handle' || source.native === null) return undefined
      const template = target.viewsFrom?.get(source.native)
      return template?.replace('{value}', `(${text})`)
    }
  },
  { id: 'callable-part', apply: (source, target, text) => claimed(callablePartText(source, target, text)) },
  // An EMPTY array literal flowing into a native array-like carrier. `[]` with
  // no contextual array type checks as the empty tuple, which derives a record
  // with no fields; `(path.match(/.../g) || [])` is the shape. A
  // value-initialized native handle IS what the source names -- an array-like
  // holding nothing -- so the conversion mints one rather than refusing a program
  // the checker already proved compatible. Gated on the source declaring NOTHING:
  // a record with even one field would be dropping data.
  {
    id: 'empty-record-into-native',
    apply: (source, target) =>
      source.kind === 'record' &&
      source.fields.length === 0 &&
      source.accessors.length === 0 &&
      (target.kind === 'native-record-ref' || (target.kind === 'record-with-index' && target.fields.every((field) => !field.required)))
        ? target.ownership === 'shared-refcount'
          ? `gea::makeRef<${(target.kind === 'native-record-ref' ? target.native : null) ?? cppTypeOf(target, 'owned')}>()`
          : `${cppTypeOf(target, 'owned')}{}`
        : undefined
  },
  // The next five are implicit converting constructors `gea::CallableObject`
  // declares, so the identity text renders each -- see each predicate's own doc
  // for why that is sound. `resultAdaptedCallableText` after them is the pair
  // that is NOT an implicit constructor: same frame, a result the header cannot
  // convert on its own (`resultAdapterOf`).
  { id: 'callable-drops-unbound-parameters', apply: (source, target, text) => (dropsUnboundParameters(source, target) ? text : undefined) },
  {
    id: 'callable-drops-all-parameters-into-result-arm',
    apply: (source, target, text) => (dropsAllParametersIntoResultArm(source, target) ? text : undefined)
  },
  { id: 'callable-widens-result-into-arm', apply: (source, target, text) => (widensResultIntoArm(source, target) ? text : undefined) },
  {
    id: 'callable-discards-result-into-void',
    apply: (source, target, text) => (discardsResultIntoVoid(source, target) ? text : undefined)
  },
  { id: 'callable-rebases-rest', apply: (source, target, text) => (rebasesRestOverLeadingParameters(source, target) ? text : undefined) },
  { id: 'result-adapted-callable', apply: (source, target, text) => claimed(resultAdaptedCallableText(source, target, text)) },
  // `gea::Optional<T>` declares a converting constructor from `T`, so a present
  // payload widens by being written where the optional is expected.
  {
    id: 'optional-wrap-identity',
    apply: (source, target, text) =>
      target.kind === 'optional' && representationKey(target.payload) === representationKey(source) ? text : undefined
  },
  // A DYNAMIC source must be asked whether the box itself is empty before any
  // payload conversion happens. Falling through to the payload-only wrap below
  // rendered an unconditional `unboxValue<T>` that C++ then widened into the
  // optional, reading the box as if it could never be empty: `asNullable(null)`
  // for a declared `string | null` return certified, compiled, and aborted at
  // runtime inside `unboxValue`.
  {
    id: 'optional-from-dynamic',
    apply: (source, target, text) => (target.kind === 'optional' && source.kind === 'dynamic' ? unboxedLoadText(target, text) : undefined)
  },
  // A source that is ITSELF optional keeps its own presence here: absent stays
  // absent, present converts one payload down, and the empty branch is a
  // default-constructed target. Unwrapping the target and converting into the
  // payload alone rendered an unconditional `(*text)`, and `flag && image` over
  // an `Img | null` segfaulted on `null` having certified clean. It is the ONLY
  // answer for an optional source: a payload this cannot convert refuses rather
  // than falling through, because the fallthrough was that same unwrap one frame
  // deeper (an HTTP response answered status `0` through it).
  {
    id: 'optional-payload-convert',
    apply: (source, target, text) => {
      if (target.kind !== 'optional' || source.kind !== 'optional') return undefined
      const payload = convertedValueText(source.payload, target.payload, `(*${text})`)
      if (payload === null) return null
      return `(${text}.has_value() ? ${cppTypeOf(target)}{${cppTypeOf(target.payload)}{${payload}}} : ${cppTypeOf(target)}{})`
    }
  },
  {
    id: 'union-into-optional-payload',
    apply: (source, target, text) =>
      target.kind === 'optional' && source.kind === 'tagged-union'
        ? claimed(sumIntoPayloadText(source, target.payload, text, (arm) => `${cppTypeOf(target)}{${cppTypeOf(target.payload)}{${arm}}}`))
        : undefined
  },
  // A UNION source that still carries the target's own absence as a bare arm
  // has proven nothing about presence: `number | string | null | undefined`
  // narrowed past the `null` guard alone is `optional(number | string,
  // undefined)`, and the undefined arm is as live as either payload arm. The
  // payload-only wrap below would load the payload's arm unconditionally into a
  // PRESENT optional, so `value === undefined` never held. `narrowedLoadText`'s
  // optional case tests the absent arm; a payload none of the arms carries whole
  // makes it refuse, and that refusal is not an answer.
  {
    id: 'union-absence-narrow',
    apply: (source, target, text) =>
      target.kind === 'optional' && source.kind === 'tagged-union' && source.arms.some((arm) => arm.value.kind === target.absence)
        ? claimed(tryCandidateText(() => narrowedLoadText(source, target, text)))
        : undefined
  },
  // A source that CONVERTS to the payload: `((gl, v) => void)` written where
  // `((gl, v, textures) => void) | undefined` is expected. The payload is named
  // EXPLICITLY rather than letting two constructors chain, because C++ permits
  // one user-defined conversion per implicit sequence. Both constructions are
  // spelled so the target's presence carrier survives: a narrowed
  // `Error | null | undefined` must remain `Optional<Error>` after the undefined
  // guard so a following truthiness test can read its presence flag.
  {
    id: 'optional-wrap-converted',
    apply: (source, target, text) => {
      if (target.kind !== 'optional') return undefined
      const payload = convertedValueText(source, target.payload, text)
      return payload !== null ? `${cppTypeOf(target)}{${cppTypeOf(target.payload)}{${payload}}}` : undefined
    }
  },
  // Two real sums, neither one arm of the other: `narrowedLoadText` would
  // misread the target as an arm value to search FOR inside the source and
  // refuse. A proper subset is control-flow narrowing, not a recast, and renders
  // from the TARGET arms so arms excluded by the guard never appear: a recast
  // searches for a home for every source arm and would emit a downcast of a base
  // arm the guard proved dead.
  //
  // Admission is `narrowingReachesTarget` (`conversion/build.ts`) -- the same
  // recursive reachability the census's own registry admission already asks
  // (`conversions.ts`'s `narrowing` sub-union branch) -- and not a flat
  // top-level key-set comparison, because a NARROWING can be NESTED: `typeof
  // value === 'string'` proven false inside `undefined | null |
  // (string|number|bigint|boolean|symbol|object|function)` leaves the same
  // three-arm outer shape with a smaller seven-minus-one inner union, which
  // shares no top-level key with its target at all. The flat check refused
  // that pair and let `union-recast` answer instead, which searches for a
  // home for the whole nested arm as ONE value; finding none, it fell through
  // `narrowedLoadText`'s per-leaf search into `unreachable-value`'s
  // dead-branch discard, which cannot tell "this leaf is provably absent"
  // from "no leaf of this live arm equals bare `undefined`" and collapsed
  // every live arm of the inner union into one bogus `Undefined` home.
  // Certified, emitted, and wrong for every arm past the first guard. Using
  // the registry's own predicate here is what keeps the two from disagreeing
  // again the way its doc comment says they cannot.
  {
    id: 'union-subset-narrow',
    apply: (source, target, text) => {
      if (source.kind !== 'tagged-union' || target.kind !== 'tagged-union') return undefined
      return narrowingReachesTarget(source, target) ? claimed(narrowedUnionSubsetText(source, target, text)) : undefined
    }
  },
  {
    id: 'union-recast',
    apply: (source, target, text) =>
      source.kind === 'tagged-union' && target.kind === 'tagged-union' ? claimed(recastedUnionText(source, target, text)) : undefined
  },
  // The same shape one level out: two records declaring the same fields under
  // two shape ids. Tried, not committed to -- a pair this cannot rebuild is not
  // necessarily a pair nothing can convert.
  {
    id: 'record-recast',
    apply: (source, target, text) =>
      source.kind === 'record' && target.kind === 'record' ? claimed(recastedRecordText(source, target, text)) : undefined
  },
  // The record recast still wrapped in its presence bit, admitted by
  // `conversions.ts`'s `gea::Optional::recastPayload` on the identical
  // `recordsRecastable` question. An IIFE with a local rather than a conditional
  // over `text`: `text` is an arbitrary expression and must be evaluated once.
  {
    id: 'optional-record-recast',
    apply: (source, target, text) => {
      if (
        source.kind !== 'optional' ||
        target.kind !== 'optional' ||
        source.payload.kind !== 'record' ||
        target.payload.kind !== 'record' ||
        source.absence !== target.absence
      )
        return undefined
      const payload = recastedRecordText(source.payload, target.payload, '(*gea_present)')
      if (payload === null) return undefined
      const targetType = cppTypeOf(target)
      return (
        `([&]() -> ${targetType} { const auto& gea_present = ${text}; ` +
        `if (!gea_present.has_value()) return ${targetType}(); ` +
        `return ${targetType}(${payload}); }())`
      )
    }
  },
  // A closed record's fields poured into an open dictionary; see
  // `recordCastableToDictionary` for why only this direction is sound.
  // `record-to-array` is the same distance: an unannotated rest parameter's two
  // views (`recordCastableToArray`).
  // A class instance or shared record into an open `any` document: the
  // object itself, viewed (`classDocumentViewText`), never a table of its fields.
  {
    id: 'class-document-view',
    apply: (source, target, text) => claimed(classDocumentViewText(source, target, text))
  },
  {
    id: 'record-to-dictionary',
    apply: (source, target, text) =>
      source.kind === 'record' && target.kind === 'dictionary' ? claimed(recastedRecordToDictionaryText(source, target, text)) : undefined
  },
  {
    id: 'indexed-record-to-dictionary',
    apply: (source, target, text) =>
      source.kind === 'record-with-index' && target.kind === 'dictionary'
        ? claimed(recastedIndexedRecordToDictionaryText(source, target, text))
        : undefined
  },
  // The mirror of `record-to-dictionary` for the one dictionary whose values
  // are boxed: `globalThis as unknown as { SomeGlobal?: Ctor }` reads named
  // fields out of the open string-keyed surface `references.ts` gives
  // `globalThis`. The closed field list comes from the TARGET, so this is not
  // the reconstruction `conversion/derive.ts` refuses (recovering a field list
  // from an open dictionary); it is the dynamic-object product read
  // (`unboxedLoadText`'s record branch) over that dictionary boxed, which
  // `gea::detail::dynamicRecordHasField` already reads as a document.
  {
    id: 'dictionary-to-record',
    apply: (source, target, text) => claimed(dictionaryToRecordText(source, target, text))
  },
  // Its inverse: the object a Document views, recovered at its own class.
  {
    id: 'document-viewed-object',
    apply: (source, target, text) => claimed(documentViewedObjectText(source, target, text))
  },
  // An Array of one element carrier copied into an Array of another, each
  // element through its own conversion. A copy, so only for an array that is
  // not written through both names afterwards: a matcher table built once
  // (a `[handlers.map(...), emptyParam]` literal) or a shared empty one.
  {
    id: 'array-copy-recast',
    apply: (source, target, text) => {
      if (source.kind !== 'array-object' || target.kind !== 'array-object') return undefined
      if (source.recursive || target.recursive || source.extension || target.extension) return undefined
      if (source.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return undefined
      // Never across the dynamic boundary. An element boxed or unboxed on the
      // way marks a container one authority typed `dynamic` -- an evolving
      // `var array = []` whose pushes the census could not type -- and such an
      // array is a shared MUTABLE local passed by reference: copying it hands
      // the callee a twin, so its pushes never reach the caller
      // (`test/runtime/array-object-call-argument-aliasing.ts` and its
      // `.runtime.js` sibling reproduce it). Both polarities were live miscompiles that the
      // refusal fixed on 2026-09-12; re-admitting them here silently undid
      // that fix. The record- and union-element copies this recipe was added
      // for (router matcher tables, built from literals) do not cross it --
      // and the test is the ELEMENT's own carrier, not a field somewhere
      // inside a record element: a record field boxed on the way is a shape
      // change, not the census-refused evolving array this rule names.
      const dynamicElement = (element: Representation): boolean =>
        element.kind === 'dynamic' || (element.kind === 'optional' && element.payload.kind === 'dynamic')
      if (dynamicElement(source.element) !== dynamicElement(target.element)) return undefined
      const element = cppTypeOf(source.element)
      const converted = tryCandidateText(() => convertedValueText(source.element, target.element, 'gea_element'))
      if (converted === null) return null
      const storage = cppTypeOf(target, 'owned')
      return (
        `[](const ${cppTypeOf(source)}& gea_from) { auto gea_array = gea::makeRef<${storage}>(); ` +
        `if (gea_from.get() != nullptr) gea_array->appendRangeConverted(*gea_from, 0, [](const ${element}& gea_element) { return ${converted}; }); ` +
        `return gea_array; }(${text})`
      )
    }
  },
  {
    // An array asserted to a tuple (`ownRoute as [string, H[]][]`): the tuple's
    // positions are read out of the array and converted one by one. A shorter
    // array than the tuple has no value for a required position, which the
    // assertion claimed away; it fails loudly rather than reading past the end.
    id: 'array-to-tuple',
    apply: (source, target, text) => {
      if (source.kind !== 'array-object' || target.kind !== 'record' || source.ownership !== 'shared-refcount') return undefined
      if (source.recursive || source.extension || target.accessors.length > 0 || target.fields.length === 0) return undefined
      if (!target.fields.every((field, index) => field.key === String(index) && field.required)) return undefined
      const reads: string[] = []
      for (const [index, field] of target.fields.entries()) {
        const converted = tryCandidateText(() => convertedValueText(source.element, field.value, `gea_from->readElement(${index})`))
        if (converted === null) return null
        reads.push(
          field.value.kind === 'scalar' && field.value.domain !== 'bigint'
            ? `static_cast<decltype(${cppRecordStructName(target.shapeId)}::${cppRecordFieldName(field.key)})>(${converted})`
            : converted
        )
      }
      const structure = `${cppRecordStructName(target.shapeId)}{${reads.join(', ')}}`
      const built =
        target.ownership === 'shared-refcount' ? `gea::makeRef<${cppRecordStructName(target.shapeId)}>(${structure})` : structure
      return (
        `[](const ${cppTypeOf(source)}& gea_from) { ` +
        `if (gea_from.get() == nullptr || gea_from->size() < ${target.fields.length}) gea::host::throwRuntimeError("TypeError", "an array asserted to a tuple is shorter than the tuple"); ` +
        `return ${built}; }(${text})`
      )
    }
  },
  // TWO PROMISES WHOSE PAYLOADS DIFFER. `widenedStoreText` reads a `promise`
  // target as "widen the written VALUE into a promise of it", correct for the
  // `return` terminator and wrong here, where the source is already a promise.
  // All three `[[PromiseState]]` values are carried: a rejection moves the
  // `exception_ptr` (the thrown carrier is the same on both sides), an unsettled
  // promise stays unsettled, and a `Promise<void>` on either side has no
  // `value()`. A void source supplies undefined to unit or unknown payloads;
  // other richer payloads still refuse.
  //
  // `Promise<void>` against `Promise<undefined>` is the exception, and not a
  // hole being papered over: the two are one run-time promise wearing two
  // TypeScript types (ECMA-262 27.2.1.4 fulfils a promise resolved with
  // nothing with `undefined`, which `cppResultTypeOf` elides for `void`), so
  // the state crosses and the unit value is supplied or dropped. That recipe
  // awaits the source rather than snapshotting a settled state, because
  // its source is routinely still PENDING -- an async function that awaits
  // inside -- and a snapshot of a pending promise is
  // a target nothing ever settles.
  //
  // `Promise<never>` is the one void-payload SOURCE that does not refuse, and
  // it is not a hole being papered over: a promise that cannot fulfil has no
  // fulfilment value for the target to be missing. Only the rejection has to
  // cross, so the recipe forwards it rather than reading a `value()` that does
  // not exist -- and it forwards a rejection that has not happened YET as
  // well, through `observe`, because a pending `Promise<never>` may still
  // reject and dropping that would swallow the error the whole carrier exists
  // to deliver.
  {
    id: 'promise-payload',
    apply: (source, target, text) => {
      if (source.kind !== 'promise' || target.kind !== 'promise') return undefined
      const bottomSource = source.value.kind === 'void' && source.value.bottom === true
      if (!bottomSource && (source.value.kind === 'void' || target.value.kind === 'void')) {
        if (!isUnitPromisePayload(source.value) || !acceptsVoidPromisePayload(target.value)) return undefined
        const fulfillment = target.value.kind === 'void' ? '' : target.value.kind === 'dynamic' ? 'gea::Value()' : cppUndefinedValue
        // The coroutine parameter owns a pending source until settlement.
        // Registering an observer alone would discard the sole strong handle
        // to an async call's result; its frame deliberately only watches it.
        // A noncapturing lambda keeps ownership in the frame, not its closure.
        return (
          `([](${cppTypeOf(source)} ${promiseSourceName}) -> ${cppTypeOf(target)} ` +
          `{ co_await ${promiseSourceName}; co_return${fulfillment === '' ? '' : ` ${fulfillment}`}; }(${text}))`
        )
      }
      if (source.value.kind === 'void') {
        if (source.value.bottom !== true) return undefined
        return (
          `([&]() -> ${cppTypeOf(target)} { const auto& ${promiseSourceName} = ${text}; ` +
          `if (${promiseSourceName}.rejected()) return ${cppTypeOf(target)}::rejected_with(${promiseSourceName}.rejection()); ` +
          `${cppTypeOf(target)} ${promiseTargetName}; ` +
          `${promiseSourceName}.observe([]() {}, [${promiseTargetName}](const std::exception_ptr& ${promiseRejectionName}) mutable ` +
          `{ ${promiseTargetName}.rejectInline(${promiseRejectionName}); }); ` +
          `return ${promiseTargetName}; }())`
        )
      }
      return claimed(promiseAdoptionText(source, target, text, (value) => convertedValueText(source.value, target.value, value)))
    }
  },
  // A TypeScript boundary does not call an ECMAScript abstract operation. A
  // dynamic source enters every typed carrier through its exact checked load;
  // String/Number, arithmetic, templates and property keys render their own
  // coercions at their semantic sites.
  // Before `widened-store`, which reaches the same arm through the same
  // helper: this step exists so the census names the pair by its own
  // (allocating) recipe rather than as a plain arm store.
  { id: 'readonly-map-view', apply: (source, target, text) => claimed(readOnlyMapViewStoreText(target, source, text)) },
  { id: 'dynamic-map-arm-view', apply: (source, target, text) => claimed(dynamicMapArmViewStoreText(target, source, text)) },
  { id: 'dynamic-unbox', apply: (source, target, text) => (source.kind === 'dynamic' ? unboxedLoadText(target, text) : undefined) },
  // A String OBJECT reconciled against the `string` primitive its alias widens
  // to (a `String` object branded as a string alias). Before the two general paths for the same
  // reason the dynamic case is: `narrowedLoadText` would read this as a search
  // through a union's arms and refuse, and `widenedStoreText` reads it backwards.
  {
    id: 'string-object-stringify',
    apply: (source, target, text) => (target.kind === 'string' ? claimed(stringObjectStringifyText(source, text)) : undefined)
  },
  { id: 'narrowed-load', apply: (source, target, text) => claimed(narrowedLoadText(source, target, text)) },
  // Ahead of `widened-store`, which claims every pair it reaches and refuses
  // the ones it cannot widen -- so nothing after it ever runs. A storage-free
  // `undefined` entering a carrier with no room for an absence is a branch
  // flow analysis proved dead, not a missing load: `undefined` is also
  // `never`'s carrier (`representation/primitives.ts`), and a pair the loads
  // refuse can only be reached when the source holds nothing. `var [d = 7] =
  // []` is the standing case -- the extraction past an empty tuple is
  // `undefined` outright, the default's present arm converts it to the bound
  // `number`, and the `is-defined` test guarding that arm is the constant
  // `false`. Rendered as the throw the call-site argument path already
  // renders (`emit-callable.ts`) so the dead arm does not block the live one.
  // The other direction is a read flow analysis proved yields `undefined` out
  // of a cell that holds a value on every other path: the value is
  // discarded, not converted. A carrier that CAN hold an absence -- an
  // optional, a sum, a box -- is `widened-store`'s to fill with one.
  {
    id: 'unreachable-value',
    apply: (source, target, text) => {
      // A sum holds an absence only through an arm that does: a
      // `tagged-union(array-buffer|typed-array|native-record-ref)` has no
      // arm for `undefined` to widen into, so an `undefined` reaching it is
      // `never`'s (a constructor normalizing a view it already narrowed to
      // `Uint8Array`).
      const holdsAbsence = (carrier: Representation): boolean =>
        carrier.kind === 'optional' ||
        (carrier.kind === 'tagged-union' && carrier.arms.some((arm) => holdsAbsence(arm.value))) ||
        carrier.kind === 'dynamic' ||
        carrier.kind === 'undefined' ||
        carrier.kind === 'null' ||
        carrier.kind === 'void'
      if (source.kind === 'undefined' && !holdsAbsence(target)) return `gea::host::unreachableValue<${cppTypeOf(target)}>()`
      if (target.kind === 'undefined' && !holdsAbsence(source)) return `(static_cast<void>(${text}), gea::Undefined{})`
      return undefined
    }
  },
  { id: 'widened-store', apply: (source, target, text) => widenedStoreText(target, source, text) }
]

const runConversionChain = (
  source: Representation,
  target: Representation,
  text: string
): { readonly step: ConversionStep | null; readonly text: string | null } => {
  for (const step of conversionChain) {
    const rendered = step.apply(source, target, text)
    if (rendered === undefined) continue
    return { step, text: rendered }
  }
  return { step: null, text: null }
}

/**
 * One chain call the printer still makes on a pair the IR did not already
 * align: after Phase 1.3 every operand that enters a slot arrives converted
 * by lowering, so a printer site that finds its source and target differing
 * is a decision the census does not own yet. Recorded per site so the 1.4
 * work list is measured, not guessed; the row names the site, the body and
 * the pair, and the chain still renders it.
 */
export interface PrinterDrift {
  readonly owner: string
  readonly site: string
  /**
   * `refused`: the census has no recipe and no text is rendered.
   * `converted`: the printer rendered the census's admitted node.
   */
  readonly kind: 'refused' | 'converted'
  readonly source: string
  readonly target: string
  /** The census's stated reason the pair has no recipe (`refused`), or the node's capability kind (`converted`). */
  readonly reason: string
  readonly sourceRepresentation: Representation
  readonly targetRepresentation: Representation
}

/**
 * A printer site's conversion, answered by the census: the node `nodeFor`
 * mints for the pair, rendered by the recipe it names. The site is a
 * RESULT-side one -- a call's result into the operation's carrier, a union
 * arm's field into what the read publishes, a host template's value into
 * the slot -- where the value is produced inside this printer's own
 * expression and lowering had nothing to convert; every operand-side pair
 * already arrived converted (`ir/lower-operands.ts`'s `enter`).
 *
 * A refused pair is recorded with the census's reason and renders no text.
 * Internal adaptations and structural leaves must already have exact nodes
 * published and authenticated by the IR certificate.
 */
/**
 * What a conversion site needs from its context: the census, the drift list
 * it reports to, and what the record view renders from. A body's
 * `EmitContext` is one; the program-level renderers with no body (construct
 * thunks, field initializers, virtual dispatch adapters in
 * `translation-unit.ts`) build one over the same census.
 */
export interface ConversionSite {
  readonly programConversionRecipes?: readonly ProgramConversionRecipe[]
  readonly conversionIsCertified?: (id: string) => boolean
  readonly conversions: ConversionCensus
  readonly nativeSelectionHelpers?: ReadonlyMap<string, NativeSelectionHelper>
  readonly printerDrift: PrinterDrift[]
  readonly owner: string
  readonly layouts: RecordLayoutPolicy
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly captures: CaptureIndex
  /** The dispatch members this unit emitted; absent where a site has none to name. */
  readonly virtualDispatch?: ReadonlyMap<string, CallableAbi>
  /** The function facts a minted function object registers (`cppThunkEntryText`). */
  readonly functionFacts: EmitContext['functionFacts']
  /** The function an expression is known to run (`EmitContext.callableEntryTexts`); absent where a site records none. */
  readonly knownCallableEntry?: (text: string) => FunctionId | null
  readonly abiOfCallable?: EmitContext['abiOfCallable']
  /** A scope-aware read of the method body's native lexical environment. */
  readonly methodEnvironment?: (callable: FunctionId, what: string) => string
}

export const alignedValueText = (
  ctx: ConversionSite,
  site: string,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (representationKey(source) === representationKey(target)) return text
  const node = ctx.conversions.nodeFor(source, target)
  const refused = node.capability.kind === 'never'
  ctx.printerDrift.push({
    owner: String(ctx.owner),
    site,
    kind: refused ? 'refused' : 'converted',
    source: representationKey(source),
    target: representationKey(target),
    reason: node.capability.kind === 'never' ? node.capability.reason : node.capability.kind,
    sourceRepresentation: source,
    targetRepresentation: target
  })
  return recipeText(ctx, node, text)
}

/** A native artifact consumes the exact pair published for its own physical slot. */
export const programConversionText = (
  ctx: ConversionSite,
  role: ProgramConversionRole,
  owner: string,
  slot: string,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (representationKey(source) === representationKey(target)) return text
  const key = programConversionKey({ role, owner, slot })
  const recipe = ctx.programConversionRecipes?.find((candidate) => programConversionKey(candidate) === key)
  if (
    recipe === undefined ||
    representationKey(recipe.source) !== representationKey(source) ||
    representationKey(recipe.target) !== representationKey(target)
  )
    throw createCppEmitBlockedError(
      'runtime-helper:program-conversion-recipes',
      `native artifact ${key} names no certified physical conversion`
    )
  return recipeText(ctx, recipe.conversion, text)
}

/**
 * A census node's recipe, rendered by one of the two renderers the census
 * owns. The chain first: the registry's atoms ARE its narrowing, widening
 * and recasting steps, and its static recipes are named by the step that
 * claimed the pair (`conversions.ts`'s `staticRecipe`). Then the structural
 * record view (`conversion/record-view.ts`), which renders both the
 * `view:structural-record` recipe and the registry's `gea::record::recast`
 * atom -- the eager graph minted that atom for a by-value record entering
 * an interface's shared shape before the view plan existed, and the chain's
 * `record-recast` step spells only the by-reference recast, so the view is
 * that atom's renderer. Keyed by capability KIND rather than by materializer
 * id on purpose: a node's id says which table answered, not which text
 * spells it, and every non-`never` node has exactly one of these two.
 *
 * `class-family` is a third renderer, asked before the chain rather than
 * folded into it: `classFamilyLoadText` orders its cascade over
 * `ctx.classes`, the whole-program class table, and the chain
 * (`convertedValueText`) is deliberately ctx-free -- see `algebra.ts`'s doc
 * on the kind for why an `atom` cannot carry this recipe.
 */
/**
 * A named interface -- `native-record-ref`, which names its layout rather than
 * carrying it -- read out of a dynamic value, at the top or as the element of
 * an Array: the layout is resolved here, where the layouts are in hand, and
 * the read is `unboxedLoadText`'s own record conversion (checked product,
 * Document adoption, TypeError). The ctx-free chain would otherwise read the
 * name back by identity alone, which aborts on every parsed or decoded document.
 */
const dynamicNamedRecordText = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (source.kind !== 'dynamic' || source.reason === 'untyped-callable') return null
  const expanded = expandedNamedRecords(layouts, target, new Set())
  return expanded === null ? null : unboxedLoadText(expanded, text)
}

/**
 * A declared `any` read into `target` where no conversion node was minted --
 * a boxed struct's field dispatcher writing a member (`records.ts`). Shared
 * structural objects require an explicit canonical recipe. Exact nominal
 * payloads and owned copies retain their context-free native contracts.
 */
export const dynamicValueLoadText = (
  layouts: RecordLayoutPolicy,
  target: Representation,
  text: string,
  selected?: { readonly site: ConversionSite; readonly conversion: ConversionNode }
): string | null => {
  if (selected !== undefined) {
    const node = selected.conversion
    if (
      node.source.kind !== 'dynamic' ||
      node.source.reason === 'untyped-callable' ||
      representationKey(node.target) !== representationKey(target) ||
      selected.site.conversions.nodeById(node.id) !== node
    )
      return null
    return recipeText(selected.site, node, text)
  }
  if (dynamicRecordLoadNeedsPlan(target, layouts)) return null
  return (
    dynamicNamedRecordText(layouts, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target, text) ??
    unboxedLoadText(target, text)
  )
}

/**
 * An `any` entering a union one arm of which is a native Proxy: an optional
 * dependency `dep = require('dep')` into `Module | { kModuleError }`,
 * a slot an error-module Proxy also fills. No box holds a native
 * Proxy (`dynamicTagFor` refuses one, and `conversion/derive.ts` skips the
 * arm), so the proxy arm is never the destination. Every other arm must be a
 * record the checked dynamic record conversion builds: a box holding that
 * record's own struct lands in it by identity first; then an object holding
 * every key a record arm requires is adopted as that arm (Document adoption,
 * field checks and all, `unboxedLoadText`); anything else is the TypeError a
 * program may catch. The union is never boxed.
 */
const dynamicIntoProxyArmUnionText = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (source.kind !== 'dynamic' || source.reason === 'untyped-callable') return null
  if (target.kind !== 'tagged-union') return null
  // A union of records alone is the same read: a box holding another
  // instantiation's layout of the same interface (`AnyBulkWriteOperation<T>`
  // at two `T`s) carries a different struct, so identity picks no arm and the
  // exact-payload chain aborts on a value the type admits. The arm whose
  // required keys the object holds is rebuilt, nested named records included.
  const recordArms = target.arms.every(
    (arm) => arm.value.kind === 'proxy-object' || arm.value.kind === 'record' || arm.value.kind === 'native-record-ref'
  )
  if (!recordArms || target.arms.length < 2) return null
  const holder = 'gea_dynamic_module'
  const targetType = cppTypeOf(target)
  const arms: { readonly index: number; readonly exact: string; readonly required: readonly string[]; readonly load: string }[] = []
  for (const [index, arm] of target.arms.entries()) {
    if (arm.value.kind === 'proxy-object') continue
    const named = arm.value.kind === 'native-record-ref' ? expandedNamedRecords(layouts, arm.value, new Set()) : arm.value
    // A record arm's own named-record fields expand too: a box of another
    // layout is rebuilt field by field, so a nested interface must be rebuilt
    // rather than demanded by identity (`dynamicFieldAdmissionText`).
    const record =
      named !== null && (named.kind === 'record' || named.kind === 'record-with-index')
        ? {
            ...named,
            fields: named.fields.map((field) => {
              const value = expandedNamedRecords(layouts, field.value, new Set([named.shapeId]))
              return value === null ? field : { ...field, value }
            })
          }
        : named
    if (record === null || !adoptsDynamicRecord(record) || (record.kind !== 'record' && record.kind !== 'record-with-index')) return null
    if (record.fields.some((field) => field.required && cppRecordFieldKeyIsSymbol(field.key))) return null
    const load = unboxedLoadText(record, holder)
    if (load === null) return null
    arms.push({
      index,
      exact: `gea::detail::payloadTypeTagFor<${cppTypeOf(arm.value)}>()`,
      required: record.fields.filter((field) => field.required).map((field) => field.key),
      load
    })
  }
  if (arms.length === 0) return null
  const object = `(${holder}.tag() == gea::Value::Tag::Object || ${holder}.tag() == gea::Value::Tag::Function)`
  const exact = arms.map(
    ({ index, exact: payload, load }) =>
      `if (${holder}.tag() == gea::Value::Tag::Object && ${holder}.payloadType() == ${payload}) return ${targetType}::ofArm<${index}>(${load});`
  )
  const structural = arms.map(({ index, required, load }) => {
    const keys = required.map((key) => `gea::detail::dynamicRecordHasField(${holder}, ${cppStringLiteral(key)})`)
    return `if (${[object, ...keys].join(' && ')}) return ${targetType}::ofArm<${index}>(${load});`
  })
  return (
    `[](const gea::Value& ${holder}) -> ${targetType} { ${[...exact, ...structural].join(' ')} ` +
    `gea::host::throwRuntimeError("TypeError", ${cppStringLiteral("a dynamic value is none of the union's object arms")}); }(${text})`
  )
}

/**
 * `target` with every compiler-owned named record it reads by value expanded
 * to its layout (fields expanded the same way), or `null` when it names none.
 * A shape already being expanded stays a name: a recursive layout reads its
 * inner occurrence by identity, as before.
 */
const expandedNamedRecords = (layouts: RecordLayoutPolicy, target: Representation, open: Set<string>): Representation | null => {
  if (target.kind === 'optional') {
    const payload = expandedNamedRecords(layouts, target.payload, open)
    return payload === null ? null : { ...target, payload }
  }
  if (target.kind === 'array-object') {
    if (target.extension !== null) return null
    const element = expandedNamedRecords(layouts, target.element, open)
    return element === null ? null : { ...target, element }
  }
  if (target.kind !== 'native-record-ref' || target.native !== null || target.recursive || target.ownership !== 'shared-refcount')
    return null
  if (open.has(target.shapeId)) return null
  const fields = layouts.forShape(target.shapeId)
  if (fields === null || (layouts.accessorsForShape(target.shapeId)?.length ?? 0) !== 0) return null
  open.add(target.shapeId)
  const expandedFields = fields.map((field) => {
    const value = expandedNamedRecords(layouts, field.value, open)
    return value === null ? field : { ...field, value }
  })
  open.delete(target.shapeId)
  const indexes = layouts.indexesForShape(target.shapeId)
  return indexes.length === 0
    ? { kind: 'record', shapeId: target.shapeId, fields: expandedFields, accessors: [], ownership: target.ownership }
    : { kind: 'record-with-index', shapeId: target.shapeId, fields: expandedFields, indexes, ownership: target.ownership }
}

/**
 * The recipe's text with its source evaluated once, however many times the
 * recipe names it -- see `evaluated-once.ts`.
 */
export const recipeText = (ctx: ConversionSite, node: ConversionNode, text: string): string | null => {
  if (ctx.conversionIsCertified !== undefined && (ctx.conversions.nodeById(node.id) !== node || !ctx.conversionIsCertified(node.id)))
    throw createCppEmitBlockedError(`conversion:${node.id}`, 'the conversion dispatcher requires the exact certified recipe')
  return evaluatedOnceText(text, (operand) => renderedRecipeText(ctx, node, operand))
}

const dynamicWrapperText = (ctx: ConversionSite, plan: DynamicWrapperPlan, node: ConversionNode, text: string): string | null => {
  if (!dynamicWrapperPlanMatches(plan, node.source, node.target, ctx.conversions.nodeById)) return null
  const targetType = cppTypeOf(plan.target)
  if (plan.kind === 'optional') {
    const payload = recipeText(ctx, plan.payload, text)
    if (payload === null) return null
    const absentTag = plan.target.absence === 'null' ? 'Null' : 'Undefined'
    return `(${text}.tag() == gea::Value::Tag::${absentTag} ? ${targetType}() : ${targetType}(${payload}))`
  }
  if (plan.kind === 'promise') {
    const payload = recipeText(ctx, plan.payload, 'gea_settled')
    return payload === null
      ? null
      : `gea::detail::promiseFromDynamic<${cppTypeOf(plan.target.value)}>(${text}, [](const gea::Value& gea_settled) { return ${payload}; })`
  }
  const test = (discriminant: BoxDiscriminant): string => {
    if (discriminant.callableMembers !== null) {
      const membership = discriminant.callableMembers
        .map((member) => `${text}.callableDeclarationIdentity() == gea::detail::callableDeclarationTagFor<&${cppThunkName(member)}>()`)
        .join(' || ')
      return `(${text}.tag() == gea::Value::Tag::Function && (${membership}))`
    }
    if (discriminant.nominal !== null)
      return (
        `(${text}.tag() == gea::Value::Tag::Object && ${text}.classObject() && ` +
        `gea::detail::classIdentityExtends(${text}.classIdentity(), &gea::detail::RefOperationsFor<${discriminant.nominal}>::table))`
      )
    return discriminant.payload === null
      ? `${text}.tag() == gea::Value::Tag::${discriminant.tag}`
      : `(${text}.tag() == gea::Value::Tag::${discriminant.tag} && ${text}.payloadType() == gea::detail::payloadTypeTagFor<${discriminant.payload}>())`
  }
  const branch = (entry: Extract<DynamicWrapperPlan, { kind: 'union' }>['arms'][number]): { condition: string; value: string } | null => {
    const arm = plan.target.arms[entry.index]!
    if (entry.classifier.id === 'gea::detail::nativeArrayViewAccepts') {
      if (entry.conversion.capability.kind !== 'atom' || !entry.conversion.capability.materializer.nativeArrayView) return null
      const selected = entry.conversion.capability.materializer.nativeArrayView
      if (entry.classifier !== entry.conversion.capability.classifier) return null
      const value = recipeText(ctx, entry.conversion, text)
      return value === null
        ? null
        : {
            condition: `gea::detail::${entry.byElements ? 'nativeArrayViewAcceptsExact' : 'nativeArrayViewAccepts'}<${cppTypeOf(selected.target.element)}, ${nativeFieldPolicyType(selected.target.element)}>(${text})`,
            value: `${targetType}::ofArm<${entry.index}>(${value})`
          }
    }
    const discriminants = boxDiscriminantsOfArm(arm)
    if (!discriminants?.length) return null
    const tagCondition = discriminants.map(test).join(' || ')
    let condition: string
    if (entry.classifier.id === 'gea::detail::dynamicRecordDiscriminator') {
      const discriminator = arm.runtimeDiscriminator
      const certified = entry.classifier.recordDiscriminator
      if (
        discriminator.kind !== 'record-literal' ||
        certified === undefined ||
        certified.key !== discriminator.key ||
        certified.primitive !== discriminator.primitive ||
        certified.text !== discriminator.text
      )
        return null
      const tag = discriminator.primitive === 'string' ? 'String' : discriminator.primitive === 'number' ? 'Number' : 'Boolean'
      const type = discriminator.primitive === 'string' ? 'std::string' : discriminator.primitive === 'number' ? 'double' : 'bool'
      const literal = discriminator.primitive === 'string' ? cppStringLiteral(discriminator.text) : discriminator.text
      condition =
        `([](const gea::Value& object, bool nativeRecord) { if (object.tag() != gea::Value::Tag::Object) return false; ` +
        `const auto value = gea::detail::dynamicRecordDiscriminator(object, ${cppStringLiteral(discriminator.key)}, nativeRecord); ` +
        `return value.tag() == gea::Value::Tag::${tag} && ` +
        `gea::detail::unboxValue<${type}>(value, gea::Value::Tag::${tag}, "a union discriminator") == ${literal}; }(${text}, ${tagCondition}))`
    } else if (
      entry.classifier.id === 'gea::Value::tag' ||
      entry.classifier.id === 'gea::Value::tagAnyOf' ||
      entry.classifier.id === 'gea::Value::tag+payloadType' ||
      entry.classifier.id === 'gea::Value::callableDeclarationIdentity' ||
      entry.classifier.id === 'gea::detail::classIdentityExtends'
    )
      condition = tagCondition
    else return null
    const value = recipeText(ctx, entry.conversion, text)
    return value === null ? null : { condition, value: `${targetType}::ofArm<${entry.index}>(${value})` }
  }
  // A record arm read through a live view admits any object holding its
  // required keys: another instantiation's layout of the same interface, or a
  // Document. Those shape tests run after every exact test, and an object no
  // arm admits is the TypeError a program may catch, never an abort.
  const shaped = plan.arms.filter((entry) => entry.byShape)
  const elementwise = plan.arms.filter((entry) => entry.byElements)
  let result =
    shaped.length === 0 && elementwise.length === 0
      ? `([]() -> ${targetType} { gea::detail::refusePayloadMismatch("a dynamic value admitted by no union arm"); }())`
      : `([]() -> ${targetType} { gea::host::throwRuntimeError("TypeError", ${cppStringLiteral("a dynamic value is none of the union's object arms")}); }())`
  for (let index = shaped.length - 1; index >= 0; index--) {
    const entry = shaped[index]!
    const value = plan.target.arms[entry.index]!.value
    const fields =
      value.kind === 'record' || value.kind === 'record-with-index'
        ? value.fields
        : value.kind === 'native-record-ref'
          ? ctx.layouts.forShape(value.shapeId)
          : null
    if (fields === null || fields.some((field) => field.required && cppRecordFieldKeyIsSymbol(field.key))) return null
    const payload = recipeText(ctx, entry.conversion, text)
    if (payload === null) return null
    const condition = [
      `${text}.tag() == gea::Value::Tag::Object || ${text}.tag() == gea::Value::Tag::Function`,
      ...fields
        .filter((field) => field.required)
        .map((field) => `gea::detail::dynamicRecordHasField(${text}, ${cppStringLiteral(field.key)})`)
    ]
    result = `((${condition.join(') && (')}) ? ${targetType}::ofArm<${entry.index}>(${payload}) : ${result})`
  }
  for (let index = elementwise.length - 1; index >= 0; index--) {
    const entry = elementwise[index]!
    if (entry.conversion.capability.kind !== 'atom' || !entry.conversion.capability.materializer.nativeArrayView) return null
    const element = entry.conversion.capability.materializer.nativeArrayView.target.element
    const payload = recipeText(ctx, entry.conversion, text)
    if (payload === null) return null
    result =
      `(gea::detail::nativeArrayViewElementsAccept<${cppTypeOf(element)}, ${nativeFieldPolicyType(element)}>(${text}) ? ` +
      `${targetType}::ofArm<${entry.index}>(${payload}) : ${result})`
  }
  for (let index = plan.arms.length - 1; index >= 0; index--) {
    const arm = branch(plan.arms[index]!)
    if (arm === null) return null
    result = `(${arm.condition} ? ${arm.value} : ${result})`
  }
  return result
}

const renderedRecipeText = (ctx: ConversionSite, node: ConversionNode, text: string): string | null => {
  if (node.capability.kind === 'identity') return text
  if (node.capability.kind === 'never') return null
  if (node.capability.kind === 'atom' || node.capability.kind === 'static') {
    const materializer = node.capability.materializer
    if (materializer.nativeArrayView) return nativeArrayViewText(ctx, node, materializer.nativeArrayView, text)
    if (materializer.dynamicWrapper) return dynamicWrapperText(ctx, materializer.dynamicWrapper, node, text)
    if (
      node.source.kind === 'dynamic' &&
      node.target.kind === 'native-record-ref' &&
      node.capability.kind === 'atom' &&
      node.capability.classifier.id === 'gea::Value::payloadType' &&
      materializer.id === 'gea::detail::unboxValue' &&
      materializer.nativeFieldProtocol === 'unused' &&
      materializer.nativePayloadTransport === 'preserved' &&
      !materializer.allocates
    )
      return `gea::detail::unboxValue<${cppTypeOf(node.target)}>(${text}, gea::Value::Tag::Object, ${cppStringLiteral(assertionSite(node.target))})`
    if (materializer.id === NATIVE_REFERENCE_ABSENCE) {
      const absence = nativeReferenceAbsenceOf(node.source, node.target)
      if (absence === null) return null
      return `((void)(${text}), ${cppTypeOf(node.target)}${absence === 'undefined' ? '::undefined()' : '{}'})`
    }
    if (materializer.nativeLogicalReceiver) {
      const receiver = materializer.nativeLogicalReceiver
      const transport = nativeCallReceiverText(receiver.receiver, 'gea_physical_receiver', (source, value) => {
        const child = receiver.materializers.find((candidate) => representationKey(candidate.source) === representationKey(source))
        return child === undefined ? null : recipeText(ctx, child, value)
      })
      const factory = `+[](const ${cppTypeOf(receiver.receiver)}& gea_physical_receiver) -> gea::NativeCallReceiver { return ${transport}; }`
      return unboxedLoadText(node.target, text, factory)
    }
    // A boxed constructor adapted to its construct frame: `new` runs through
    // the box and the census's reader converts what it built.
    if (materializer.constructedResult && node.target.kind === 'constructor-value-dispatch') {
      const result = node.target.abi.result
      const read = recipeText(ctx, materializer.constructedResult, 'gea_constructed')
      if (read === null) return null
      const reader = `+[](const gea::Value& gea_constructed) -> ${cppTypeOf(result)} { return ${read}; }`
      return `gea::detail::DynamicCarrier<${cppTypeOf(node.target)}>::template readWith<${reader}>(${text})`
    }
    if (materializer.dictionaryView) return dictionaryViewText(ctx, materializer.dictionaryView, text)
    if (materializer.dictionaryRead)
      return dictionaryReadText(materializer.dictionaryRead, text, (child, value) => recipeText(ctx, child, value))
    if (materializer.readOnlyDictionary) return dictionaryViewText(ctx, materializer.readOnlyDictionary, text)
    if (materializer.documentRecordView) return documentRecordViewText(ctx, materializer.documentRecordView, text)
    if (materializer.nativeDescriptorSnapshot) return nativeDescriptorSnapshotViewText(ctx, materializer.nativeDescriptorSnapshot, text)
    if (materializer.nativeObjectSample)
      return nativeObjectSampleText(materializer.nativeObjectSample, text, (child, value) => recipeText(ctx, child, value))
    if (materializer.recordView) return certifiedRecordViewText(ctx, materializer.recordView, text)
    if (materializer.recordToArray) return recastedRecordToArrayText(ctx, materializer.recordToArray, text)
    if (materializer.callableView) return callableViewText(ctx, materializer.callableView, text)
    if (materializer.callablePayload) return callablePayloadText(ctx, materializer.callablePayload, text)
    if (materializer.iteratorObjectView) return certifiedIteratorObjectViewText(ctx, materializer.iteratorObjectView, text)
    if (materializer.iterableObjectView) return certifiedIterableObjectViewText(ctx, materializer.iterableObjectView, text)
    if (materializer.protocolIterator) return certifiedProtocolIteratorText(ctx, materializer.protocolIterator, text)
    if (materializer.nativeMethod)
      return nativeUnboundMethodText(materializer.nativeMethod, text, (child, value) => recipeText(ctx, child, value))
    if (materializer.nativeMethodResult && node.source.kind === 'class-ref' && node.target.kind === 'class-ref') {
      const checked = recipeText(ctx, materializer.nativeMethodResult.checked, 'gea_native_method_result')
      if (checked === null) return null
      const target = cppTypeOf(node.target)
      return (
        `[&](const ${cppTypeOf(node.source)}& gea_native_method_result) -> ${target} { ` +
        `if (gea_native_method_result.isUndefined()) return ${target}::undefined(); ` +
        `if (!gea_native_method_result) return ${target}{}; return ${checked}; }(${text})`
      )
    }
    if (materializer.checkedNativeFieldRead) {
      if (!checkedNativeFieldReadMismatchOf(node.source, node.target, materializer.checkedNativeFieldRead.checked)) return null
      return (
        `[&](const ${cppTypeOf(node.source)}& gea_checked_field) -> ${cppTypeOf(node.target)} { ` +
        `(void)gea_checked_field; gea::detail::refusePayloadMismatch(${cppStringLiteral(assertionSite(node.target))}); }(${text})`
      )
    }
    if (materializer.id === SIBLING_CLASS_ARGUMENT)
      return `((void)(${text}), []() -> ${cppTypeOf(node.target)} { gea::host::throwRuntimeError("TypeError", "a value of another instantiation of this generic class was passed"); }())`
    if (materializer.id === 'gea::Promise::adopt-converted' && node.source.kind === 'promise' && node.target.kind === 'promise') {
      return materializer.promiseAdoption
        ? promiseCompletionText(node.source, node.target, text, materializer.promiseAdoption, (payload, value) =>
            recipeText(ctx, payload, value)
          )
        : null
    }
    if (materializer.id === IMPOSSIBLE_FIELD_READ || materializer.id === IMPOSSIBLE_INDEX_READ)
      return `((void)(${text}), gea::host::unreachableValue<${cppTypeOf(node.target)}>())`
  }
  if (node.capability.kind === 'coercion') return coercionText(node.capability.operation, text, node.source, ctx.layouts)
  if (node.capability.kind === 'class-family') return classFamilyLoadText(ctx, node.source, node.target, text)
  // A callable the emitter saw allocated, adapted to another result convention.
  if (
    (node.capability.kind === 'atom' || node.capability.kind === 'static') &&
    node.capability.materializer.id === 'gea::CallableObject::result-adapter'
  ) {
    const known = ctx.knownCallableEntry?.(text) ?? null
    const knownAbi = known === null ? null : ctx.abiOfCallable?.(known)
    if (known !== null && knownAbi && 'abi' in node.source && abiKey(knownAbi) === abiKey(node.source.abi)) {
      const adapted = resultAdaptedCallableText(node.source, node.target, text, undefined, known)
      if (adapted !== null) return adapted
    }
  }
  // `conversions.ts`'s read of a structural value as a class nothing instantiates.
  if (node.capability.kind === 'atom' && node.capability.materializer.id === 'gea::host::unreachableValue')
    return `((void)(${text}), gea::host::unreachableValue<${cppTypeOf(node.target)}>())`
  // The census's exact-arm projection (`nodes.ts`'s `exactArmFor`): the arm
  // index is a function of the pair, so it is re-derived here rather than
  // carried on the node.
  if (node.capability.kind === 'static' && node.capability.materializer.id === EXACT_ARM_MATERIALIZER)
    return `gea::host::exactArm<${exactArmIndexOf(node.source, node.target)}>(${text})`
  // The census's native-base view (`nodes.ts`'s `nativeBaseViewFor`).
  if (node.capability.kind === 'static' && node.capability.materializer.id === NATIVE_BASE_VIEW_MATERIALIZER)
    return node.target.kind === 'promise'
      ? // The runtime promise is a handle over shared state, not a `Ref`: the
        // view copies the base subobject, which settles as the instance does.
        `${cppTypeOf(node.target)}(static_cast<const ${cppTypeOf(node.target)}&>(*(${text})))`
      : `${cppTypeOf(node.target)}(${text})`
  // The census's asserted-union dispatch (`nodes.ts`'s `assertedUnionFor`).
  if (node.capability.kind === 'static' && node.capability.materializer.id === ASSERTED_UNION_MATERIALIZER)
    return assertedUnionText(node.source, node.target, text, false)
  if (node.capability.kind === 'static' && node.capability.materializer.id === ASSERTED_UNION_COPY_MATERIALIZER)
    return assertedUnionText(node.source, node.target, text, true)
  // The census's asserted record-to-class view (`nodes.ts`'s `assertedViewFor`).
  if (node.capability.kind === 'static' && node.capability.materializer.id === ASSERTED_VIEW_MATERIALIZER)
    return node.capability.materializer.assertedView ? assertedViewText(ctx, node, node.capability.materializer.assertedView, text) : null
  // The census's per-arm view (`nodes.ts`'s `armViewFor`).
  if (node.capability.kind === 'static' && node.capability.materializer.id === ARM_VIEW_MATERIALIZER)
    return armViewText(node.source, node.target, text)
  // The census's nullish `any` into an optional parameter (`nodes.ts`'s `nullishOptionalFor`).
  if (
    node.capability.kind === 'static' &&
    node.capability.materializer.id === NULLISH_OPTIONAL_MATERIALIZER &&
    node.target.kind === 'optional'
  ) {
    const optionalType = cppTypeOf(node.target)
    const payloadNode = node.capability.materializer.dependencies?.find(
      (child) =>
        representationKey(child.source) === representationKey(node.source) &&
        representationKey(child.target) === representationKey(node.target.kind === 'optional' ? node.target.payload : node.target)
    )
    if (!payloadNode || ctx.conversions.nodeById(payloadNode.id) !== payloadNode) return null
    const payload = recipeText(ctx, payloadNode, 'gea_nullish')
    if (payload === null) return null
    return (
      `[](const gea::Value& gea_nullish) -> ${optionalType} { return gea_nullish.tag() == gea::Value::Tag::Null || ` +
      `gea_nullish.tag() == gea::Value::Tag::Undefined ? ${optionalType}() : ${optionalType}(${payload}); }(${text})`
    )
  }
  // The census's checked class downcast for an `as Derived` receiver
  // (`nodes.ts`'s `assertedClassDowncastFor`).
  if (
    node.capability.kind === 'static' &&
    node.capability.materializer.id === ASSERTED_CLASS_DOWNCAST_MATERIALIZER &&
    node.target.kind === 'class-ref'
  )
    return `gea::host::assertedDowncastClassRef<${cppClassName(node.target.declaration)}>(${text})`
  // The census's caught-value handoff (`nodes.ts`'s `caughtHandoffFor`).
  if (
    node.capability.kind === 'static' &&
    node.capability.materializer.id === CAUGHT_HANDOFF_MATERIALIZER &&
    node.target.kind === 'class-ref'
  )
    return `gea::detail::unboxCaughtClassRef<${cppClassName(node.target.declaration)}>(${text})`
  // `conversions.ts`'s last resort for a union some arms of which have no home.
  if (node.capability.kind === 'static' && node.capability.materializer.id === CHECKED_ARM_NARROWING)
    return checkedArmNarrowingText(node.source, node.target, text)
  // `conversions.ts`'s callable adapter whose parameters need the layouts.
  if (node.capability.kind === 'static' && node.capability.materializer.id === VIEW_ADAPTED_CALLABLE)
    return node.capability.materializer.callableView ? callableViewText(ctx, node.capability.materializer.callableView, text) : null
  // The census's family-member view (`nodes.ts`'s `familyMemberViewFor`).
  if (node.capability.kind === 'static' && node.capability.materializer.id === FAMILY_MEMBER_VIEW_MATERIALIZER)
    return node.familyMembers === undefined ? null : familyMemberViewText(ctx, node.source, node.target, node.familyMembers, text)
  // Recover the authenticated native class origin of a structural view.
  if (
    node.capability.kind === 'atom' &&
    node.capability.materializer.id === 'gea::record::viewOrigin' &&
    node.target.kind === 'class-ref'
  ) {
    const target = node.target
    const load = (value: string): string => `gea::record::viewOriginClassRef<${cppClassName(target.declaration)}>(${value})`
    return node.source.kind === 'optional'
      ? `((${text}).has_value() ? ${load(`(*${text})`)} : ${cppTypeOf(target)}${node.source.absence === 'null' ? '()' : '::undefined()'})`
      : load(text)
  }
  if ((node.capability.kind === 'atom' || node.capability.kind === 'static') && node.capability.materializer.nativeSelection) {
    const helper = ctx.nativeSelectionHelpers?.get(node.id)
    return helper
      ? `${helper.name}(${text})`
      : nativeSelectionText(node.capability.materializer.nativeSelection, node.source, node.target, text)
  }
  // A named interface poured into a dictionary: the chain is ctx-free and a
  // `native-record-ref` only names its layout, so the field list is resolved
  // here, the same way `conversions.ts` admitted the pair.
  if (
    (node.capability.kind === 'static' || node.capability.kind === 'atom') &&
    node.capability.materializer.id === 'gea::record::recastToDictionary' &&
    node.source.kind === 'native-record-ref' &&
    node.target.kind === 'dictionary'
  ) {
    const fields = ctx.layouts.forShape(node.source.shapeId)
    if (fields === null) return null
    return recastedRecordToDictionaryText(
      { kind: 'record', shapeId: node.source.shapeId, ownership: node.source.ownership, fields, accessors: [] },
      node.target,
      text,
      cppTypeOf(node.source)
    )
  }
  if (
    (node.capability.kind === 'static' || node.capability.kind === 'atom') &&
    (node.capability.materializer.id === INDEXED_RECORD_TO_DICTIONARY ||
      node.capability.materializer.id === INDEXED_RECORD_INTO_DICTIONARY_ARM)
  ) {
    const view = indexedRecordViewOf(node.source, ctx.layouts)
    if (view === null) return null
    if (node.target.kind === 'dictionary') return recastedIndexedRecordToDictionaryText(view, node.target, text, cppTypeOf(node.source))
    const arm = indexedRecordDictionaryArmOf(view, node.target)
    if (arm === null || node.target.kind !== 'tagged-union') return null
    const armTarget = node.target.arms[arm]!.value
    if (armTarget.kind !== 'dictionary') return null
    const poured = recastedIndexedRecordToDictionaryText(view, armTarget, text, cppTypeOf(node.source))
    return poured === null ? null : `${cppTypeOf(node.target)}::ofArm<${arm}>(${poured})`
  }
  if (
    (node.capability.kind === 'static' || node.capability.kind === 'atom') &&
    node.capability.materializer.id === CONSTRUCTOR_STATIC_VIEW
  ) {
    return constructorStaticViewText(node.source, node.target, text)
  }
  const adopted = dynamicNamedRecordText(ctx.layouts, node.source, node.target, text)
  if (adopted !== null) return adopted

  const module = dynamicIntoProxyArmUnionText(ctx.layouts, node.source, node.target, text)
  if (module !== null) return module
  if (node.capability.kind === 'atom' && node.capability.materializer.id === PROTOCOL_ITERATOR)
    return protocolIteratorText(ctx, node.source, node.target, text)
  if (node.capability.kind === 'atom' && node.capability.materializer.id === ITERATOR_OBJECT_VIEW)
    return iteratorObjectViewText(ctx, node.source, node.target, text)
  if (node.capability.kind === 'atom' && node.capability.materializer.id === ITERABLE_OBJECT_VIEW)
    return iterableObjectViewText(ctx, node.source, node.target, text)
  if (node.capability.kind === 'atom' && node.capability.materializer.id === CONSTRUCTOR_IDENTITY_FAMILY)
    return constructorIdentityFamilyText(ctx, node.source, node.target, text)
  if (node.capability.kind === 'atom' && node.capability.materializer.id === CONSTRUCTOR_DISPATCH_FAMILY)
    return constructorDispatchFamilyText(ctx, node.source, node.target, text)
  return convertedValueText(node.source, node.target, text) ?? structuralRecordViewText(ctx, node.source, node.target, text)
}

/**
 * The text of a node a `convert` instruction NAMES, rather than of the pair
 * it spans: a coercion node shares its (source, target) pair with the store
 * node `alignedValueText` would look up -- `string -> scalar(number)` is an
 * exact tag read as a store and StringToNumber as a coercion -- so the
 * instruction's own node id is the only thing that says which one runs.
 */
export const namedConversionText = (ctx: ConversionSite, site: string, node: ConversionNode, text: string): string | null => {
  const refused = node.capability.kind === 'never'
  // A named, certified node is the IR's conversion decision. Drift records
  // decisions the printer supplies itself, including uncertified named nodes.
  if (ctx.conversionIsCertified?.(node.id) !== true)
    ctx.printerDrift.push({
      owner: String(ctx.owner),
      site,
      kind: refused ? 'refused' : 'converted',
      source: representationKey(node.source),
      target: representationKey(node.target),
      reason: node.capability.kind === 'never' ? node.capability.reason : node.capability.kind,
      sourceRepresentation: node.source,
      targetRepresentation: node.target
    })
  return recipeText(ctx, node, text)
}

export const convertedValueText = (source: Representation, target: Representation, text: string): string | null => {
  if (representationKey(source) === representationKey(target)) return text
  if (standInRefuses(source, target)) return null
  // A void TARGET is the language's explicit discard conversion. The source
  // operation has already evaluated its effects; this expression preserves a
  // valid C++ void value for callers that return or forward the conversion,
  // without naming a storage type that cannot exist. A void SOURCE cannot
  // produce any non-void target and remains a named refusal.
  if (target.kind === 'void') return `(void)(${text})`
  if (source.kind === 'void') {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(target)}`,
      `reconciles a ${source.kind} source with a ${target.kind} target`
    )
  }
  // Refused HERE: `cppTypeOf` throws a bare `Error` on lattice bottom that
  // escapes the per-body catch and kills the whole compile otherwise.
  if (containsUnresolved(source) || containsUnresolved(target)) {
    const bottom = [...walkRepresentation(source), ...walkRepresentation(target)].find((f) => f.kind === 'unresolved') as
      { reason?: string } | undefined
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(target)}`,
      `reconciles against ${bottom?.reason ?? 'an unresolved representation'}`
    )
  }
  return evaluatedOnceText(text, (operand) => runConversionChain(source, target, operand).text)
}

/**
 * Whether a carrier has physical storage at all: the representation's own
 * answer (`physicalCarrierKey`), so admissibility is never decided by trying
 * to print a type and catching the throw. Remembered by identity -- the
 * registry asks it of every pair it is probed with.
 */
const spellability = new WeakMap<Representation, boolean>()

export const isSpellable = (representation: Representation): boolean => {
  const known = spellability.get(representation)
  if (known !== undefined) return known
  const spellable = physicalCarrierKey(representation) !== null
  spellability.set(representation, spellable)
  return spellable
}

/**
 * The chain's answer for a pair, as a predicate: the registry's static recipe
 * and a record view's field and arm pairs (`conversion/record-view.ts`) ask
 * this one question, so a view the census admits is a view the printer
 * renders.
 */
export const chainConverts = (source: Representation, target: Representation): boolean =>
  isSpellable(source) && isSpellable(target) && (conversionRecipeOf(source, target)?.renders ?? false)

/**
 * Which chain step answers a pair, decided by running the chain on a
 * placeholder: the steps decide from the two carriers alone and only thread
 * the text through, so the answer is the one `convertedValueText` gives. A
 * step that claims the pair but cannot render it is reported with
 * `renders: false`; a pair no step claims is `null`.
 */
export const conversionRecipeOf = (
  source: Representation,
  target: Representation
): { readonly id: string; readonly renders: boolean } | null => {
  if (representationKey(source) === representationKey(target)) return { id: 'identity', renders: true }
  if (target.kind === 'void') return { id: 'discard-into-void', renders: true }
  if (source.kind === 'void' || containsUnresolved(source) || containsUnresolved(target)) return null
  const probed = withoutUnitFunctions(() =>
    tryCandidateText(() => {
      const outcome = runConversionChain(source, target, 'gea_conversion_probe')
      return outcome.step === null ? null : `${outcome.step.id}\u0000${outcome.text === null ? '' : 'renders'}`
    })
  )
  if (probed === null) return null
  const [id, renders] = probed.split('\u0000')
  return { id: id ?? 'unknown', renders: renders === 'renders' }
}

/**
 * Whether this carrier OWNS what it holds, so handing it over is a move rather
 * than a copy.
 *
 * A `string` owns a heap buffer the same way a counted reference owns a count,
 * and hands it over the same way. `JSON.stringify`'s result is the case that
 * made this visible: a 300 KB text was copied out of the value the serializer
 * had just built into the cell that names it, once per call.
 *
 * An `optional` owns whatever its payload owns and nothing else --
 * `gea::Optional<gea::Ref<T>>` is a `Ref` plus a presence bit, and moving it
 * moves the `Ref`. A recursive binary-tree sum is the case: `sum(node.left)` reads a
 * `TreeNode | null` field into a temporary and passes it by value, which is an
 * increment on the way in and a decrement, a branch and an out-of-line
 * destructor on the way out, twice for every one of a million nodes. The
 * hand-written baseline it is measured against passes a raw pointer.
 */
const ownsItsStorage = (carrier: Representation): boolean => {
  if (carrier.kind === 'string') return true
  // A box is three counted handles (`gea::Value`'s function, class and held
  // payload references) plus a tag: copying one is three retain/release
  // pairs, moving one is a 48-byte copy and three nulled sources. A document
  // serializer's per-key loop read each document value into a cell it never
  // read again, and paid the three pairs per key.
  if (carrier.kind === 'dynamic') return true
  if (carrier.kind === 'optional') return ownsItsStorage(carrier.payload)
  // A sum owns whatever its live arm owns. `gea::TaggedUnion` has a real move
  // constructor (`TaggedUnionOps::moveConstruct`), so a dying union hands its
  // string or reference over instead of `copyConstruct`ing it and then
  // destroying the original -- per value, per call, where a header-writing hot
  // path paid three heap copies of one string.
  if (carrier.kind === 'tagged-union') return carrier.arms.some((arm) => ownsItsStorage(arm.value))
  // Every counted handle, not only a class instance: a record, an Array, a
  // typed array or a dictionary is the same `gea::Ref` with the same
  // retain/release pair, and a promise or callable object owns one inside.
  if ('ownership' in carrier) return carrier.ownership === 'shared-refcount'
  // Every callable and constructor carrier is a `CallableObject`,
  // `ConstructorObject` or `CallableConstructorObject`: an environment and an
  // identity handle each. Only `function` was listed, so a function
  // declaration that needs its identity (`function-value-dispatch`, what
  // `emitter.off(handler)` makes of a hoisted handler) was copied into its
  // own cell -- two retain/release pairs per closure, per operation, for
  // every listener a hot path installs.
  if (isNativeCallableCarrier(carrier.kind)) return true
  return (
    carrier.kind === 'promise' ||
    carrier.kind === 'callable-identity' ||
    carrier.kind === 'constructor-family' ||
    carrier.kind === 'constructor-value-dispatch' ||
    carrier.kind === 'constructor-identity'
  )
}

/**
 * A DYING refcounted value moves into the slot that takes it rather than being
 * copied into it -- see `ir/transfer.ts`'s `buildDyingArgumentIndex` for what
 * makes a value dying, which is the whole of the safety argument.
 *
 * Two conditions here, both about the CARRIER rather than the value's life:
 * only a carrier that owns a count has anything to hand over, and the slot must
 * hold exactly what the value already holds. `gea::Ref` has no converting move
 * constructor, so an upcast to a base class binds `std::move(x)` right back to
 * the copying `Ref(const Ref<Other>&)` -- and any slot needing a real
 * conversion has already built a temporary of its own, which moving cannot
 * make cheaper.
 */
export const movedValueText = (ctx: EmitContext, value: IrOperand, held: Representation | null, text: string): string => {
  if (transferOf(ctx.dyingArguments, ctx.ownedValues, ctx.transferDyingValues, value.value, ctx.receiverRenames) !== 'move') return text
  // A value the emitter withheld renders as its own expression, not as a cell:
  // `f(std::move((a->elementAtIndex(i))))` moves a prvalue, which gcc rejects
  // as a pessimizing move under -Werror, and there is nothing to gain -- the
  // temporary already binds to the by-value slot without a copy.
  if (isDeferredValue(ctx, value.value)) return text
  const carrier = value.representation
  // A `string` owns a heap buffer the same way a counted reference owns a
  // count, and hands it over the same way. `JSON.stringify`'s result is the
  // case that made this visible: a 300 KB text was copied out of the value the
  // serializer had just built into the cell that names it, once per call.
  if (!ownsItsStorage(carrier)) return text
  // Two representations can spell one C++ type -- an identified callable and
  // the plain function slot it is stored into are both the same
  // `gea::CallableObject<...>` -- and moving between them is a move of one
  // type into itself. Only the value's own name moves that way; a text some
  // conversion produced is already a temporary.
  if (
    held !== null &&
    representationKey(held) !== representationKey(carrier) &&
    !(text === operandText(ctx, value) && samePhysicalCarrier(held, carrier))
  )
    return text
  // Two renderers on one argument's path each ask this (a sum-widenable
  // argument is moved into its widening and then into the slot): the second
  // wrap would spell `std::move(std::move(x))`, which is the same move.
  if (text.startsWith('std::move(') && text.endsWith(')')) return text
  return `std::move(${text})`
}

/**
 * The proven-partial-dead-arm sibling of `emit.ts`'s `emitConvert` -- see
 * `MergeLiveArmRebuildOperation`'s doc comment (`ir/model.ts`) for why a
 * general `convert` cannot express this.
 *
 * `operation.liveArms` is the proof: which of the source's (optional-
 * unwrapped) tagged-union arms are not proven dead at this merge, computed
 * once by the control-flow lowering that owns the guard and carried here
 * unchanged -- never recomputed. `ir/lower-narrow.ts` derives it from
 * `partialDeadMergeArms` for `&&`; `ir/lower-destructuring.ts` derives it from
 * the top-level arms surviving a default's `is-defined` guard. Only those
 * indices are tested, in source-arm order, on the source's own discriminant
 * (`.is<N>()`/`.get<N>()`, the
 * identical accessors this file already renders for a narrowed tagged
 * union above), and the chain falls through to the last live index without
 * testing it -- sound because reaching this expression at all already proves
 * the held arm is one of them. The source's own absence (if it is optional)
 * reads the result's own absent value instead of testing any arm at all.
 *
 * The finalized plan names the exact recipe for every live arm and absence.
 * A contextual truthiness arm additionally cites ToBoolean's runtime helper;
 * certification authenticates its && split before this renderer can use it.
 */
export const emitMergeLiveArmRebuild = (ctx: EmitContext, lines: string[], operation: MergeLiveArmRebuildOperation): void => {
  const sourceRepresentation = operation.source.representation
  const payload = sourceRepresentation.kind === 'optional' ? sourceRepresentation.payload : sourceRepresentation
  if (payload.kind !== 'tagged-union') {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(sourceRepresentation)}->tagged-union`,
      `rebuilds live arms of ${representationKey(sourceRepresentation)}, which is not a tagged union`
    )
  }
  const target = operation.result.representation
  const plan = operation.mergeConversionPlan
  if (!plan || plan.source !== representationKey(sourceRepresentation) || plan.target !== representationKey(target))
    throw createCppEmitBlockedError('runtime-helper:merge-live-arm-rebuild:conversion-plan', 'a merge has no matching certified arm plan')
  const sourceText = operandText(ctx, operation.source)
  const unwrapped = sourceRepresentation.kind === 'optional' ? `(*${sourceText})` : sourceText
  const armText = (index: number): string => {
    const arm = payload.arms[index]
    if (!arm) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(sourceRepresentation)}->arm-${index}`,
        `cites live arm ${index} of ${representationKey(sourceRepresentation)}, which has no such arm`
      )
    }
    const loaded = `${unwrapped}.get<${index}>()`
    const citation = plan.arms.find((entry) => entry.index === index)
    const node = citation ? ctx.conversions.nodeById(citation.conversion) : null
    const input = citation?.mode === 'truthiness' ? booleanTestText(loaded, arm.value) : loaded
    const converted = node ? namedConversionText(ctx, 'emit-narrowing.ts:merge-arm', node, input) : null
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${citation?.conversion ?? 'merge-arm'}`,
      'a sealed merge arm has no certified conversion spelling'
    )
  }
  const indices = operation.liveArms
  const last = indices[indices.length - 1]
  if (last === undefined) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(sourceRepresentation)}->no-live-arms`,
      `rebuilds ${representationKey(sourceRepresentation)} with no live arms recorded`
    )
  }
  let dispatch = armText(last)
  for (const index of indices.slice(0, -1).reverse()) {
    dispatch = `${unwrapped}.is<${index}>() ? ${armText(index)} : (${dispatch})`
  }
  if (indices.length > 1) dispatch = `(${dispatch})`
  const absenceText = (): string => {
    const citation = plan.absence
    if (citation === undefined || sourceRepresentation.kind !== 'optional')
      throw createCppEmitBlockedError('runtime-helper:merge-live-arm-rebuild:conversion-plan', 'a live merge absence names no recipe')
    const node = ctx.conversions.nodeById(citation)
    const text = node
      ? namedConversionText(
          ctx,
          'emit-narrowing.ts:merge-native-absence',
          node,
          cppConstantLiteral(sourceRepresentation.absence, sourceRepresentation.absence, { kind: sourceRepresentation.absence })
        )
      : null
    if (text !== null) return text
    throw createCppEmitBlockedError(`conversion:${citation}`, 'a sealed native merge absence has no conversion spelling')
  }
  const text =
    sourceRepresentation.kind === 'optional' && operation.sourceAbsenceLive
      ? `(${sourceText}.has_value() ? ${dispatch} : ${absenceText()})`
      : dispatch
  lines.push(`${defineValue(ctx, operation.result)} = ${text};`)
}
