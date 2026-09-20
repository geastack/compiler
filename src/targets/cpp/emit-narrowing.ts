import type { NativeSelectionHelper } from './native-selection-helpers.js'
import { classRefTransportKind, constructorUpcastMember } from './class-ref-transport.js'
import type { AbiParameter, CallableAbi, RecordField, Representation, TaggedUnionArm } from '../../representation/model.js'
import {
  abiKey,
  arrayExtensionKey,
  containsUnresolved,
  isBooleanShapedMergeTarget,
  isCanonicalNumberPropertyKeyText,
  representationKey,
  walkRepresentation,
  carriesUndefined
} from '../../representation/model.js'
import type { IrOperand, MergeLiveArmRebuildOperation } from '../../ir/model.js'
import { transferOf } from '../../ir/transfer.js'
import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { coercionText } from './emit-coercion.js'
import type { ConversionCensus } from '../../conversion/nodes.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { ClassLayout } from '../../projection/classes.js'
import type { CaptureIndex } from './emit-context.js'
import { structuralRecordViewText } from './emit-record-view.js'
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
  cppAbiType,
  cppClassName,
  cppConstantLiteral,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn,
  cppUndefinedValue
} from './types.js'
import { cppRegExpNativeTypes, cppStringObjectNativeType } from './regexp-types.js'
import { widenedNativeSumText } from './emit-sum-widening.js'
import { nativeSelectionText } from './emit-native-selection.js'
import { narrowingReachesTarget } from '../../conversion/build.js'

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
  // direction, while `void` against any richer payload stays a hole.
  // `@hono/node-server`'s `listener.ts` needs exactly this: `responseViaCache`
  // is declared `Promise<undefined | void>` and both callers `return` its
  // promise from an async function whose own result is `Promise<void>`.
  if (target.kind === 'void') return isUnitPromisePayload(source)
  if (source.kind === 'void') return source.bottom === true || isUnitPromisePayload(target)
  try {
    return convertedValueText(source, target, 'gea_promise_payload') !== null
  } catch (error) {
    if (isCppEmitBlockedError(error)) return false
    throw error
  }
}

/** A promise payload that carries no information: `void`, and the `undefined` it is spelled as wherever a value is required. */
const isUnitPromisePayload = (payload: Representation): boolean => payload.kind === 'void' || payload.kind === 'undefined'

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
const tryCandidateText = (build: () => string | null): string | null => {
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
  // A target may retain both an ancestor and one of its descendants (Three's
  // WebGLRenderTarget | WebGLCubeRenderTarget flow does). JS unions do not
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
const taggedUnionArmText = (union: Extract<Representation, { kind: 'tagged-union' }>, target: Representation, text: string): string => {
  const targetKey = representationKey(target)
  const exact = union.arms
    .map((arm, index) => ({ arm, index }))
    .filter((entry) => representationKey(entry.arm.value) === targetKey)
    .map((entry) => ({ index: entry.index, text: `${text}.get<${entry.index}>()` }))
  // An arm that CONVERTS to the target answers too. An exact arm is the
  // cheapest answer for its own discriminant, but its existence cannot erase
  // a different live arm which is structurally assignable to the same target.
  // Hono's RegExpRouter exposed this: a truthy value is either `string[]` or
  // `RegExpMatchArray`; both are `Array<string>`, yet preferring the exact arm
  // emitted an unconditional `get<0>()` and crashed on a match-result arm.
  //
  // Hono's `Hono.fetch` is another converting case: the cell is
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
  const partialWidening =
    target.kind === 'tagged-union' &&
    candidates.some((candidate) => !exact.includes(candidate)) &&
    union.arms.some((arm, index) => arm.value.kind === 'record' && !candidates.some((candidate) => candidate.index === index))
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
  // expression once per arm -- 928 inner spellings on one three.js line after
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
    cppTypeOf(held) === cppTypeOf(read)
  )
    return text
  const unwrapped = held.kind === 'optional' ? `(*${text})` : text
  const inner = held.kind === 'optional' ? held.payload : held
  if (representationKey(inner) === representationKey(read)) return unwrapped
  // The same array read as the interface that extends it (`elements` of
  // `readonly T[] | undefined`, proven present and then `isNodeArray`): one
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
  // `Tag::Number` over whatever the dereference found -- node-compat's
  // cluster 'exit' event reported `code=0 signal=` for a worker Node reports
  // as `code=null signal=SIGTERM`. Certified, compiled, wrong.
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
    inner.kind === 'class-ref' &&
    read.kind === 'class-ref' &&
    inner.ownership === read.ownership &&
    inner.ancestors.includes(read.declaration)
  ) {
    return `${cppTypeOf(read)}(${unwrapped})`
  }
  // A program-class handle read at a DERIVED class -- `part instanceof Mesh`
  // then `part.castShadow = true` on a `traverse` callback's `Object3D`.
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
    inner.kind === 'class-ref' &&
    read.kind === 'class-ref' &&
    inner.ownership === read.ownership &&
    read.ancestors.includes(inner.declaration)
  ) {
    return `gea::host::downcastClassRef<${cppClassName(read.declaration)}>(${unwrapped})`
  }
  // A cell that provably holds nothing but absence, read at a place declared
  // wider. hono's `#dispatch` binds `env: E['Bindings']` -- an indexed access
  // through a type parameter's constraint that this program never instantiates
  // -- so its cell is placed `undefined` while every read of it is the declared
  // optional. A read cannot be narrower than the cell here; it is a widening,
  // and the store direction already knows the answer is the empty optional.
  if ((inner.kind === 'undefined' || inner.kind === 'null') && read.kind === 'optional' && read.absence === inner.kind) {
    return widenedStoreText(read, inner, unwrapped)
  }
  if (inner.kind !== 'tagged-union') return null
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
      return `(${unwrapped}.is<${absentIndex}>() ? ${narrowed}() : ${narrowed}(${taggedUnionArmText(inner, read.payload, unwrapped)}))`
    }
    // No arm is the bare absent literal, because absence lives INSIDE another
    // arm's own optional. hono's `compose` binds `let handler` to a
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
    // width. hono's `#newResponse` is the case: the cell holds
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
 * `node-compat`'s `new Request(url, init)` is the case: `typeof init.body ===
 * 'string'` narrows `BodyInit | null | undefined` to `string`.
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
    // conversion. Hono's RegExpRouter reads an optional `Array<string>` from
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
    // in this list. Missing here meant an `ArrayBuffer` value -- hono's
    // `Context.body`'s own `Data` union carries one -- could never widen
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
      return 'Object'
    // A `gea::Promise<T>` is a JS Object too -- `typeof new Promise(...) ===
    // 'object'` -- and `Value::box` needs nothing case-specific to hold one:
    // the template already records `payloadTypeTagFor<gea::Promise<T>>()` for
    // whichever `T` this instantiation closes over, one program-wide address
    // per payload type, exactly as it does for every other kind sharing this
    // tag. Missing here meant a value returned from a plain (non-async)
    // function -- `#cachedBody`'s `return (bodyCache[k] as Promise<BodyInit>)
    // .then(...)` in hono's `request.ts`, whose OWN inferred return type is a
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
 * hono's `this[method] = (args1, ...args) => ...` is every `app.get(path,
 * handler)` in the program.
 */
export const boxedText = (representation: Representation, tag: string, text: string): string => {
  const restFrom = restFromOf(representation)
  const value = `static_cast<${cppTypeOf(representation)}>(${text})`
  const abi = representation.kind === 'function-and-constructor' ? representation.call : 'abi' in representation ? representation.abi : null
  if (abi?.receiver) return `gea::Value::boxMethod<${restFrom === null ? -1 : restFrom + 1}>(${value})`
  if (restFrom === null) return `gea::Value::box(gea::Value::Tag::${tag}, ${value})`
  return `gea::Value::boxCallable<${restFrom}>(${value})`
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
export const dynamicPromiseAdoptionText = (result: Extract<Representation, { kind: 'promise' }>, text: string): string | null =>
  widenedStoreText(result, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, text)

export const widenedStoreText = (held: Representation, written: Representation, text: string): string | null => {
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
  // promise -- hono's `formData()` returns its `any`-typed `#cachedBody(...)`
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
        // would read as a refusal. hono's `compose` carries its `handler` as
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
        // `BodyInit | null | undefined` (hono's `createResponseInstance`) has a
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
  // its RESULT -- `const slot: (n: number) => any = concrete`, and hono's
  // `#addRoute(handler: H)` one union layer up. Asked before the tagged-union
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
    // hono's `compose` disproves that: `let handler` is a `Function | (Next |
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
    // union. hono's `H = Handler | MiddlewareHandler` is the case -- a
    // middleware `(c, next) => Promise<void>` is assignable to one arm and the
    // exact-key search above cannot see it, because assignability here is not
    // carrier equality.
    //
    // Only these four, and only because each one renders as the value itself:
    // an arm chosen through a LOSSY widening would store something other than
    // what the program wrote, which is the same line the record recasts below
    // stay on.
    if (
      cppTypeOf(written) === cppTypeOf(arm.value) ||
      dropsUnboundParameters(written, arm.value) ||
      dropsAllParametersIntoResultArm(written, arm.value) ||
      widensResultIntoArm(written, arm.value) ||
      discardsResultIntoVoid(written, arm.value)
    ) {
      return `${cppTypeOf(held)}::ofArm<${armIndex}>(${text})`
    }
    if (
      written.kind === 'class-ref' &&
      arm.value.kind === 'class-ref' &&
      written.ownership === arm.value.ownership &&
      written.ancestors.includes(arm.value.declaration)
    ) {
      return `${cppTypeOf(held)}::ofArm<${armIndex}>(${cppTypeOf(arm.value)}(${text}))`
    }
    // The fifth pair is not an implicit constructor, so it wraps the text
    // rather than passing it through -- see `resultAdapterOf`. hono's `H =
    // Handler | MiddlewareHandler` reaches its arm exactly here: same frame,
    // a result the arm declares `any`.
    const adaptedArm = resultAdaptedCallableText(written, arm.value, text)
    if (adaptedArm !== null) return `${cppTypeOf(held)}::ofArm<${armIndex}>(${adaptedArm})`
    // A record recasts into a dictionary/array-object ARM the same way
    // `convertedValueText`'s own top level recasts it directly -- identity above never matches an object literal against either.
    // A dictionary reaches a WIDER dictionary arm the same way (`dictionaryCastableToDictionary`);
    // `conversions.ts` admits only a union with ONE such arm, so the first match is the match.
    const recast =
      written.kind === 'record'
        ? arm.value.kind === 'dictionary'
          ? recastedRecordToDictionaryText(written, arm.value, text)
          : arm.value.kind === 'array-object'
            ? recastedRecordToArrayText(written, arm.value, text)
            : arm.value.kind === 'record'
              ? recastedRecordText(written, arm.value, text)
              : null
        : written.kind === 'dictionary' && arm.value.kind === 'dictionary'
          ? recastedDictionaryText(written, arm.value, text)
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
 * tsc's `visitEachChild<T>` returns `fn === undefined ? node : fn(node, ...)`
 * where `fn` is a `VisitEachChildFunction<any>`: the conditional merges `T`
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
  // failure mode this compiler exists to remove: hono's `c.json()` passes
  // `ResponseOrInit<ContentfulStatusCode>` into `ResponseOrInit<StatusCode>`
  // -- two shape ids over identical field carriers -- and the arm had no home
  // here even though the conversion graph said it did.
  viaLayout?: (source: Representation, target: Representation, text: string) => string | null
): string | null => {
  // A union with N arms otherwise interpolates BOTH the full target spelling
  // and the source expression at every arm -- and a nested inner-union arm
  // repeats that again inside every outer arm. The three.js app's `NativeUniformValue
  // | null | undefined` is a 3-arm outer union over a 32-arm inner one, and
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
      // `convertedValueText` and not `widenedStoreText` alone: an arm can
      // reach its home by a recast rather than a widening -- two records that
      // declare the same fields under two interned shapes, which is what
      // hono's `Result<T>` is made of -- and only the superset tries all of
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
 * type is legal TypeScript and lowers to exactly this pair, and mongodb's
 * driver is built out of it: every `CommandOptions` producer hands a record
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
 * hono's pattern router hands `[Pattern, string, [Handler, ParamIndexMap]]` to
 * a `Route<T>` slot whose innermost tuple interned under a second shape id with
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
  // for one field on TypeScript's own compiler.
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
  // shape id and never looks inside it: TypeScript's own compiler put an
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
    // tsc's `return evaluatorResult(0)` -- the copy `EvaluatorResult<number>`
    // with `value: number`, returned where `EvaluatorResult` (default `T`,
    // `value: string | number | undefined`) is declared -- had the renderer
    // but not the admission: 19 rows across `checker.ts` and `utilities.ts`.
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
  if (from.kind === 'function-value-dispatch' && to.kind === 'function-value-dispatch') return resultAdapterOf(from, to) !== null
  // Containers copy element by element (`array-copy-recast`,
  // `dictionary-to-dictionary`), so a field holding one recasts when its
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
 * has (`conversion/build.ts`), and TypeScript's own compiler has enough of
 * them, with enough fields each, that a key string, a fresh set and a linear
 * field scan per target field, per pair, WAS the representations stage (the
 * main thread sat at 100% for an hour past the previous run's total). Fields
 * are matched through a per-record index, and a top-level answer is
 * remembered per pair, which `recastedRecordText` reads back for the pairs
 * the graph kept.
 */
const recordsRecastableIn = (source: Representation, target: Representation, seen: Set<string> | null): boolean => {
  if (source.kind !== 'record' || target.kind !== 'record') return false
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
  if (source.kind === 'array-object' && target.kind === 'array-object') return recastFieldCrossesDynamic(source.element, target.element, seen)
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
    const read = `${holder}${arrow}${cppRecordFieldName(field.key)}`
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
  const presences = target.fields.flatMap((field) => {
    if (field.required) return []
    const match = source.fields.find((candidate) => candidate.key === field.key)
    if (match === undefined) return ['false']
    return [match.required ? 'true' : `${holder}${arrow}${cppRecordFieldPresenceName(field.key)}`]
  })
  const structure = `${cppRecordStructName(target.shapeId)}{${[...reads, ...presences].join(', ')}}`
  const built = target.ownership === 'shared-refcount' ? `gea::makeRef<${cppRecordStructName(target.shapeId)}>(${structure})` : structure
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
  text: string
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
    return `gea_dict${dictArrow}operator[](${key}) = ${converted};`
  })
  if (inserts.some((insert) => insert === null)) return null
  const statements = (inserts as string[]).join(' ')
  const construct = target.ownership === 'shared-refcount' ? `auto gea_dict = gea::makeRef<${storage}>();` : `${storage} gea_dict{};`
  return `[](const ${cppTypeOf(source)}& gea_from) { ${construct} ${statements} return gea_dict; }(${text})`
}

/**
 * An open dictionary recast into another open dictionary over the same key
 * domain whose VALUES it widens into -- `Record<string, string>` reaching a
 * slot declared `OutgoingHttpHeaders` (`{ [name: string]: string | number |
 * boolean | readonly string[] | undefined }`). TypeScript's `||` typing
 * subtype-reduces the two into the wider one, so `@hono/node-server`'s `get
 * headers()` -- `cache[2] || { 'content-type': defaultContentType }` where
 * the slot is `Record<string, string> | [string, string][] |
 * OutgoingHttpHeaders | undefined` -- publishes ONLY the wider dictionary as
 * the merge's arm, and both the literal and the slot's own string-dictionary
 * arm have to reach it. Nothing between the two carriers is a view: a
 * `gea::Dictionary<std::string>` and a `gea::Dictionary<gea::Optional<...>>`
 * are two template instantiations.
 *
 * One level out from `recordCastableToDictionary` above and admitted on the
 * same terms: every value the source holds converts into the target's value
 * carrier by the store it would have performed had the entry been written
 * against the wider index signature in the first place, and the rebuild is a
 * fresh table -- the same fresh table the record pour builds, with the same
 * consequence, that a program which keeps writing the SOURCE afterwards and
 * reads the widened copy does not see the write. The record pour already
 * stands on that ground for the identical pair one shape narrower; this does
 * not extend it further.
 *
 * String keys only. `gea::NumericDictionary` and `gea::SymbolDictionary` are
 * different containers with their own iteration, and nothing has asked for
 * them; a pair over either refuses by name rather than guessing a spelling.
 */
export const dictionaryCastableToDictionary = (
  source: Extract<Representation, { kind: 'dictionary' }>,
  target: Extract<Representation, { kind: 'dictionary' }>
): boolean => {
  if (source.key !== 'string' || target.key !== 'string') return false
  if (representationKey(source.value) === representationKey(target.value)) return false
  if (containsUnresolved(source) || containsUnresolved(target)) return false
  try {
    return convertedValueText(source.value, target.value, 'gea_entry_value') !== null
  } catch (error) {
    // Queried while the conversion graph is being built, exactly as
    // `recordCastableToDictionary` is: a nested recipe's named refusal means
    // the value pair does not convert, not that graph construction failed.
    if (isCppEmitBlockedError(error)) return false
    throw error
  }
}

const recastedDictionaryText = (
  source: Extract<Representation, { kind: 'dictionary' }>,
  target: Extract<Representation, { kind: 'dictionary' }>,
  text: string
): string | null => {
  if (!dictionaryCastableToDictionary(source, target)) return null
  const converted = convertedValueText(source.value, target.value, 'gea_entry.second')
  if (converted === null) return null
  const storage = `gea::Dictionary<${cppTypeOf(target.value)}>`
  const construct = target.ownership === 'shared-refcount' ? `auto gea_dict = gea::makeRef<${storage}>();` : `${storage} gea_dict{};`
  const dictArrow = target.ownership === 'shared-refcount' ? '->' : '.'
  // `gea::Dictionary`'s own `const_iterator` walks entries in creation order,
  // which is the order the language enumerates them in and the order the copy
  // must therefore insert them in.
  const range = source.ownership === 'shared-refcount' ? '*gea_from' : 'gea_from'
  return (
    `[](const ${cppTypeOf(source)}& gea_from) { ${construct} ` +
    `for (const auto& gea_entry : ${range}) { gea_dict${dictArrow}operator[](gea_entry.first) = ${converted}; } ` +
    `return gea_dict; }(${text})`
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
 * `@hono/node-server`'s `RequestHeaders.forEach` is the measured case: it
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
  if (cppTypeOf(field.value) === cppTypeOf(parameter.value)) return access
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
    `? ${elementType}() : ${rest}->at(${position}))`
  if (elementType === cppTypeOf(parameter.value)) return access
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
  const boxed = dynamicCarrierBoxText(source, text)
  if (boxed === null) return null
  return tryCandidateText(() => convertedValueText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target, boxed))
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
 * hono's `H = Handler | MiddlewareHandler` is the case that needs it:
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
  target: Representation
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
  if (from.receiver !== null && to.receiver === null) return null
  const ignoresReceiver = from.receiver === null && to.receiver !== null
  // A fixed-arity source filling a slot whose trailing frame is ONE rest array:
  // `(...args: any[]) => void`, JavaScript's "some function, arguments not my
  // business" idiom. tsc's whole `Debug` family passes itself through it --
  // `assertIsDefined(value, message, stackCrawlMark || checkDefined)` -- and
  // every such argument refused to lower, 265 rows in `debug.ts` alone, because
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
  // omits a trailing argument) answers. hono's `utils/url.ts` is the measured
  // case: `export const getQueryParam: (url, key?) => ... = _getQueryParam as
  // (...)`, where `_getQueryParam` declares a third `multiple?: boolean`; the
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
    if (cppTypeOf(from.receiver) === cppTypeOf(to.receiver)) {
      receiverActual = adapterReceiverName
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
    try {
      const converted = convertedValueText(slot.value, parameter.value, formal)
      if (converted === null) return null
      actuals.push(converted)
    } catch (error) {
      if (isCppEmitBlockedError(error)) return null
      throw error
    }
  }

  let convertedResult: string | null
  if (to.result.kind === 'void') {
    convertedResult = null
  } else if (from.result.kind === 'void') {
    if (to.result.kind !== 'dynamic') return null
    convertedResult = `${cppTypeOf(to.result)}()`
  } else if (cppTypeOf(from.result) === cppTypeOf(to.result)) {
    convertedResult = adapterResultName
  } else {
    try {
      convertedResult = convertedValueText(from.result, to.result, adapterResultName)
    } catch (error) {
      if (isCppEmitBlockedError(error)) return null
      throw error
    }
    if (convertedResult === null) return null
  }

  const receiverChanges = receiverActual !== null && receiverActual !== adapterReceiverName
  const nativeReceiverTransport =
    from.receiver !== null && to.receiver !== null && classRefTransportKind(to.receiver, from.receiver) !== null
  const ignoresParameters = from.parameters.length < to.parameters.length
  const parametersChange = actuals.some((actual, ordinal) => actual !== adapterFormalName(ordinal))
  const resultChanges =
    from.result.kind !== to.result.kind || (from.result.kind !== 'void' && cppTypeOf(from.result) !== cppTypeOf(to.result))
  const nativeFieldProtocolUnused =
    !restSpread &&
    !restPack &&
    (!receiverChanges || nativeReceiverTransport) &&
    !parametersChange &&
    (from.result.kind === 'void' || to.result.kind === 'void' || cppTypeOf(from.result) === cppTypeOf(to.result))
  return ignoresReceiver || ignoresParameters || receiverChanges || parametersChange || resultChanges
    ? { from, to, receiverActual, actuals, convertedResult, nativeFieldProtocolUnused }
    : null
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
export const resultAdaptedCallableText = (source: Representation, target: Representation, text: string): string | null => {
  const adapter = resultAdapterOf(source, target)
  if (adapter === null) return null
  const sourceType = cppTypeOf(source)
  const formals = [
    `void* ${adapterEnvironmentName}`,
    ...(adapter.to.receiver === null ? [] : [`${cppTypeOf(adapter.to.receiver)} ${adapterReceiverName}`]),
    ...adapter.to.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${adapterFormalName(ordinal)}`)
  ]
  const sourceActuals = [...(adapter.receiverActual === null ? [] : [adapter.receiverActual]), ...adapter.actuals]
  const call = `static_cast<${sourceType}*>(${adapterEnvironmentName})->call(${sourceActuals.join(', ')})`
  const body =
    adapter.from.result.kind === 'void'
      ? `${call};${adapter.convertedResult === null ? '' : ` return ${adapter.convertedResult};`}`
      : adapter.to.result.kind === 'void'
        ? `${call};`
        : `${cppTypeOf(adapter.from.result)} ${adapterResultName} = ${call}; return ${adapter.convertedResult};`
  return `${cppTypeOf(target)}::adaptSource(${sourceType}{${text}}, [](${formals.join(', ')}) -> ${cppResultTypeOf(adapter.to.result)} { ${body} })`
}

/**
 * A callable filling a slot that declares MORE parameters than it does, the
 * extra ones landing after every one the source itself names./**
 * A callable filling a slot that declares MORE parameters than it does, the
 * extra ones landing after every one the source itself names.
 *
 * ECMA-262 does not bind the extra arguments, so `() => void` really is a
 * `(time: number) => void` and TypeScript accepts it everywhere, and the same
 * is true one prefix over: hono's `Hono.getPath` merges two
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
/**
 * A method value -- its receiver first in its physical convention -- filling
 * a slot that declares the same convention WITHOUT one: `gea_runtime.h`'s
 * `CallableObject::bindReceiver`, which packs the receiver the property read
 * went through in with the value. Everything but the receiver has to agree
 * exactly, in the C++ spelling the runtime's own signature matching sees
 * (`cppAbiType`, the one authority on that spelling), so the adapter's
 * `Result(Receiver, Arguments...)` is the source's own type and nothing is
 * coerced on the way through.
 *
 * Only the SHAPE is decided here; whether the pair can actually be rendered
 * -- the read's receiver has to be recoverable at the site, and the body must
 * never read `this` -- is `emit-callable.ts`'s `receiverBoundCallableText`'s
 * question, a fact of the emitter's context and not of the two carriers.
 */
/**
 * A `this`-TYPED function value, stored in a field and read through the object
 * whose `this` it names: `gea_runtime.h`'s `CallableObject::bindReceiver`
 * again, but reached from a fact about the two DECLARATIONS rather than from a
 * method body.
 *
 * hono's `RegExpRouter` writes `match: typeof match<Router<T>, T> = match`
 * over `function match<R extends Router<T>, T>(this: R, method, path)`, while
 * `TrieRouter` and `SmartRouter` declare `match` as an ordinary method -- and
 * `Router<T>` itself declares it as a method, with no `this` at all. So the
 * field's carrier names a receiver and every read through the interface (or
 * through the union of the three implementors) publishes one that does not,
 * and nothing converted between them.
 *
 * Binding the read's own receiver is the only call the language admits here,
 * which is what makes this sound where the detached-METHOD case next door
 * needs `readsReceiver` to hold: a `this` parameter is a parameter, and
 * TypeScript refuses a call through the value that does not supply one
 * (`The 'this' context of type 'void' is not assignable...`). A method has no
 * such annotation, so a detached call really can reach it with `this`
 * undefined, and binding there would answer where the program would have
 * thrown.
 */
export const receiverBoundFieldText = (
  ctx: ConversionSite,
  stored: Representation,
  published: Representation,
  storedText: string,
  receiver: Representation,
  receiverText: string
): string | null => {
  if (!bindsReceiver(stored, published)) return null
  const abi = callableObjectAbi(stored)
  if (abi === null || abi.receiver === null) return null
  const bound = alignedValueText(ctx, 'emit-narrowing.ts:receiver-bound-field', receiver, abi.receiver, receiverText)
  if (bound === null) return null
  return `${cppTypeOf(published)}::bindReceiver(${storedText}, ${bound})`
}

export const bindsReceiver = (source: Representation, target: Representation): boolean => {
  const from = callableObjectAbi(source)
  const to = callableObjectAbi(target)
  if (!from || !to || from.receiver === null || to.receiver !== null) return false
  return cppAbiType({ ...from, receiver: null }) === cppAbiType(to)
}

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
 * hono's `Context.notFound`: `this.#notFoundHandler ??=
 * () => createResponseInstance()` merges a `() => Response` into a field
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
 * idiom (`apps/hono-hello/server.ts` is one), and TypeScript accepts a
 * `Promise<void>`-returning callback there for the identical reason -- a
 * `void`-returning function TYPE is satisfied by ANY return type, precisely
 * so a caller who ignores the result is never forced to wrap it.
 *
 * `gea_runtime.h`'s `CallableObject` composed converting constructor this
 * asks for discards whatever the source returns; see that constructor's own
 * comment for why doing so is never lossy for an async body specifically --
 * this runtime's `Promise<V>` is a settled-value box, never a coroutine
 * frame, so by the time a call returns here its entire body, `await`s
 * included, has already run to completion.
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
 * arity satisfies neither -- hono's `Hono.fetch` is one, a `(Context) =>
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
  if (from.restFrom !== to.restFrom || to.result.kind !== 'tagged-union') return false
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
 * same function -- hono's `utils/url.ts` declares exactly that pair on one
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
  if (arm.runtimeDiscriminator.kind === 'carrier') {
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

export const unboxedLoadText = (target: Representation, text: string): string | null => {
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
          : `gea::detail::DynamicCarrier<${type}>::inWithReceiver(${value}, 0)`
        : callableAbi.receiver === null
          ? `gea::detail::DynamicCarrier<${type}>::template inWithRest<${restFrom}>(${value}, 0)`
          : `gea::detail::DynamicCarrier<${type}>::template inWithReceiverAndRest<${restFrom + 1}>(${value}, 0)`
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
    const condition = (index: number): string => sets[index]!.map((entry) => test(entry)).join(' || ')
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
  // assertion names a typed Array. BSON deserialization is the concrete case:
  // it builds `Array<Value>` because each element is decided by the wire type,
  // then its public result is asserted as `string[]`, `Document[]`, and so on.
  // The runtime bridge preserves an exact typed payload by identity and
  // otherwise rebuilds it element by element through `DynamicCarrier`, so the
  // result is a native `ArrayObject<Element>` and a bad element refuses rather
  // than being reinterpreted or leaving the whole Array boxed.
  if (target.kind === 'array-object') {
    return `gea::detail::unboxDynamicArray<${cppTypeOf(target.element)}>(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  if (target.kind === 'dictionary' && target.key === 'string' && target.ownership === 'shared-refcount') {
    return `gea::detail::unboxDynamicDictionary<${cppTypeOf(target.value)}>(${text}, ${cppStringLiteral(assertionSite(target))})`
  }
  // An open document deserializer cannot know the concrete interface a later
  // assertion will name, so it stores a native `Dictionary<Value>`. Requiring
  // that payload to already be the target record's C++ struct rejects valid
  // BSON/JSON document assertions. Rebuild the declared record from checked
  // dynamic field reads instead. The exact-payload branch preserves identity
  // when the box already carries this record; the fallback evaluates the
  // source once and leaves extra dictionary keys outside the statically
  // declared result, matching the assertion's structural view.
  if (target.kind === 'record' && target.accessors.length === 0) {
    if (target.ownership === 'borrowed') return null
    const targetType = cppTypeOf(target)
    const holder = 'gea_dynamic_record'
    const fields = target.fields.map((field, index) => {
      const present = `gea_dynamic_record_present_${index}`
      const value = `gea_dynamic_record_value_${index}`
      const load = field.value.kind === 'dynamic' ? value : unboxedLoadText(field.value, value)
      return { field, present, value, load }
    })
    if (fields.some((field) => field.load === null)) return null
    const checks = fields
      .filter(({ field }) => field.required)
      .map(
        ({ field, present }) => `if (!${present}) gea::detail::refusePayloadMismatch("a dynamic record lacks required field ${field.key}");`
      )
    const values = fields.map(
      ({ field, present, value }) =>
        `const gea::Value ${value} = ${present} ? gea::detail::dynamicRecordField(${holder}, ${cppStringLiteral(field.key)}) : gea::Value();`
    )
    const reads = fields.map(({ field, present, load }) => {
      const materialized = load!
      return field.required ? materialized : `(${present} ? ${materialized} : ${cppTypeOf(field.value)}{})`
    })
    const presences = fields.filter(({ field }) => !field.required).map(({ present }) => present)
    const structure = `${cppRecordStructName(target.shapeId)}{${[...reads, ...presences].join(', ')}}`
    const built = target.ownership === 'shared-refcount' ? `gea::makeRef<${cppRecordStructName(target.shapeId)}>(${structure})` : structure
    const exactPayload =
      target.ownership === 'shared-refcount'
        ? `if (${holder}.tag() == gea::Value::Tag::Object && ${holder}.payloadType() == gea::detail::payloadTypeTagFor<${targetType}>()) ` +
          `return gea::detail::unboxValue<${targetType}>(${holder}, gea::Value::Tag::Object, ${cppStringLiteral(assertionSite(target))}); `
        : ''
    return (
      `[](const gea::Value& ${holder}) -> ${targetType} { ` +
      exactPayload +
      `if (${holder}.tag() != gea::Value::Tag::Object && ${holder}.tag() != gea::Value::Tag::Function) ` +
      `gea::detail::refusePayloadMismatch("an assertion to a record requires an object"); ` +
      `${fields.map(({ field, present }) => `const bool ${present} = gea::detail::dynamicRecordHasField(${holder}, ${cppStringLiteral(field.key)});`).join(' ')} ` +
      `${checks.join(' ')} ${values.join(' ')} return ${built}; }(${text})`
    )
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
  // `gea::detail::unboxValue` checks BOTH the tag and the payload's recorded
  // C++ type (`payloadTypeTagFor`), so a box holding a different struct than
  // the narrowing claimed refuses by name instead of reinterpreting bytes.
  // That is what makes reading an object out of a box safe here at all: the
  // tag alone says only "some object".
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
export const conversionChain: readonly ConversionStep[] = [
  { id: 'native-sum-widening', apply: (source, target, text) => claimed(widenedNativeSumText(source, target, text)) },
  // A choice among generic functions widening into a superset: the index is
  // remapped, member by member. Before the identical-spelling identity below,
  // which would pass the SOURCE's index through unchanged -- both sets are one
  // `std::uint8_t`, and `0` means a different member in each.
  { id: 'generic-set-remap', apply: (source, target, text) => claimed(genericFunctionSetWideningText(source, target, text)) },
  // Two carriers this backend spells identically convert by identity. The
  // representation tells them apart for reasons the C++ type does not carry --
  // `constructor-family` names the class its `new` reaches and
  // `constructor-value-dispatch` does not -- but both are one
  // `gea::ConstructorObject<...>`, and a value of one already IS a value of the
  // other. Checking the spelling rather than enumerating the pairs is what keeps
  // this from becoming a second table that could disagree with `cppTypeOf`.
  { id: 'same-cpp-type', apply: (source, target, text) => (cppTypeOf(source) === cppTypeOf(target) ? text : undefined) },
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
      if (source.abi.restFrom !== target.abi.restFrom || source.abi.parameters.length !== target.abi.parameters.length) return undefined
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
      source.kind === 'record' && source.fields.length === 0 && source.accessors.length === 0 && target.kind === 'native-record-ref'
        ? target.ownership === 'shared-refcount'
          ? `gea::makeRef<${target.native ?? cppTypeOf(target, 'owned')}>()`
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
  // deeper (hono's `c.json` answered `HTTP/1.1 0 unknown` through it).
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
  {
    id: 'record-to-dictionary',
    apply: (source, target, text) =>
      source.kind === 'record' && target.kind === 'dictionary' ? claimed(recastedRecordToDictionaryText(source, target, text)) : undefined
  },
  // One shape wider: an open dictionary's values widened into another's
  // (`dictionaryCastableToDictionary`).
  {
    id: 'dictionary-to-dictionary',
    apply: (source, target, text) =>
      source.kind === 'dictionary' && target.kind === 'dictionary' ? claimed(recastedDictionaryText(source, target, text)) : undefined
  },
  // An Array of one element carrier copied into an Array of another, each
  // element through its own conversion. A copy, so only for an array that is
  // not written through both names afterwards: a matcher table built once
  // (hono's `[handlers.map(...), emptyParam]` literal) or a shared empty one.
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
      // (`test/runtime/array-object-call-argument-aliasing.ts`, and the
      // three.js `getProgramCacheKey` glyph miscompile its `.runtime.js`
      // sibling reproduces). Both polarities were live miscompiles that the
      // refusal fixed on 2026-09-12; re-admitting them here silently undid
      // that fix. The record- and union-element copies this recipe was added
      // for (hono's matcher tables, built from literals) do not cross it --
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
        const converted = tryCandidateText(() => convertedValueText(source.element, field.value, `gea_from->at(${index})`))
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
  {
    id: 'record-to-array',
    apply: (source, target, text) =>
      source.kind === 'record' && target.kind === 'array-object' ? claimed(recastedRecordToArrayText(source, target, text)) : undefined
  },
  // TWO PROMISES WHOSE PAYLOADS DIFFER. `widenedStoreText` reads a `promise`
  // target as "widen the written VALUE into a promise of it", correct for the
  // `return` terminator and wrong here, where the source is already a promise.
  // All three `[[PromiseState]]` values are carried: a rejection moves the
  // `exception_ptr` (the thrown carrier is the same on both sides), an unsettled
  // promise stays unsettled, and a `Promise<void>` on either side has no
  // `value()`, which is why a void payload against a richer one refuses.
  //
  // `Promise<void>` against `Promise<undefined>` is the exception, and not a
  // hole being papered over: the two are one run-time promise wearing two
  // TypeScript types (ECMA-262 27.2.1.4 fulfils a promise resolved with
  // nothing with `undefined`, which `cppResultTypeOf` elides for `void`), so
  // the state crosses and the unit value is supplied or dropped. That recipe
  // links through `observe` rather than snapshotting a settled state, because
  // its source is routinely still PENDING -- `@hono/node-server`'s
  // `responseViaCache` awaits inside -- and a snapshot of a pending promise is
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
        if (!isUnitPromisePayload(source.value) || !isUnitPromisePayload(target.value)) return undefined
        return (
          `([&]() -> ${cppTypeOf(target)} { const auto& ${promiseSourceName} = ${text}; ` +
          `if (${promiseSourceName}.rejected()) return ${cppTypeOf(target)}::rejected_with(${promiseSourceName}.rejection()); ` +
          `${cppTypeOf(target)} ${promiseTargetName}; ` +
          `${promiseSourceName}.observe([${promiseTargetName}](auto&&...) mutable ` +
          `{ ${promiseTargetName}.resolve(${target.value.kind === 'void' ? '' : cppUndefinedValue}); }, ` +
          `[${promiseTargetName}](const std::exception_ptr& ${promiseRejectionName}) mutable ` +
          `{ ${promiseTargetName}.reject(${promiseRejectionName}); }); ` +
          `return ${promiseTargetName}; }())`
        )
      }
      if (source.value.kind === 'void') {
        if (source.value.bottom !== true) return undefined
        return (
          `([&]() -> ${cppTypeOf(target)} { const auto& ${promiseSourceName} = ${text}; ` +
          `if (${promiseSourceName}.rejected()) return ${cppTypeOf(target)}::rejected_with(${promiseSourceName}.rejection()); ` +
          `${cppTypeOf(target)} ${promiseTargetName}; ` +
          `${promiseSourceName}.observe([]() {}, [${promiseTargetName}](const std::exception_ptr& ${promiseRejectionName}) mutable ` +
          `{ ${promiseTargetName}.reject(${promiseRejectionName}); }); ` +
          `return ${promiseTargetName}; }())`
        )
      }
      const settledPayload = convertedValueText(source.value, target.value, `${promiseSourceName}.value()`)
      if (settledPayload === null) return undefined
      const pendingPayload = convertedValueText(source.value, target.value, promiseValueName)
      if (pendingPayload === null) return undefined
      // A source still PENDING links through `observe`, exactly as the unit
      // recipe above does and for the same reason: hono's `#cachedBody` is one
      // callable returning `Promise<string | ArrayBuffer | Blob | ...>` that
      // every reader (`text()`, `json()`, `formData()`) adapts to its own
      // `Promise<T>` at the call, and the promise it hands back is the body
      // read that has not arrived yet. Snapshotting it (`if (!settled()) return
      // Target()`) minted a target nothing ever settled -- every `await
      // c.req.json()` hung and the POST never answered. The conversion runs
      // when the value exists; a conversion that throws (a dynamic arm not of
      // the declared type) becomes the target's rejection, which is what the
      // same failure inside a `then` handler is.
      return (
        `([&]() -> ${cppTypeOf(target)} { const auto& ${promiseSourceName} = ${text}; ` +
        `if (${promiseSourceName}.rejected()) return ${cppTypeOf(target)}::rejected_with(${promiseSourceName}.rejection()); ` +
        `if (${promiseSourceName}.settled()) return ${cppTypeOf(target)}(${settledPayload}); ` +
        `${cppTypeOf(target)} ${promiseTargetName}; ` +
        `${promiseSourceName}.observe([${promiseTargetName}](const ${cppTypeOf(source.value)}& ${promiseValueName}) mutable ` +
        `{ try { ${promiseTargetName}.resolve(${pendingPayload}); } catch (...) { ${promiseTargetName}.reject(std::current_exception()); } }, ` +
        `[${promiseTargetName}](const std::exception_ptr& ${promiseRejectionName}) mutable ` +
        `{ ${promiseTargetName}.reject(${promiseRejectionName}); }); ` +
        `return ${promiseTargetName}; }())`
      )
    }
  },
  // A TypeScript boundary does not call an ECMAScript abstract operation. A
  // dynamic source enters every typed carrier through its exact checked load;
  // String/Number, arithmetic, templates and property keys render their own
  // coercions at their semantic sites.
  { id: 'dynamic-unbox', apply: (source, target, text) => (source.kind === 'dynamic' ? unboxedLoadText(target, text) : undefined) },
  // A String OBJECT reconciled against the `string` primitive its alias widens
  // to (hono's `HtmlEscapedString`). Before the two general paths for the same
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
      const holdsAbsence = (carrier: Representation): boolean =>
        carrier.kind === 'optional' ||
        carrier.kind === 'tagged-union' ||
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
   * `refused`: the census has no recipe for the pair and the chain rendered
   * it (or refused it too). `converted`: the census answered and the printer
   * rendered its node -- a site that still converts at all, which after
   * Phase 1.3 is a decision lowering should have made; the by-category
   * deletion of chain callers (1.4) works this list down.
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
 * A pair the census has no recipe for is recorded as printer drift with the
 * census's reason and STILL handed to the chain, because the chain renders
 * some pairs the census does not yet own (a `dynamic` source the eager
 * derivation refused, a callable adapter) and refusing them here would
 * uncertify programs that run. The drift rows are the list of pairs the
 * census still has to learn; a row whose chain rendering is also `null` is
 * the refusal the site reports.
 */
/**
 * What a conversion site needs from its context: the census, the drift list
 * it reports to, and what the record view renders from. A body's
 * `EmitContext` is one; the program-level renderers with no body (construct
 * thunks, field initializers, virtual dispatch adapters in
 * `translation-unit.ts`) build one over the same census.
 */
export interface ConversionSite {
  readonly conversions: ConversionCensus
  readonly nativeSelectionHelpers?: ReadonlyMap<string, NativeSelectionHelper>
  readonly printerDrift: PrinterDrift[]
  readonly owner: string
  readonly layouts: RecordLayoutPolicy
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly captures: CaptureIndex
  /** The dispatch members this unit emitted; absent where a site has none to name. */
  readonly virtualDispatch?: ReadonlyMap<string, CallableAbi>
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
  return refused ? convertedValueText(source, target, text) : recipeText(ctx, node, text)
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
export const recipeText = (ctx: ConversionSite, node: ConversionNode, text: string): string | null => {
  if (node.capability.kind === 'identity') return text
  if (node.capability.kind === 'never') return null
  if (node.capability.kind === 'coercion') return coercionText(node.capability.operation, text, node.source, ctx.layouts)
  if (node.capability.kind === 'class-family') return classFamilyLoadText(ctx, node.source, node.target, text)
  // `conversions.ts`'s read of a structural value as a class nothing instantiates.
  if (node.capability.kind === 'atom' && node.capability.materializer.id === 'gea::host::unreachableValue')
    return `((void)(${text}), gea::host::unreachableValue<${cppTypeOf(node.target)}>())`
  // `conversions.ts`'s read of a class instance's structural view as the class: the boxed origin, narrowed.
  if (node.capability.kind === 'atom' && node.capability.materializer.id === 'gea::record::viewOrigin')
    return narrowedLoadText(
      { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
      node.target,
      node.source.kind === 'optional'
        ? `((${text}).has_value() ? gea::record::viewOrigin(*(${text})) : gea::Value())`
        : `gea::record::viewOrigin(${text})`
    )
  if ((node.capability.kind === 'atom' || node.capability.kind === 'static') && node.capability.materializer.nativeSelection) {
    const helper = ctx.nativeSelectionHelpers?.get(node.id)
    return helper
      ? `${helper.name}(${text})`
      : nativeSelectionText(node.capability.materializer.nativeSelection, node.source, node.target, text)
  }
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
  return runConversionChain(source, target, text).text
}

/**
 * Which chain step answers a pair, decided by running the chain on a
 * placeholder: the steps decide from the two carriers alone and only thread
 * the text through, so the answer is the one `convertedValueText` gives. A
 * step that claims the pair but cannot render it is reported with
 * `renders: false`; a pair no step claims is `null`.
 */
/**
 * Whether this backend can spell a carrier at all. Asked about every pair the
 * registry is probed with -- spelling the same target ten thousand times,
 * catching a throw each time it cannot be, was a measurable share of that
 * loop -- so remembered by identity, as `representationKey`'s own memo is.
 * The mapping's throw is still the answer; `manifest.ts`'s `isSpellable`
 * reads it the same way.
 */
const spellability = new WeakMap<Representation, boolean>()

export const isSpellable = (representation: Representation): boolean => {
  const known = spellability.get(representation)
  if (known !== undefined) return known
  let spellable: boolean
  try {
    cppTypeOf(representation)
    spellable = true
  } catch {
    spellable = false
  }
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

export const conversionRecipeOf = (
  source: Representation,
  target: Representation
): { readonly id: string; readonly renders: boolean } | null => {
  if (representationKey(source) === representationKey(target)) return { id: 'identity', renders: true }
  if (target.kind === 'void') return { id: 'discard-into-void', renders: true }
  if (source.kind === 'void' || containsUnresolved(source) || containsUnresolved(target)) return null
  const probed = tryCandidateText(() => {
    const outcome = runConversionChain(source, target, 'gea_conversion_probe')
    return outcome.step === null ? null : `${outcome.step.id}\u0000${outcome.text === null ? '' : 'renders'}`
  })
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
 * moves the `Ref`. `binary_trees` is the case: `sum(node.left)` reads a
 * `TreeNode | null` field into a temporary and passes it by value, which is an
 * increment on the way in and a decrement, a branch and an out-of-line
 * destructor on the way out, twice for every one of a million nodes. The
 * hand-written baseline it is measured against passes a raw pointer.
 */
const ownsItsStorage = (carrier: Representation): boolean => {
  if (carrier.kind === 'string') return true
  if (carrier.kind === 'class-ref') return carrier.ownership === 'shared-refcount'
  if (carrier.kind === 'optional') return ownsItsStorage(carrier.payload)
  return false
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
  if (transferOf(ctx.dyingArguments, ctx.ownedValues, ctx.ownedDyingValues, value.value) !== 'move') return text
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
  if (held !== null && representationKey(held) !== representationKey(carrier)) return text
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
 * Each live arm converts into the result's carrier through `convertedValueText`
 * (below) FIRST, unmodified, and only when that finds no installed load AND
 * the result is boolean-shaped (`isBooleanShapedMergeTarget`) does it fall
 * back to `ToBoolean` (`emit-presence.ts`'s `booleanTestText`) instead. That
 * fallback is not a general "any carrier converts to boolean" capability -- it
 * is not added to `convertedValueText`'s own representation-keyed dispatch,
 * which would let it fire for any unrelated occurrence of the same
 * representation pair. It fires only here, for an arm THIS merge's own
 * partial-dead-arm proof already marked live, because a `&&` merge's own
 * published type collapsing to `boolean | undefined` is the checker having
 * already proven the kept contribution meaningful only as its truthiness:
 * ECMA-262's `&&` picks its kept operand by `ToBoolean` in the first place, so
 * restating that answer as a plain `bool` is not a new fact about the arm's
 * carrier, it is the exact question this merge already asked of it.
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
  const sourceText = operandText(ctx, operation.source)
  const unwrapped = sourceRepresentation.kind === 'optional' ? `(*${sourceText})` : sourceText
  const booleanPayload: Representation = { kind: 'scalar', domain: 'boolean' }
  const armText = (index: number): string => {
    const arm = payload.arms[index]
    if (!arm) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(sourceRepresentation)}->arm-${index}`,
        `cites live arm ${index} of ${representationKey(sourceRepresentation)}, which has no such arm`
      )
    }
    const loaded = `${unwrapped}.get<${index}>()`
    if (operation.nativeTransport) {
      const citation = operation.nativeTransport.arms.find((entry) => entry.index === index)
      const node = citation ? ctx.conversions.nodeById(citation.conversion) : null
      const text = node ? namedConversionText(ctx, 'emit-narrowing.ts:merge-native-arm', node, loaded) : null
      if (text !== null) return text
      throw createCppEmitBlockedError(
        `conversion:${citation?.conversion ?? 'merge-native-arm'}`,
        'a sealed native merge arm has no conversion spelling'
      )
    }
    const converted = convertedValueText(arm.value, target, loaded)
    if (converted !== null) return converted
    if (isBooleanShapedMergeTarget(target)) {
      const boolText = booleanTestText(loaded, arm.value)
      if (representationKey(target) === representationKey(booleanPayload)) return boolText
      const wrapped = convertedValueText(booleanPayload, target, boolText)
      if (wrapped !== null) return wrapped
    }
    throw createCppEmitBlockedError(
      `conversion:${representationKey(arm.value)}->${representationKey(target)}`,
      `rebuilds live arm ${index} (${representationKey(arm.value)}) of ${representationKey(sourceRepresentation)} into ` +
        `${representationKey(target)}, which no installed load performs`
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
    const citation = operation.nativeTransport?.absence
    if (citation === undefined || sourceRepresentation.kind !== 'optional')
      return sourceRepresentation.kind === 'optional'
        ? cppConstantLiteral(sourceRepresentation.absence, sourceRepresentation.absence, target)
        : ''
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
