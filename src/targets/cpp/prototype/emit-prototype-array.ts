import { arrayBulkAppendMethodName } from '../../../representation/prototype-domains.js'
export { arrayBulkAppendMethodName, arrayPrototypeMethods } from '../../../representation/prototype-domains.js'
import type { CallOperation, IrOperand, IrResult } from '../../../ir/model.js'
import { operationConversionText } from '../emit-certified-conversion.js'
import type { Representation } from '../../../representation/model.js'
import { storedCarrier } from '../../../representation/primitives.js'
import { absenceCarrier, representationKey } from '../../../representation/model.js'
import { createCppEmitBlockedError, cppThunkName, operandText, type EmitContext } from '../emit-context.js'
import { alignedValueText, type ConversionSite } from '../emit-narrowing.js'
import { toStringRefusal, toStringText } from '../emit-tostring.js'
import { cppConstantLiteral, cppRecordFieldName, cppRecordStructName, cppTypeOf } from '../types.js'
import { memberAccessOperator } from '../emit-carrier-members.js'
import type { StructuralTypeId } from '../../../identity/ids.js'
import { booleanTestText } from '../emit-presence.js'
import { strictEqualityText } from '../emit-equality.js'
import { armAt, armIs } from '../emit-union-properties.js'
import { flatMapFlatteningOf } from '../../../ir/flat-map-flattening.js'

/**
 * `Array.prototype`, as this backend renders it.
 *
 * Clause numbers throughout are ECMA-262 2023 (14th edition), where
 * `Array.prototype`'s members are numbered alphabetically -- stated because the
 * numbering shifts every edition that adds a member, so a clause is only
 * unambiguous once its edition is named. The member NAME is the identity; the
 * clause is the pointer.
 *
 * The mechanism is `emit-prototype-invoke.ts`'s -- a deferred `[[Get]]` fused
 * with the call that follows -- and its header states why. What lives here is
 * the table: which members are claimed, at which arities, over which argument
 * carriers, and which are refused BY NAME with what missing.
 *
 * The runtime behind it is `gea::runtime::array` over this backend's own
 * `ArrayObject<E>`. That namespace's header states why these are written
 * rather than ported: v1's typed (`std::vector<T>`) array surface stops at
 * length, indexed get/set and iteration, and every method past that takes a
 * BOXED `gea_cpp_value` receiver -- which a statically typed array may not be
 * lowered into. v1's generic implementation is the spec reference the step
 * order follows; the carrier stays typed.
 *
 * Two rules recur below and are stated once here:
 *
 *  - An argument that must BE an element (`indexOf`'s needle, `fill`'s value)
 *    is checked against the receiver's own element carrier by
 *    `representationKey`. The checker's `T` binds identically for both, so a
 *    disagreement should never happen -- but if it did it would alias two
 *    differently laid-out `ArrayObject<T>` instantiations, a real miscompile
 *    C++ would not catch, so it is refused rather than assumed (`push`'s own
 *    long-standing check, generalized).
 *  - A CALLBACK argument is converted, not checked: `gea::runtime::array`'s
 *    templates invoke whatever they are handed with the element type, at the
 *    arity the callable actually takes, and where the callback's first
 *    parameter is declared WIDER than the element the element is injected into
 *    it at the boundary (`elementAdaptedCallbackText`), by the same conversion
 *    authority every direct call site uses. Anything past that is left to C++,
 *    which rejects a callable that cannot take what it is handed at the same
 *    call this renders.
 */

/** The one signature every member's renderer has. `element` is the receiver's own element carrier; `result` is read by the members whose ECMA-262 result can be `undefined`. */
export type ArrayCallRenderer = (
  ctx: EmitContext,
  receiverText: string,
  element: Representation,
  args: readonly IrOperand[],
  result: IrResult | null,
  operation?: CallOperation
) => string

const elementKey = (element: Representation): string => representationKey(element)

/** A `number` scalar -- the carrier every index, count and position argument below must have. */
const isNumber = (operand: IrOperand): boolean => operand.representation.kind === 'scalar' && operand.representation.domain === 'number'

/**
 * The arity gate, written once. An omitted trailing optional argument never
 * reaches `operation.arguments` at all, so the arities listed here are
 * PHYSICAL arities and each one selects its own runtime overload, which
 * supplies the spec's default at its own definition rather than having one
 * synthesized here.
 */
const requireArity = (member: string, clause: string, arities: readonly number[], args: readonly IrOperand[]): void => {
  if (arities.includes(args.length)) return
  throw createCppEmitBlockedError(
    `runtime-helper:element:${member}`,
    `"Array.prototype.${member}" is spelled for ${arities.join(' or ')} argument(s) (ECMA-262 ${clause}); this call passes ${args.length}`
  )
}

const requireNumber = (member: string, ordinal: number, args: readonly IrOperand[]): void => {
  const argument = args[ordinal]
  if (argument && isNumber(argument)) return
  throw createCppEmitBlockedError(
    `runtime-helper:element:${member}`,
    `"Array.prototype.${member}" argument ${ordinal} carries "${argument ? representationKey(argument.representation) : 'nothing'}", not a number scalar -- ` +
      'the specification ToIntegerOrInfinity-coerces it, and coercion of an arbitrary value has no box here'
  )
}

const requireElement = (member: string, ordinal: number, element: Representation, args: readonly IrOperand[]): void => {
  const argument = args[ordinal]
  if (argument && elementKey(argument.representation) === elementKey(element)) return
  throw createCppEmitBlockedError(
    `runtime-helper:element:${member}:${elementKey(element)}`,
    `"Array.prototype.${member}" argument ${ordinal} carries "${argument ? representationKey(argument.representation) : 'nothing'}", which is not the ` +
      `receiver's own element carrier "${elementKey(element)}"`
  )
}

/** A plain `gea::runtime::array::<member>(receiver, ...args)`, with each argument's carrier already gated by the caller. */
const call = (ctx: EmitContext, member: string, receiverText: string, args: readonly IrOperand[]): string =>
  `gea::runtime::array::${member}(${[receiverText, ...args.map((argument) => operandText(ctx, argument))].join(', ')})`

/**
 * The mutating bulk pair, ECMA-262 23.1.3.23 `push` and 23.1.3.37 `unshift`.
 *
 * Both take a rest parameter, so `ir/lower.ts`'s `packRestArguments` has
 * already packed every call argument into one `array-object` before this runs
 * -- a three-argument `a.push(x, y, z)` arrives here as `args.length === 1`.
 * That is what makes the rendering a two-step bulk write rather than a
 * comma-chain of one call per argument: `appendRange`/`prependRange`
 * (gea_runtime.h) already are "insert every slot of one `ArrayObject` into
 * another, in order, holes and all", which for a rest pack is exactly the
 * spec's own loop. The observable end state is identical for a plain array
 * with no exotic `length`/index setters, which is the only receiver an
 * `array-object` carrier ever is. The final `Set(O, "length", len)` and
 * `Return len` are the same `->length()` read `.length` already uses.
 *
 * A comma expression: C++ sequences the bulk write fully before `length()`
 * reads it, so this is one expression whose value is the new length -- exactly
 * the shape `emitCall` renders either as a bare statement or as an assignment.
 */
/**
 * The one `arrayMethods` entry `emit-arrays.ts`'s counted-loop census also has
 * to recognize, by name, before this table has run at all -- see that file's
 * `pushLookups`. Named here rather than left a bare `'push'` literal in both
 * files so the two cannot silently name two different methods: this is a
 * bulk APPEND specifically (ECMA-262 23.1.3.23), not `unshift`'s bulk prepend,
 * because the loop rewrite it feeds only ever turns a counted push into a
 * range append -- a counted `unshift` would have to run its bound in reverse,
 * which nothing here builds.
 */

const bulkInsertText =
  (member: 'push' | 'unshift', clause: string, spelling: 'appendRange' | 'prependRange'): ArrayCallRenderer =>
  (ctx, receiverText, element, args): string => {
    const packed = args[0]
    if (args.length !== 1 || !packed) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:${elementKey(element)}`,
        `"Array.prototype.${member}" (ECMA-262 ${clause}) expects its rest argument already packed into one array-object by ir/lower.ts's ` +
          `packRestArguments; this call arrives with ${args.length} operand(s)`
      )
    }
    if (packed.representation.kind !== 'array-object') {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:${elementKey(element)}`,
        `"Array.prototype.${member}"'s packed rest argument carries a "${packed.representation.kind}" carrier, not "array-object"`
      )
    }
    // The pack the lowering built exists only to be drained back out here, and
    // where the census withheld it (`EmitContext.pendingPacks`) its elements are
    // written straight into the receiver instead -- one allocation and one
    // `ArrayObject` per call saved, which in a loop is one per iteration. The
    // runtime's own variadic form also names the receiver once, which the
    // comma-expression below cannot: a receiver expression that is itself a
    // fresh object would otherwise be built twice, and the length read would
    // report the wrong one.
    const withheld = ctx.pendingPacks.get(packed.value)
    const packedElement = packed.representation.element
    if (elementKey(packedElement) === elementKey(element)) {
      if (withheld) return `gea::runtime::array::${member}(${[receiverText, ...withheld.elements].join(', ')})`
      return `(${receiverText}->${spelling}(*${operandText(ctx, packed)}, 0), ${receiverText}->length())`
    }
    // Two element carriers that disagree are usually a real miscompile risk --
    // the header's own rule, and the reason this stayed a bare refusal. But
    // one disagreement is a spelling of the SAME shape: pushing a nested tuple
    // literal `[a, b, innerTuple]` into an array of a declared tuple type whose
    // innermost tuple interned under a second shape id with a byte-identical
    // field list, and `recastedRecordText`'s own recast is exactly what
    // reconciles that pair everywhere else. It is applied per element rather
    // than to the pack, because a bulk `appendRange` copies one `ArrayObject`
    // instantiation into another and there is no such copy to make -- only a
    // withheld pack, whose elements are still separate expressions, has
    // anything to convert. `convertedValueText` is the one authority for
    // whether a pair converts at all; a pair it refuses still refuses here.
    // Collected into a `string[]` while every element is still converted: an
    // `every`-narrowed `(string | null)[]` has no native conversion to the
    // array of strings joined below.
    if (withheld) {
      const converted: string[] = [receiverText]
      let complete = true
      for (const text of withheld.elements) {
        const aligned = alignedValueText(ctx, 'prototype/emit-prototype-array.ts:174', packedElement, element, text)
        if (aligned === null) complete = false
        else converted.push(aligned)
      }
      if (complete) return `gea::runtime::array::${member}(${converted.join(', ')})`
    }
    throw createCppEmitBlockedError(
      `runtime-helper:element:${member}:${elementKey(element)}`,
      `"Array.prototype.${member}"'s packed rest argument carries element "${elementKey(packedElement)}", which does not match the ` +
        `receiver's own element "${elementKey(element)}"`
    )
  }

/**
 * The callback-taking family: `map`, `filter`, `forEach`, `find`, `findIndex`,
 * `some`, `every`, `flatMap`.
 *
 * One argument only. The spec's second parameter is `thisArg`, which binds
 * `this` inside the callback -- and a `CallableObject` carries its own
 * environment rather than a rebindable receiver, so there is nothing here to
 * bind it to. Refused by name rather than silently ignored: dropping it would
 * run the callback with the wrong `this`, which is a wrong answer and not a
 * missing feature.
 *
 * The result's element type is the callback's own return type, deduced in the
 * runtime template rather than spelled here. That equals the plan's element
 * only while the callback's carrier is the checker's `U`. A JavaScript closure
 * over a parameter narrowed from its call sites returns a narrower carrier
 * than the `any` the checker gave `U`, so `map` converts each result through
 * its certified `prototype-result` recipe (`elementAdaptedCallbackText`).
 */
const callbackMethodText =
  (member: string, clause: string): ArrayCallRenderer =>
  (ctx, receiverText, _element, args, result, operation): string => {
    const callback = args[0]
    if (args.length !== 1 || !callback) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:${elementKey(_element)}`,
        `"Array.prototype.${member}" is spelled for its one callback argument (ECMA-262 ${clause}); this call passes ${args.length}` +
          (args.length > 1 ? `, and ECMA-262 ${clause}'s second parameter is a thisArg a CallableObject has nothing to bind` : '')
      )
    }
    const stated = member === 'flatMap' ? (flatMapResultCarrier(callback, result) ?? flatMapConvertedCarrier(callback, result)) : null
    return `gea::runtime::array::${member}${stated === null ? '' : `<${stated}>`}(${receiverText}, ${elementAdaptedCallbackText(ctx, member, clause, _element, callback, result, operation)})`
  }

/**
 * The result carrier `flatMap` is told to build, when the callback's C++
 * return type cannot name it: a callback returning "element or array"
 * (`f(x) ?? []`) is a `TaggedUnion` whose flattened element only the checker
 * knows, and a result carried as a recursive wrapper is a type no deduction
 * reaches. Stated only when every value the callback can return stores into
 * the result's element as-is (the same carrier, one of its union arms, or an
 * optional's payload) or is the checker's empty `never[]`, which is what the
 * runtime's `flatMapAppend` performs; anything that would need a conversion
 * keeps the deduced spelling and its refusal.
 */
/**
 * The callback operand as the callable the runtime template invokes.
 *
 * A binding the checker types as a function can still be carried in an
 * `optional` cell: `let render: (v: T) => U` declared before its assignment,
 * read from a closure the checker accepts as definitely assigned. Handing the
 * cell itself to `gea::runtime::array::<member>` names a callable that is not
 * one -- the template has no call shape for an `Optional`. ECMA-262 checks
 * IsCallable(callbackfn) before the first element is visited (23.1.3.21 step
 * 3, and the same step in every sibling), so the presence test belongs at
 * argument evaluation, before the receiver is walked: an absent cell raises a
 * TypeError even over an empty array. A present one is unwrapped and adapted
 * exactly as a callback that was never optional.
 */
const presentCallback = (ctx: EmitContext, callback: IrOperand): { readonly text: string; readonly carrier: Representation } => {
  const carrier = callback.representation
  if (carrier.kind !== 'optional' || carrier.payload.kind !== 'function-value-dispatch') {
    return { text: operandText(ctx, callback), carrier }
  }
  return { text: `(*gea::host::presentOrThrow(${operandText(ctx, callback)}))`, carrier: carrier.payload }
}

const flatMapFlatteningAt = (callback: IrOperand, result: IrResult | null | undefined) => {
  const held = result?.representation
  const carrier = callback.representation.kind === 'optional' ? callback.representation.payload : callback.representation
  if (held === undefined || carrier.kind !== 'function-value-dispatch') return null
  return flatMapFlatteningOf(carrier.abi.result, held)
}

const flatMapResultCarrier = (callback: IrOperand, result: IrResult | null | undefined): string | null =>
  flatMapFlatteningAt(callback, result)?.stated ? cppTypeOf(result!.representation) : null

/**
 * The result carrier a converting `flatMap` states: its callback is wrapped
 * (`elementAdaptedCallbackText`) to return one fresh array of exactly this
 * carrier per call, so the runtime appends it as-is -- stated rather than
 * deduced so a recursive wrapper result is named, not re-derived.
 */
const flatMapConvertedCarrier = (callback: IrOperand, result: IrResult | null | undefined): string | null => {
  const flattening = flatMapFlatteningAt(callback, result)
  return flattening !== null && !flattening.stated && !flattening.deduced ? cppTypeOf(result!.representation) : null
}

/**
 * The callback, as the runtime's per-element call can invoke it.
 *
 * `gea::runtime::array`'s `mapCall` (and its siblings) hand the callable the
 * element AS the element's own C++ type, at whichever arity the callable takes.
 * That is exact while the callback's first parameter IS the element carrier. A
 * callback declared WIDER than the element -- `nums.map(label)` with `label:
 * (x: number | string) => string`, or `pairs.map(([[, value]]) => value)` over
 * a union of two tuple-array arms, whose parameter is the union of the two arms' tuple elements
 * while each arm's array holds exactly one of them -- is a call whose argument
 * needs the conversion any direct call renders at its call site, except that
 * this call site is inside the runtime template. C++ does not perform it:
 * `gea::TaggedUnion` has no converting constructor (arm injection is
 * `ofArm<i>`, spelled by the emitter), so `is_invocable` fails at every arity
 * and the template falls through to its last resort and does not compile --
 * an error at the C++ step, after certification, about a program this backend
 * had already accepted.
 *
 * So the conversion is rendered here, at the one boundary the emitter owns: a
 * lambda of EXACTLY the callback's own arity that converts the element into
 * the first parameter's carrier through `alignedValueText` -- the one authority
 * on which pairs convert -- and forwards the index and the array untouched.
 * Exactly the arity, never a variadic forwarder: `mapCall` picks its call by
 * `is_invocable`, and a lambda that accepted anything would be picked at the
 * three-argument arity and then fail to call a one-parameter callback inside
 * its own body. The callable is init-captured by value so an rvalue callback
 * expression is evaluated once, not once per element.
 *
 * Untouched when the first parameter already carries the element -- the text
 * is exactly what it was, so nothing that emitted before moves -- and untouched
 * for a callable that is not a `function-value-dispatch` or that declares a
 * receiver, which the runtime passes `Undefined{}` for ahead of the element.
 * Refused BY NAME when the pair has no conversion, when the index or array
 * parameter is not the one the runtime hands over, or when the callback is
 * variadic: a refusal at emission is the fail-closed answer the C++ error was
 * standing in for.
 *
 * `Array.from`'s mapper crosses the same boundary inside `fromCall`, which
 * hands it `(kValue, k)` and no array (23.1.2.1), so `handsArray` is false
 * there and a third parameter is refused rather than declared.
 */
export const elementAdaptedCallbackText = (
  ctx: EmitContext,
  member: string,
  clause: string,
  element: Representation,
  callback: IrOperand,
  result?: IrResult | null,
  operation?: CallOperation,
  handsArray = true
): string => {
  const { text, carrier } = presentCallback(ctx, callback)
  if (carrier.kind !== 'function-value-dispatch' || carrier.abi.receiver !== null) return text
  const [first, index, array, ...beyond] = carrier.abi.parameters
  const adaptsElement = first !== undefined && representationKey(first.value) !== representationKey(element)
  const produced = storedCarrier(carrier.abi.result)
  const minted = member === 'map' && result?.representation.kind === 'array-object' ? result.representation.element : null
  const mapped = minted !== null && representationKey(minted) !== representationKey(produced) ? minted : null
  // `flatMap` whose flattened values the runtime cannot store as-is
  // (`flat-map-flattening.ts`): the wrapper flattens one callback result
  // into a fresh array of the result's carrier, converting each value.
  const flattening = member === 'flatMap' && result ? flatMapFlatteningOf(carrier.abi.result, result.representation) : null
  const flattens = flattening !== null && !flattening.stated && !flattening.deduced ? flattening : null
  const adaptsResult =
    (predicateMembers.has(member) && representationKey(carrier.abi.result) !== 'scalar(boolean)') || mapped !== null || flattens !== null
  if (!adaptsElement && !adaptsResult) return text
  const refuse = (detail: string): never => {
    throw createCppEmitBlockedError(
      `runtime-helper:callback:${member}:${elementKey(element)}`,
      (handsArray
        ? `"Array.prototype.${member}" (ECMA-262 ${clause}) hands its callback the receiver's element`
        : `"Array.${member}" (ECMA-262 ${clause}) hands its callback the source's element`) +
        ` "${elementKey(element)}" and the callback's first parameter carries "${first ? representationKey(first.value) : 'nothing'}"; ${detail}`
    )
  }
  if (carrier.abi.restFrom !== null || beyond.length > 0)
    refuse('a callback with more parameters than element, index and array has no runtime call shape')
  if (array && !handsArray) refuse('a callback with more parameters than element and index has no runtime call shape')
  const converted = !first
    ? null
    : adaptsElement
      ? alignedValueText(ctx, 'prototype/emit-prototype-array.ts:elementAdaptedCallbackText', element, first.value, '__gea_element')
      : '__gea_element'
  if (first && converted === null) refuse('no installed conversion reconciles them')
  if (index && representationKey(index.value) !== 'scalar(number)')
    refuse(`its index parameter carries "${representationKey(index.value)}", and the runtime passes a number`)
  if (array && (array.value.kind !== 'array-object' || representationKey(array.value.element) !== representationKey(element)))
    refuse(`its array parameter carries "${representationKey(array.value)}", and the runtime passes the receiver itself`)
  const formals: string[] = []
  const actuals: string[] = []
  if (first) {
    formals.push(`const ${cppTypeOf(element)}& __gea_element`)
    actuals.push(converted as string)
  }
  if (index) {
    formals.push('double __gea_index')
    actuals.push('__gea_index')
  }
  if (array) {
    formals.push(`const ${cppTypeOf(array.value)}& __gea_array`)
    actuals.push('__gea_array')
  }
  const call = `__gea_fn(${actuals.join(', ')})`
  if (!adaptsResult) return `[__gea_fn = ${text}](${formals.join(', ')}) { return ${call}; }`
  if (mapped !== null) {
    const stored = carrier.abi.result.kind === 'void' ? `(${call}, gea::Undefined{})` : call
    const converted = operation ? operationConversionText(ctx, operation, 'prototype-result', produced, mapped, '__gea_mapped') : null
    if (converted === null)
      throw createCppEmitBlockedError(
        `runtime-helper:callback:${member}:${elementKey(element)}`,
        `"Array.prototype.${member}" (ECMA-262 ${clause}) stores its callback's "${representationKey(produced)}" into an array of ` +
          `"${representationKey(mapped)}", and the call cites no conversion between them`
      )
    return `[__gea_fn = ${text}](${formals.join(', ')}) -> ${cppTypeOf(mapped)} { auto __gea_mapped = ${stored}; return ${converted}; }`
  }
  if (flattens !== null && result) {
    // FlattenIntoArray at depth 1 (23.1.3.13.1) for one callback result:
    // an Array arm's present elements (a hole is skipped, step 3.b), any
    // other arm as one element, each converted into the result's element.
    // An arm that contributes nothing is the checker's empty `never[]`.
    const held = result.representation as Extract<Representation, { kind: 'array-object' }>
    const contributes = new Set(flattens.flattened.map((value) => representationKey(value)))
    const into = (valueText: string, from: Representation): string => {
      if (representationKey(from) === representationKey(held.element)) return valueText
      const converted = operation ? operationConversionText(ctx, operation, 'prototype-result', from, held.element, valueText) : null
      if (converted === null)
        throw createCppEmitBlockedError(
          `runtime-helper:callback:${member}:${elementKey(element)}`,
          `"Array.prototype.${member}" (ECMA-262 ${clause}) flattens its callback's "${representationKey(from)}" into an array of ` +
            `"${representationKey(held.element)}", and the call cites no conversion between them`
        )
      return converted
    }
    const append = (valueText: string, from: Representation): string => {
      if (from.kind !== 'array-object') return `gea_flat->push(${into(valueText, from)});`
      if (!contributes.has(representationKey(from.element))) return ''
      return (
        `{ const auto& gea_spread = ${valueText}; if (gea_spread) for (std::size_t gea_index = 0, gea_length = gea_spread->size(); ` +
        `gea_index < gea_length; ++gea_index) if (gea_spread->present(gea_index)) ` +
        `gea_flat->push(${into('gea_spread->readElement(gea_index)', from.element)}); }`
      )
    }
    const produced = carrier.abi.result
    const body =
      produced.kind === 'tagged-union'
        ? produced.arms
            .map((arm, index) => `if (${armIs('__gea_mapped', index)}) { ${append(armAt('__gea_mapped', index), arm.value)} }`)
            .join(' else ')
        : append('__gea_mapped', produced)
    return (
      `[__gea_fn = ${text}](${formals.join(', ')}) -> ${cppTypeOf(held)} { const auto __gea_mapped = ${call}; ` +
      `auto gea_flat = gea::makeRef<${cppTypeOf(held, 'owned')}>(); ${body} return gea_flat; }`
    )
  }
  // A predicate member's step "If ToBoolean(testResult) is true" (23.1.3.8
  // step 5.c.iii and its siblings): the callback may return anything --
  // `names.filter(m => m.match(re))` returns a match or `null`
  // -- and the runtime's `if (mapCall(...))` has no ToBoolean for a C++ value
  // of an arbitrary carrier. The one ToBoolean authority spells it here,
  // over the result held once so a test that reads it twice evaluates the
  // callback once.
  return (
    `[__gea_fn = ${text}](${formals.join(', ')}) -> bool { const auto __gea_test = ${call}; ` +
    `return ${booleanTestText('__gea_test', carrier.abi.result)}; }`
  )
}

/** The members whose callback result is read only through ToBoolean. */
const predicateMembers: ReadonlySet<string> = new Set(['filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every'])

/**
 * `find` and `at` -- and, with them, `pop` and `shift`: the members whose
 * ECMA-262 result is `undefined` when there is nothing there (23.1.3.9 step 6,
 * 23.1.3.1 step 6, 23.1.3.22 step 3.a, 23.1.3.26 step 3.a).
 *
 * `undefined` is a real value, not an absence to shrug at, so the runtime
 * answers `gea::Optional<E>` and this reconciles that actual result with the
 * plan's carrier through the ordinary conversion table. A dynamic result is
 * therefore boxed per state, including an Undefined box for the absent arm;
 * a concrete carrier that cannot preserve absence is refused.
 *
 * A call with NO result at all is a different thing and passes: `arr.pop();`
 * in statement position discards the value, and `emitCall` renders it as a
 * bare expression statement. The mutation is the point there, the `Optional`
 * is constructed and dropped, and there is no carrier to disagree with.
 */
const optionalElementResultText = (
  ctx: ConversionSite,
  member: string,
  clause: string,
  element: Representation,
  result: IrResult | null,
  text: string
): string => {
  if (result === null) return text
  const carrier = result.representation
  const produced: Representation = { kind: 'optional', payload: element, absence: 'undefined' }
  const converted = alignedValueText(ctx, 'prototype/emit-prototype-array.ts:242', produced, carrier, text)
  if (converted !== null) return converted
  throw createCppEmitBlockedError(
    `conversion:${representationKey(produced)}->${representationKey(carrier)}`,
    `"Array.prototype.${member}" answers \`undefined\` when there is no such element (ECMA-262 ${clause}), so this backend renders it as an optional ` +
      `"${elementKey(element)}"; this call's result carries "${representationKey(carrier)}", and no installed conversion preserves both states`
  )
}

/**
 * ECMA-262 23.1.3.31 splice(start, deleteCount, ...items)` -- the member that
 * both mutates in place AND returns the removed elements, which is what makes
 * it the one no "returns the receiver" shortcut can fake.
 *
 * Three physical arities, because `lib.es5.d.ts` declares two overloads and
 * the rest pack only exists in one of them: `splice(start)` (the spec's
 * "deleteCount absent" branch, everything from `start` onward),
 * `splice(start, deleteCount)`, and `splice(start, deleteCount, ...items)`
 * where the third operand is the packed rest.
 */
const spliceText: ArrayCallRenderer = (ctx, receiverText, element, args, result) => {
  requireArity('splice', '23.1.3.30', [1, 2, 3], args)
  requireNumber('splice', 0, args)
  if (args.length >= 2) requireNumber('splice', 1, args)
  if (args.length === 3) {
    const packed = args[2]
    if (!packed || packed.representation.kind !== 'array-object' || elementKey(packed.representation.element) !== elementKey(element)) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:splice:${elementKey(element)}`,
        `"Array.prototype.splice"'s packed rest argument carries "${packed ? representationKey(packed.representation) : 'nothing'}", not an array-object of ` +
          `the receiver's own element "${elementKey(element)}"`
      )
    }
  }
  // `list.splice(i, 1);` in statement position is an erase: the removed
  // elements are copied into a fresh array nobody reads, and an event
  // emitter that keeps three parallel entry lists paid that allocation three
  // times per listener removed.
  return call(ctx, result === null ? 'spliceDiscarded' : 'splice', receiverText, args)
}

/**
 * ECMA-262 23.1.3.30 sort(comparefn)`.
 *
 * Two renderings, because the two forms are two different operations rather
 * than one with a default. With a comparator, the ordering is the program's.
 * WITHOUT one, step 3's default compares `ToString(x)` against `ToString(y)`
 * by code unit -- a genuinely STRING comparison, which is why `[10, 9].sort()`
 * is `[10, 9]`. That default needs a ToString for the element carrier, and
 * this runtime has one only for a string or a scalar; every other element is
 * refused by name here rather than left to fail as a C++ overload error, which
 * would name a template and not the member.
 */
const sortText: ArrayCallRenderer = (ctx, receiverText, element, args) => {
  requireArity('sort', '23.1.3.30', [0, 1], args)
  // A comparator known to be one capture-free function is handed over by
  // name, so the sort can inline it.
  const comparator = args[0]
  const direct = comparator === undefined ? undefined : ctx.directCallableValues.get(comparator.value)
  if (comparator?.representation.kind === 'function-value-dispatch' && comparator.representation.abi.receiver === null) {
    // SortCompare (23.1.3.30.2) calls the comparator with two elements, which
    // the runtime hands over as the element's own C++ type. Only a comparator
    // whose two parameters ARE that carrier takes them as they are; one
    // declared otherwise (`lights.sort( byShadow )` with `any` parameters over
    // a class-instance array) needs each element converted at this boundary,
    // exactly as `elementAdaptedCallbackText` converts for the callback family
    // -- C++ performs no such conversion, and the inlining `DirectCallable`
    // finds no invocable arity at all.
    const abi = comparator.representation.abi
    const compared = abi.parameters.slice(0, 2)
    const exact = compared.every((parameter) => representationKey(parameter.value) === representationKey(element))
    if (exact) {
      if (direct !== undefined) return `gea::runtime::array::sort(${receiverText}, gea::DirectCallable<&${cppThunkName(direct)}>{})`
    } else {
      const refuse = (detail: string): never => {
        throw createCppEmitBlockedError(
          `runtime-helper:callback:sort:${elementKey(element)}`,
          `"Array.prototype.sort" (ECMA-262 23.1.3.30) hands its comparator two elements "${elementKey(element)}"; ${detail}`
        )
      }
      if (abi.restFrom !== null && abi.restFrom < 2) refuse('a comparator gathering them into a rest parameter has no runtime call shape')
      const actuals = compared.map((parameter, position) => {
        const converted = alignedValueText(
          ctx,
          'prototype/emit-prototype-array.ts:sortText',
          element,
          parameter.value,
          `__gea_element_${position}`
        )
        return (
          converted ??
          refuse(`its parameter ${position} carries "${representationKey(parameter.value)}", and no installed conversion reconciles them`)
        )
      })
      const formals = [0, 1].map((position) => `const ${cppTypeOf(element)}& __gea_element_${position}`)
      const fn = direct !== undefined ? `gea::DirectCallable<&${cppThunkName(direct)}>{}` : operandText(ctx, comparator)
      return `gea::runtime::array::sort(${receiverText}, [__gea_fn = ${fn}](${formals.join(', ')}) { return __gea_fn(${actuals.join(', ')}); })`
    }
  }
  if (args.length === 1) return call(ctx, 'sort', receiverText, args)
  // A dynamic element's ToString is the tag dispatch the runtime already owns
  // (`gea::host::detail::toString(const gea::Value&)`), the same one `String(e)`
  // over a caught value renders.
  if (element.kind !== 'string' && element.kind !== 'scalar' && element.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      `runtime-helper:element:sort:${elementKey(element)}`,
      `"Array.prototype.sort" with no comparator uses ECMA-262 23.1.3.30 step 3's default, which compares ToString(x) against ToString(y); this ` +
        `receiver's element carries "${elementKey(element)}", and this runtime states a ToString only for a string or a scalar -- pass a comparator, ` +
        'or the ToString of that carrier is the gap to close'
    )
  }
  return `gea::runtime::array::sortDefault(${receiverText})`
}

/**
 * ECMA-262 23.1.3.18 join(separator)`. The same ToString requirement `sort`'s
 * default has, for the same reason: step 3.d ToStrings every element that is
 * not a hole, `undefined` or `null`.
 *
 * Unlike `sort`, this one does not refuse a non-string/scalar element outright:
 * `gea::runtime::array::join` (the fast path below) calls a single free
 * `gea::host::detail::toString` overload set, which only covers string and
 * scalar -- but the COMPILER's own `toStringText` (emit-tostring.ts) already
 * converts far more (`optional`, `tagged-union` of convertible arms, ...), for
 * the identical ECMA-262 ToString this member needs. The gap is that an
 * `optional`'s ToString needs to know which absence (`null` vs `undefined`) it
 * holds -- a STATIC fact `toStringText` reads off the carrier -- and a runtime
 * template instantiated once per element TYPE has no per-call-site way to
 * carry that. So an element carrier the fast path cannot take is rendered as
 * an inline loop instead, applying `toStringText`'s already-composed
 * conversion text to each element read out of the SAME `ArrayObject` accessors
 * (`size`/`present`/`at`) the fast path itself uses -- one ToString, reached
 * two ways, rather than a second one invented for the loop.
 *
 * `[typeof d.value, d.writable, d.enumerable, d.configurable].join('/')`
 * (`test/runtime/static-intrinsic-reflection.runtime.js`'s own `describe`) is
 * exactly this: TypeScript's ambient `PropertyDescriptor.writable` etc. are
 * `boolean | undefined`, so the array literal's element unifies to
 * `optional(tagged-union(scalar(boolean), string), undefined)`.
 */
const joinText: ArrayCallRenderer = (ctx, receiverText, element, args) => {
  requireArity('join', '23.1.3.18', [0, 1], args)
  const separator = args[0]
  if (separator && separator.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      `runtime-helper:element:join:${elementKey(element)}`,
      `"Array.prototype.join"'s separator carries a "${representationKey(separator.representation)}" carrier, not a string`
    )
  }
  if (element.kind === 'string' || element.kind === 'scalar') return call(ctx, 'join', receiverText, args)
  // `nullishJoinsEmpty`: step 3.d's own rule, not the general ToString every
  // other caller of this table needs -- see `toStringText`'s own header.
  // `symbolThrows`: step 3.d ToStrings a symbol element, which is a TypeError.
  const converted = toStringText('__gea_join_src->readElement(__gea_join_i)', element, ctx.classes, ctx.deriver, false, true, true)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:element:join:${elementKey(element)}`,
      `"Array.prototype.join" ToStrings every element (ECMA-262 23.1.3.18 step 3.d); this receiver's element carries "${elementKey(element)}", and ` +
        `neither this runtime's fast join path nor its inline ToString fallback converts it: ${toStringRefusal(element, ctx.classes, ctx.deriver)}`
    )
  }
  const separatorText = separator ? operandText(ctx, separator) : cppConstantLiteral(',', 'string', { kind: 'string' })
  return (
    '([&]() -> std::string { ' +
    `const auto& __gea_join_src = ${receiverText}; std::string __gea_join_result; ` +
    'for (std::size_t __gea_join_i = 0; __gea_join_i < __gea_join_src->size(); ++__gea_join_i) { ' +
    `if (__gea_join_i != 0) __gea_join_result += ${separatorText}; ` +
    `if (__gea_join_src->present(__gea_join_i)) __gea_join_result += ${converted}; ` +
    '} return __gea_join_result; })()'
  )
}

/**
 * ECMA-262 23.1.3.2 concat(...items)`.
 *
 * The rest pack's element decides which half of step 5's IsConcatSpreadable
 * test applies, and it is a compile-time fact: a packed element that is itself
 * an `array-object` of the receiver's element SPREADS, one that IS the
 * receiver's element is appended whole. A packed element that is neither --
 * the `(T | ConcatArray<T>)[]` overload's own union, reached when a single
 * call mixes the two -- is refused by name, because deciding between the two
 * would mean reading a runtime tag and the two arms produce different lengths.
 */
/**
 * A pack of the `(T | ConcatArray<T>)[]` overload's own union -- a
 * `list.concat({ key })` over an array of an object type. IsConcatSpreadable
 * (23.1.3.2.1) is then a per-item answer, and the union's tag IS that answer:
 * an arm carried as an array of the receiver's element spreads, an arm
 * carried as the element itself is appended whole. A union with any other arm
 * (an array-like record, whose spreadability hangs on a runtime
 * `Symbol.isConcatSpreadable` this carrier cannot hold) answers `null`.
 */
const mixedConcatText = (ctx: EmitContext, receiverText: string, element: Representation, packed: IrOperand): string | null => {
  const carrier = packed.representation
  if (carrier.kind !== 'array-object' || carrier.element.kind !== 'tagged-union') return null
  const item = carrier.element
  const branches: string[] = []
  for (const [index, arm] of item.arms.entries()) {
    const value = armAt('gea_item', index)
    if (elementKey(arm.value) === elementKey(element)) branches.push(`if (${armIs('gea_item', index)}) gea_out.push(${value});`)
    else if (arm.value.kind === 'array-object' && elementKey(arm.value.element) === elementKey(element)) {
      branches.push(
        `if (${armIs('gea_item', index)}) { const auto& gea_spread = ${value}; if (gea_spread) gea_out.appendRange(*gea_spread, 0); }`
      )
    } else return null
  }
  return (
    `gea::runtime::array::concatEach(${receiverText}, ${operandText(ctx, packed)}, ` +
    `[&](auto& gea_out, const ${cppTypeOf(item)}& gea_item) { ${branches.join(' else ')} })`
  )
}

const concatText: ArrayCallRenderer = (ctx, receiverText, element, args) => {
  const packed = args[0]
  if (args.length !== 1 || !packed) {
    throw createCppEmitBlockedError(
      `runtime-helper:element:concat:${elementKey(element)}`,
      '"Array.prototype.concat" expects its rest argument already packed into one array-object by ir/lower.ts\'s packRestArguments; ' +
        `this call arrives with ${args.length} operand(s)`
    )
  }
  const carrier = packed.representation
  const spreads =
    carrier.kind === 'array-object' &&
    carrier.element.kind === 'array-object' &&
    elementKey(carrier.element.element) === elementKey(element)
  const appends = carrier.kind === 'array-object' && elementKey(carrier.element) === elementKey(element)
  const mixed = !spreads && !appends ? mixedConcatText(ctx, receiverText, element, packed) : null
  if (mixed !== null) return mixed
  if (!spreads && !appends) {
    throw createCppEmitBlockedError(
      `runtime-helper:element:concat:${elementKey(element)}`,
      `"Array.prototype.concat"'s packed rest argument carries "${representationKey(carrier)}"; this backend renders it only when every item is the ` +
        `receiver's own element "${elementKey(element)}" (appended whole) or an array-object of it (spread) -- a mixed ` +
        '`(T | ConcatArray<T>)[]` pack would need a runtime tag test, and its two arms produce different lengths'
    )
  }
  return call(ctx, 'concat', receiverText, args)
}

/**
 * ECMA-262 23.1.3.13 flat(depth)`, at depth 1 only.
 *
 * A deeper flatten changes the RESULT'S ELEMENT TYPE by an amount that depends
 * on the depth argument's VALUE, and a value is not a type: there is no single
 * C++ result carrier for `flat(n)`. `flat()` and the literal `flat(1)` are the
 * one depth this backend can spell, and every other depth is refused by name
 * rather than silently flattened once.
 */
/**
 * ECMA-262 23.1.3.5 `entries()`, 23.1.3.19 `keys()` and 23.1.3.38 `values()`:
 * each is CreateArrayIterator (23.1.5.1) over the receiver, a cursor that
 * re-reads the array's length at every step -- so an element pushed during
 * the walk is visited, and a truncation ends it. `gea::Iterator<E>`'s
 * positional step function is exactly that cursor; the step index IS the
 * array index. A hole reads as the element carrier's default, the convention
 * every native Array cursor here (`Iterator::arrayNext`, the sum walk in
 * `emit-iterator.ts`) already shares.
 *
 * `entries` mints each `[index, value]` pair fresh, in whichever carrier the
 * checker's tuple derived to: a positional record, or an Array when both
 * halves share one carrier (`number[]`'s `[number, number]`).
 */
const arrayIteratorText =
  (member: 'entries' | 'keys' | 'values', clause: string): ArrayCallRenderer =>
  (ctx, receiverText, element, args, result): string => {
    requireArity(member, clause, [0], args)
    const target = result?.representation
    const refuse = (detail: string): never => {
      throw createCppEmitBlockedError(`runtime-helper:element:${member}:${elementKey(element)}`, `"Array.prototype.${member}" ${detail}`)
    }
    if (target === undefined || target.kind !== 'iterator') {
      return refuse(`publishes "${target === undefined ? 'nothing' : representationKey(target)}", not the iterator 23.1.5.1 creates`)
    }
    const yielded = target.element
    const elementType = cppTypeOf(element)
    const value = `(gea_array->present(gea_position) ? gea_array->readElement(gea_position) : ${elementType}{})`
    const index = 'static_cast<double>(gea_position)'
    const produced = ((): string | null => {
      if (member === 'keys')
        return alignedValueText(ctx, 'prototype/emit-prototype-array.ts:keys', { kind: 'scalar', domain: 'number' }, yielded, index)
      if (member === 'values') return alignedValueText(ctx, 'prototype/emit-prototype-array.ts:values', element, yielded, value)
      if (yielded.kind === 'array-object' && yielded.ownership === 'shared-refcount') {
        const key = alignedValueText(
          ctx,
          'prototype/emit-prototype-array.ts:entries',
          { kind: 'scalar', domain: 'number' },
          yielded.element,
          index
        )
        const held = alignedValueText(ctx, 'prototype/emit-prototype-array.ts:entries', element, yielded.element, value)
        return key === null || held === null ? null : `gea::arrayOf<${cppTypeOf(yielded.element)}>({${key}, ${held}})`
      }
      if (yielded.kind !== 'record' || yielded.fields.length !== 2) return null
      const [first, second] = yielded.fields
      if (first?.key !== '0' || second?.key !== '1' || !first.required || !second.required) return null
      const key = alignedValueText(
        ctx,
        'prototype/emit-prototype-array.ts:entries',
        { kind: 'scalar', domain: 'number' },
        first.value,
        index
      )
      const held = alignedValueText(ctx, 'prototype/emit-prototype-array.ts:entries', element, second.value, value)
      if (key === null || held === null) return null
      const shared = yielded.ownership === 'shared-refcount'
      const name = cppRecordStructName(yielded.shapeId)
      const write = shared ? 'gea_pair->' : 'gea_pair.'
      return (
        `([&]() { ${shared ? `auto gea_pair = gea::makeRef<${name}>();` : `${name} gea_pair{};`} ` +
        `${write}${cppRecordFieldName('0')} = ${key}; ${write}${cppRecordFieldName('1')} = ${held}; return gea_pair; }())`
      )
    })()
    if (produced === null) {
      return refuse(`yields "${representationKey(yielded)}", which is not built from a "${representationKey(element)}" element here`)
    }
    const yieldedType = cppTypeOf(yielded)
    return (
      `gea::Iterator<${yieldedType}>(std::function<bool(std::size_t, ${yieldedType}&)>([gea_array = ${receiverText}]` +
      `(std::size_t gea_position, ${yieldedType}& gea_out) -> bool { if (!gea_array || gea_position >= gea_array->size()) return false; ` +
      `gea_out = ${produced}; return true; }))`
    )
  }

const flatTupleText = (ctx: EmitContext, receiverText: string, element: Representation, result: IrResult | null): string | null => {
  if (element.kind !== 'record' || !ctx.deriver.isTupleShape(element.shapeId as StructuralTypeId)) return null
  const target = result?.representation
  if (target === undefined || target.kind !== 'array-object' || target.ownership !== 'shared-refcount') return null
  const access = memberAccessOperator(element.ownership)
  const pushes: string[] = []
  for (const [position, field] of element.fields.entries()) {
    if (field.key !== String(position) || !field.required) return null
    const converted = alignedValueText(
      ctx,
      'prototype/emit-prototype-array.ts:flat-tuple',
      field.value,
      target.element,
      `gea_tuple${access}${cppRecordFieldName(field.key)}`
    )
    if (converted === null) return null
    pushes.push(`gea_flat->push(${converted});`)
  }
  return (
    `([&]() { auto gea_flat = gea::makeRef<${cppTypeOf(target)}::element_type>(); const auto& gea_source = ${receiverText}; ` +
    `if (gea_source) for (const auto& gea_slot : gea_source->readSlots()) { if (!gea_slot.present) continue; ` +
    `const auto& gea_tuple = gea_slot.value; ${pushes.join(' ')} } return gea_flat; }())`
  )
}

const flatText: ArrayCallRenderer = (ctx, receiverText, element, args, result) => {
  requireArity('flat', '23.1.3.14', [0, 1], args)
  const depth = args[0]
  if (depth) {
    const constant = ctx.constantTexts.get(depth.value)
    if (constant !== '1') {
      throw createCppEmitBlockedError(
        `runtime-helper:element:flat:${elementKey(element)}`,
        `"Array.prototype.flat" is rendered at depth 1 only (its own default); this call's depth is ` +
          `${constant === undefined ? 'not a compile-time constant' : `the constant ${constant}`}, and a depth other than 1 changes the result's element ` +
          "type by an amount that depends on the argument's value, which no single C++ carrier can spell"
      )
    }
  }
  // The ownership check is not pedantry: `gea::runtime::array::flat` takes the
  // inner array as a `shared_ptr<ArrayObject<Inner>>`, which is what an
  // `array-object` carrier spells only at `shared-refcount`. Any other
  // ownership would miss the template and surface as a C++ overload error
  // naming a template instead of this member.
  if (element.kind === 'array-object' && element.ownership === 'shared-refcount') {
    return `gea::runtime::array::flat(${receiverText})`
  }
  // A per-slot `T | T[]` union -- `(string | string[])[]`'s own tagged union
  // when the checker cannot prove every element the same arm -- is the OTHER
  // shape `flat()` actually has to handle: ECMA-262's own FlattenIntoArray
  // tests `IsArray` per element at runtime regardless, so a two-arm union of
  // exactly [leaf, array-object(leaf)] is not a harder case, just a
  // differently-shaped one. `gea::runtime::array::flat`'s sibling overload
  // (gea_runtime.h) renders it; anything else -- three arms, the array arm
  // not `shared-refcount`, the two arms not agreeing on the leaf type --
  // still refuses below rather than guessing.
  if (
    element.kind === 'tagged-union' &&
    element.arms.length === 2 &&
    element.arms[1]?.value.kind === 'array-object' &&
    element.arms[1].value.ownership === 'shared-refcount' &&
    elementKey(element.arms[1].value.element) === elementKey(element.arms[0]!.value)
  ) {
    return `gea::runtime::array::flat(${receiverText})`
  }
  // A closed TUPLE element -- `Array.from(map).flat()` over a Map's `[K, V]`
  // entries, e.g. to build a name from key/value pairs. A tuple IS an Array exotic object
  // (`IsArray` answers true), so FlattenIntoArray spreads its positions in
  // order; its carrier is a positional record, so each position is read as
  // its own field and converted into the result's element carrier, which the
  // checker typed as the union of the positions. A hole in the OUTER array is
  // skipped (23.1.3.13.1 step 3.b: HasProperty is false).
  const tupleText = flatTupleText(ctx, receiverText, element, result)
  if (tupleText !== null) return tupleText
  throw createCppEmitBlockedError(
    `runtime-helper:element:flat:${elementKey(element)}`,
    `"Array.prototype.flat" flattens one level of nested arrays; this receiver's element carries "${elementKey(element)}", which is neither a ` +
      'shared-refcount array-object nor a two-arm [leaf, array-object(leaf)] union, so there is nothing this backend can flatten'
  )
}

/** The ranged, index-argument members: every argument is a position and the runtime overload for this arity supplies the spec's own default for the rest. */
const rangedMethodText =
  (member: string, clause: string, arities: readonly number[], elementOrdinal: number | null): ArrayCallRenderer =>
  (ctx, receiverText, element, args): string => {
    requireArity(member, clause, arities, args)
    for (let ordinal = 0; ordinal < args.length; ordinal += 1) {
      if (ordinal === elementOrdinal) requireElement(member, ordinal, element, args)
      else requireNumber(member, ordinal, args)
    }
    return call(ctx, member, receiverText, args)
  }

/**
 * ECMA-262 23.1.3.28 `slice(start, end)`, whose positions may arrive as
 * `number | undefined`: `lib.es5.d.ts` declares both optional, so a call that
 * forwards an optional local is present-or-absent at RUNTIME, which no arity
 * can express. ToIntegerOrInfinity(undefined) is 0 for `start`; an undefined
 * `end` is the length (step 4), spelled `+Infinity` exactly as the runtime's
 * one-argument overload clamps it.
 */
const sliceText: ArrayCallRenderer = (ctx, receiverText, element, args, result, operation): string => {
  const optional = (operand: IrOperand): boolean =>
    operand.representation.kind === 'optional' &&
    operand.representation.absence === 'undefined' &&
    operand.representation.payload.kind === 'scalar' &&
    operand.representation.payload.domain === 'number'
  if (!args.some(optional))
    return rangedMethodText('slice', '23.1.3.28', [0, 1, 2], null)(ctx, receiverText, element, args, result, operation)
  requireArity('slice', '23.1.3.28', [1, 2], args)
  const texts = args.map((argument, ordinal) => {
    if (!optional(argument)) {
      requireNumber('slice', ordinal, args)
      return operandText(ctx, argument)
    }
    const fallback = ordinal === 0 ? '0.0' : 'std::numeric_limits<double>::infinity()'
    return `([&](const auto& gea_slice_position) { return gea_slice_position.has_value() ? *gea_slice_position : ${fallback}; }(${operandText(ctx, argument)}))`
  })
  return `gea::runtime::array::slice(${[receiverText, ...texts].join(', ')})`
}

/**
 * ECMA-262 23.1.3.16 `includes(searchElement[, fromIndex])` -- SameValueZero
 * against every element, which is a comparison between two VALUES and never a
 * store: the search value is not written into the array, so it need not carry
 * the element's own carrier, only one the comparison can be decided across.
 * These cross-carrier pairs are rendered beyond the exact one `rangedMethodText` gates:
 *
 * - a DYNAMIC search value over a primitive element. 7.2.12 step 1 compares
 *   Types first, so the value can only match when its tag is the element's;
 *   the tag test decides that, and only then is it unboxed and compared
 *   natively. `Object.values(Enum).includes(value as any)` is the
 *   shape.
 * - an optional primitive search over its payload element: absence compares
 *   equal only to a hole, while present payloads use SameValueZero.
 * - a search value that is the PRESENT arm of an optional element
 *   (`(string | undefined)[]`'s `.includes(name)`): an absent element never
 *   equals a string, so only present payloads are compared
 *   (`gea::runtime::array::includesPresent`).
 */
const includesText: ArrayCallRenderer = (ctx, receiverText, element, args, result, operation): string => {
  const search = args[0]
  if (search === undefined || elementKey(search.representation) === elementKey(element)) {
    return rangedMethodText('includes', '23.1.3.16', [1, 2], 0)(ctx, receiverText, element, args, result)
  }
  // An optional search is still a value, never a store into the array.
  // Undefined cannot equal a present primitive, but DOES equal a hole (Get
  // returns undefined). Keep both carriers native and use the existing
  // SameValueZero/relativeIndex authorities, evaluating each operand once.
  if (
    search.representation.kind === 'optional' &&
    search.representation.absence === 'undefined' &&
    elementKey(search.representation.payload) === elementKey(element) &&
    (element.kind === 'string' || (element.kind === 'scalar' && element.domain !== 'bigint'))
  ) {
    requireArity('includes', '23.1.3.16', [1, 2], args)
    if (args[1] !== undefined) requireNumber('includes', 1, args)
    const from = args[1] === undefined ? '0.0' : operandText(ctx, args[1])
    return (
      `([&]() -> bool { const auto gea_array = ${receiverText}; const auto gea_search = ${operandText(ctx, search)}; ` +
      `const double gea_from = ${from}; if (!gea_array) return false; const std::size_t gea_length = gea_array->size(); ` +
      `for (std::size_t gea_index = gea::runtime::array::relativeIndex(gea_from, gea_length); gea_index < gea_length; ++gea_index) { ` +
      `if (!gea_array->present(gea_index)) { if (!gea_search.has_value()) return true; continue; } ` +
      `if (gea_search.has_value() && gea::sameValueZero(gea_array->readElement(gea_index), *gea_search)) return true; } return false; }())`
    )
  }
  if (args.length === 1 && search.representation.kind === 'dynamic') {
    const cppElement = cppTypeOf(element)
    // Each carrier here has exactly one C++ spelling (`cppScalarType`), which
    // is the payload `unboxValue` reads out of the matching `gea::Value` tag.
    const tag =
      element.kind === 'string'
        ? 'String'
        : element.kind === 'scalar' && element.domain === 'number'
          ? 'Number'
          : element.kind === 'scalar' && element.domain === 'boolean'
            ? 'Boolean'
            : null
    if (tag !== null) {
      return (
        `([&]() -> bool { const gea::Value& gea_search = ${operandText(ctx, search)}; ` +
        `return gea_search.tag() == gea::Value::Tag::${tag} && gea::runtime::array::includes(${receiverText}, ` +
        `gea::detail::unboxValue<${cppElement}>(gea_search, gea::Value::Tag::${tag}, "Array.prototype.includes")); }())`
      )
    }
  }
  if (
    args.length === 1 &&
    element.kind === 'optional' &&
    element.absence === 'undefined' &&
    elementKey(element.payload) === elementKey(search.representation) &&
    (element.payload.kind === 'string' || (element.payload.kind === 'scalar' && element.payload.domain !== 'bigint'))
  ) {
    return `gea::runtime::array::includesPresent(${receiverText}, ${operandText(ctx, search)})`
  }
  // The mirror case: an OPTIONAL search value over the elements of its own
  // payload (`(['a', 'b'] as string[]).includes(value as string)` with `value:
  // string | null`, which a type assertion does not unwrap). A primitive
  // element is never `null` or `undefined`, so an absent search value answers
  // false; a present one compares its payload. The receiver and the search
  // value are evaluated first, in that order, either way.
  if (
    search.representation.kind === 'optional' &&
    elementKey(search.representation.payload) === elementKey(element) &&
    (element.kind === 'string' || (element.kind === 'scalar' && element.domain !== 'bigint'))
  ) {
    requireArity('includes', '23.1.3.16', [1, 2], args)
    if (args[1] !== undefined) requireNumber('includes', 1, args)
    const from = args[1] === undefined ? '' : `, ${operandText(ctx, args[1])}`
    return (
      `([&]() -> bool { auto&& gea_receiver = ${receiverText}; const auto& gea_search = ${operandText(ctx, search)}; ` +
      `return gea_search.has_value() && gea::runtime::array::includes(gea_receiver, *gea_search${from}); }())`
    )
  }
  // A search value whose every arm IS an arm of a union element -- the same
  // arm set spelled in another order, or one member of it -- widens into the
  // element exactly, so the comparison runs over the element's own carrier.
  // A search arm the element lacks is refused rather than narrowed: narrowing
  // would throw where SameValueZero answers false.
  if (element.kind === 'tagged-union') {
    const elementArms = new Set(element.arms.map((arm) => elementKey(arm.value)))
    const searchArms =
      search.representation.kind === 'tagged-union' ? search.representation.arms.map((arm) => arm.value) : [search.representation]
    if (searchArms.every((arm) => elementArms.has(elementKey(arm)))) {
      const widened = alignedValueText(
        ctx,
        'prototype/emit-prototype-array.ts:includes',
        search.representation,
        element,
        operandText(ctx, search)
      )
      if (widened !== null) {
        requireArity('includes', '23.1.3.16', [1, 2], args)
        const from = args[1] === undefined ? '' : `, ${operandText(ctx, args[1])}`
        if (args[1] !== undefined) requireNumber('includes', 1, args)
        return `gea::runtime::array::includes(${receiverText}, ${widened}${from})`
      }
    }
  }
  // A FUNCTION searched for among functions of another convention -- node's
  // stored `Listener`s asked `includes(handler)` for the handler registered
  // through a typed `on`. SameValueZero between two functions is Function
  // identity (7.2.12 step 2 -> SameValueNonNumber), and the one conversion
  // whose adapter shares the source's identity (`callableIdentityTransport`)
  // is exactly the one `on` stored: the adapted search value is equal to an
  // element precisely when the handler it adapts is. An adapter that minted
  // its own identity would answer false for the registered handler, so any
  // other recipe stays refused.
  if (element.kind === 'function-value-dispatch' && search.representation.kind === 'function-value-dispatch') {
    const recipe = operation?.conversionRecipes?.find(
      (input) =>
        input.role === 'prototype-argument' &&
        representationKey(input.source) === representationKey(search.representation) &&
        representationKey(input.target) === representationKey(element)
    )
    const capability = recipe ? ctx.conversions.nodeById(recipe.conversion)?.capability : undefined
    const sharesIdentity =
      (capability?.kind === 'atom' || capability?.kind === 'static') && capability.materializer.callableIdentityTransport === 'preserved'
    const adapted =
      sharesIdentity && operation
        ? operationConversionText(ctx, operation, 'prototype-argument', search.representation, element, operandText(ctx, search))
        : null
    if (adapted !== null) {
      requireArity('includes', '23.1.3.16', [1, 2], args)
      if (args[1] !== undefined) requireNumber('includes', 1, args)
      const from = args[1] === undefined ? '' : `, ${operandText(ctx, args[1])}`
      return `gea::runtime::array::includes(${receiverText}, ${adapted}${from})`
    }
  }
  const crossCarrier = crossCarrierSearchText(ctx, 'includes', receiverText, element, args)
  if (crossCarrier !== null) return crossCarrier
  return rangedMethodText('includes', '23.1.3.16', [1, 2], 0)(ctx, receiverText, element, args, result)
}

/**
 * Carriers on which SameValueZero (7.2.11) and IsStrictlyEqual (7.2.15) give
 * the same answer for every pair of values: the two differ only on NaN, so
 * this is "can never hold a Number". Anything this list does not name is
 * treated as possibly numeric.
 */
const nanFreeCarrier = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'string':
    case 'null':
    case 'undefined':
    case 'class-ref':
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'array-object':
    case 'keyed-collection':
      return true
    case 'scalar':
      return representation.domain !== 'number'
    case 'optional':
      return nanFreeCarrier(representation.payload)
    case 'tagged-union':
      return representation.arms.every((arm) => nanFreeCarrier(arm.value))
    default:
      return false
  }
}

/**
 * `indexOf`/`includes` whose search value carries something other than the
 * element's own carrier -- a subclass instance searched for among base-class
 * elements, the base searched for among a union of subclasses, one arm of a
 * union element, `null` among optional elements. The search value is compared,
 * never stored, so no conversion into the element carrier is owed: each
 * element is compared against it by the one strict-equality authority
 * (`strictEqualityText`), which answers class references by allocation
 * identity across layouts and a sum by its live arm. Where that authority has
 * no answer for the pair, the call stays refused.
 *
 * `indexOf` IS IsStrictlyEqual and skips holes (23.1.3.17 step 9.b).
 * `includes` is SameValueZero and reads a hole as `undefined` (23.1.3.16 step
 * 6.b); it is rendered only over carriers that can never hold a Number, where
 * the two comparisons coincide.
 */
const crossCarrierSearchText = (
  ctx: EmitContext,
  member: 'indexOf' | 'includes',
  receiverText: string,
  element: Representation,
  args: readonly IrOperand[]
): string | null => {
  const search = args[0]
  if (search === undefined || elementKey(search.representation) === elementKey(element)) return null
  if (args.length !== 1 && args.length !== 2) return null
  if (member === 'includes' && !(nanFreeCarrier(element) && nanFreeCarrier(search.representation))) return null
  const searchValue = { text: 'gea_search', representation: search.representation }
  const compared = strictEqualityText('===', { text: 'gea_element', representation: element }, searchValue)
  if (compared === null) return null
  const hole =
    member === 'includes'
      ? strictEqualityText('===', { text: 'undefined', representation: absenceCarrier('undefined') }, searchValue)
      : 'false'
  if (hole === null) return null
  const clause = member === 'includes' ? '23.1.3.16' : '23.1.3.17'
  if (args[1] !== undefined) requireNumber(member, 1, args)
  requireArity(member, clause, [1, 2], args)
  const from = args[1] === undefined ? '0.0' : operandText(ctx, args[1])
  const found = member === 'includes' ? 'true' : 'static_cast<double>(gea_index)'
  const missed = member === 'includes' ? 'false' : '-1.0'
  const holeTest = hole === 'false' ? 'continue;' : `{ if (${hole}) return ${found}; continue; }`
  return (
    `([&]() -> ${member === 'includes' ? 'bool' : 'double'} { const auto gea_array = ${receiverText}; ` +
    `const auto& gea_search = ${operandText(ctx, search)}; const double gea_from = ${from}; if (!gea_array) return ${missed}; ` +
    `const std::size_t gea_length = gea_array->size(); ` +
    `for (std::size_t gea_index = gea::runtime::array::relativeIndex(gea_from, gea_length); gea_index < gea_length; ++gea_index) { ` +
    `if (!gea_array->present(gea_index)) ${holeTest} const auto& gea_element = gea_array->readElement(gea_index); ` +
    `if (${compared}) return ${found}; } return ${missed}; }())`
  )
}

/** `indexOf` over its own element carrier, or over a search value only strict equality relates to it (`crossCarrierSearchText`). */
const indexOfText: ArrayCallRenderer = (ctx, receiverText, element, args, result): string =>
  crossCarrierSearchText(ctx, 'indexOf', receiverText, element, args) ??
  rangedMethodText('indexOf', '23.1.3.17', [1, 2], 0)(ctx, receiverText, element, args, result)

/**
 * The reducer's callback, adapted to the accumulator carrier `accumulator`
 * when its own ABI disagrees with it: the accumulator is converted into the
 * callback's first parameter, the element into its second, and its result
 * back into the accumulator -- each through `alignedValueText`, the one
 * conversion authority. Untouched (the plain operand text) when nothing
 * differs or when the callable is not a receiver-less `function-value-dispatch`.
 *
 * Like `elementAdaptedCallbackText`'s lambda, the wrapper has EXACTLY the
 * callback's arity (at least the two the runtime's last-resort call hands
 * over), so `reduceCall`'s `is_invocable` ladder selects the same call shape
 * it would have selected for the callback itself.
 */
const reducerCallbackText = (
  ctx: EmitContext,
  member: 'reduce' | 'reduceRight',
  clause: string,
  element: Representation,
  accumulator: Representation,
  callback: IrOperand
): string => {
  const text = operandText(ctx, callback)
  const carrier = callback.representation
  if (carrier.kind !== 'function-value-dispatch' || carrier.abi.receiver !== null) return text
  if (carrier.abi.result.kind === 'void') return text
  const [previous, current, index, array, ...beyond] = carrier.abi.parameters
  const produced = carrier.abi.result
  const differs = (left: Representation | undefined, right: Representation): boolean =>
    left !== undefined && representationKey(left) !== representationKey(right)
  if (!differs(previous?.value, accumulator) && !differs(current?.value, element) && !differs(produced, accumulator)) return text
  const refuse = (detail: string): never => {
    throw createCppEmitBlockedError(
      `runtime-helper:callback:${member}:${elementKey(element)}`,
      `"Array.prototype.${member}" (ECMA-262 ${clause}) threads a "${representationKey(accumulator)}" accumulator through a callback ` +
        `whose ABI is (${carrier.abi.parameters.map((parameter) => representationKey(parameter.value)).join(', ')}) => ` +
        `"${representationKey(produced)}"; ${detail}`
    )
  }
  if (carrier.abi.restFrom !== null || beyond.length > 0)
    refuse('a callback with more parameters than accumulator, element, index and array has no runtime call shape')
  const site = 'prototype/emit-prototype-array.ts:reducerCallbackText'
  const previousText = previous ? alignedValueText(ctx, site, accumulator, previous.value, '__gea_accumulator') : null
  if (previous && previousText === null) refuse('no installed conversion carries the accumulator into its first parameter')
  const currentText = current ? alignedValueText(ctx, site, element, current.value, '__gea_element') : null
  if (current && currentText === null) refuse('no installed conversion carries the element into its second parameter')
  if (index && representationKey(index.value) !== 'scalar(number)')
    refuse(`its index parameter carries "${representationKey(index.value)}", and the runtime passes a number`)
  if (array && (array.value.kind !== 'array-object' || representationKey(array.value.element) !== representationKey(element)))
    refuse(`its array parameter carries "${representationKey(array.value)}", and the runtime passes the receiver itself`)
  const resultText = alignedValueText(ctx, site, produced, accumulator, '__gea_step')
  if (resultText === null) refuse('no installed conversion carries its result back into the accumulator')
  const formals = [`const ${cppTypeOf(accumulator)}& __gea_accumulator`, `const ${cppTypeOf(element)}& __gea_element`]
  const actuals: string[] = []
  if (previous) actuals.push(previousText as string)
  if (current) actuals.push(currentText as string)
  if (index) {
    formals.push('double __gea_index')
    actuals.push('__gea_index')
  }
  if (array) {
    formals.push(`const ${cppTypeOf(array.value)}& __gea_array`)
    actuals.push('__gea_array')
  }
  return (
    `[__gea_fn = ${text}](${formals.join(', ')}) -> ${cppTypeOf(accumulator)} { ` +
    `auto __gea_step = __gea_fn(${actuals.join(', ')}); return ${resultText}; }`
  )
}

/**
 * The reducers: `reduce(cb)` and `reduce(cb, initialValue)` are two physical
 * arities and two runtime overloads; the no-initial form's empty-array
 * TypeError lives in the runtime.
 *
 * With an initial value the runtime's accumulator type is the C++ type of the
 * initial argument, so that argument must already BE the accumulator carrier
 * -- the TS type of the call's result (`reduce<U>(cb, initial: U): U`), not
 * the literal's own: an integer-spelled Number literal must not deduce an
 * integer accumulator, a `""` literal must not deduce `const char[1]`, and a
 * `null`/`undefined` literal must not deduce `std::nullptr_t` when the
 * callback answers an optional or a handle. The initial value is converted
 * into that carrier and cast to it, and the callback adapted to it
 * (`reducerCallbackText`).
 */
const reduceText =
  (member: 'reduce' | 'reduceRight', clause: string): ArrayCallRenderer =>
  (ctx, receiverText, element, args, result, operation): string => {
    requireArity(member, clause, [1, 2], args)
    const initial = args[1]
    if (initial === undefined) return call(ctx, member, receiverText, args)
    const callback = args[0]!
    const callbackCarrier = callback.representation
    const accumulator =
      result?.representation ??
      (callbackCarrier.kind === 'function-value-dispatch' && callbackCarrier.abi.receiver === null && callbackCarrier.abi.parameters[0]
        ? callbackCarrier.abi.parameters[0].value
        : initial.representation)
    // The seed's certified conversion first (`host-template-conversions.ts`
    // certifies `prototype-argument` into the accumulator), then an
    // installed one between the two carriers.
    const certified =
      operation && representationKey(accumulator) !== representationKey(initial.representation)
        ? operationConversionText(ctx, operation, 'prototype-argument', initial.representation, accumulator, operandText(ctx, initial))
        : null
    const initialText =
      certified ??
      alignedValueText(ctx, 'prototype/emit-prototype-array.ts:reduceText', initial.representation, accumulator, operandText(ctx, initial))
    if (initialText === null) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:seed`,
        `"Array.prototype.${member}" (ECMA-262 ${clause}) seeds a "${representationKey(accumulator)}" accumulator with ` +
          `"${representationKey(initial.representation)}", and no certified conversion carries one into the other`
      )
    }
    const pinned =
      accumulator.kind === 'scalar' ||
      accumulator.kind === 'string' ||
      representationKey(accumulator) !== representationKey(initial.representation)
        ? `static_cast<${cppTypeOf(accumulator)}>(${initialText})`
        : initialText
    const callbackText = reducerCallbackText(ctx, member, clause, element, accumulator, callback)
    return `gea::runtime::array::${member}(${receiverText}, ${callbackText}, ${pinned})`
  }

/** `pop`/`shift`: no arguments at all, and an optional element for a result -- the receiver is the whole call. */
const optionalNullaryText =
  (member: 'pop' | 'shift', clause: string): ArrayCallRenderer =>
  (ctx, receiverText, element, args, result): string => {
    requireArity(member, clause, [0], args)
    return optionalElementResultText(ctx, member, clause, element, result, `gea::runtime::array::${member}(${receiverText})`)
  }

/**
 * `filter` under a TYPE-GUARD predicate, whose result element is NARROWER than
 * the receiver's.
 *
 * `Array.prototype.filter` has two declarations in `lib.es5.d.ts`: the ordinary
 * one keeps the element, and `filter<S extends T>(predicate: (v: T) => v is S):
 * S[]` states that every value the guard kept is an `S`. A call such as
 * `res.filter<string>(Boolean as any)` selects the second
 * over a `(string | undefined)[]` -- and the checker publishes the call's
 * result as `string[]`.
 *
 * The runtime template cannot answer that: its `kept` array is built from the
 * receiver's own `E`, so it hands back `(string | undefined)[]` and the store
 * into the narrowed cell has no conversion -- and none may be installed, for
 * the reason `conversions.ts` states beside the refusal: a conversion between
 * two `array-object` carriers with different elements can only ALLOCATE, which
 * silently detaches a mutable array from every other name for it.
 *
 * `filter` is the one method where that objection does not apply, because the
 * array in question is one `filter` itself MINTS -- nothing else can hold it
 * yet, so choosing its element is a choice this call owns rather than a recast
 * of somebody's array. So the narrowing happens as each kept element is
 * appended, through the one conversion authority, and the runtime overload
 * takes the projection that performs it.
 */
const filterText: ArrayCallRenderer = (ctx, receiverText, element, args, result) => {
  const plain = callbackMethodText('filter', '23.1.3.8')
  const kept = result?.representation
  if (!kept || kept.kind !== 'array-object' || representationKey(kept.element) === representationKey(element)) {
    return plain(ctx, receiverText, element, args, result)
  }
  const callback = args[0]
  if (args.length !== 1 || !callback) return plain(ctx, receiverText, element, args, result)
  const projected = alignedValueText(ctx, 'prototype/emit-prototype-array.ts:filterText', element, kept.element, '__gea_kept')
  if (projected === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:element:filter:${elementKey(element)}`,
      `"Array.prototype.filter" (ECMA-262 23.1.3.8) publishes "${representationKey(kept.element)}" elements over a receiver ` +
        `carrying "${elementKey(element)}", and no installed conversion narrows one into the other`
    )
  }
  const keptType = cppTypeOf(kept.element)
  const predicate = elementAdaptedCallbackText(ctx, 'filter', '23.1.3.8', element, callback)
  return (
    `gea::runtime::array::filterNarrowed<${keptType}>(${receiverText}, ${predicate}, ` +
    `+[](const ${cppTypeOf(element)}& __gea_kept) -> ${keptType} { return ${projected}; })`
  )
}

const findText: ArrayCallRenderer = (ctx, receiverText, element, args, result) => {
  const text = callbackMethodText('find', '23.1.3.9')(ctx, receiverText, element, args, result)
  return optionalElementResultText(ctx, 'find', '23.1.3.9', element, result, text)
}

const atText: ArrayCallRenderer = (ctx, receiverText, element, args, result) => {
  requireArity('at', '23.1.3.1', [1], args)
  requireNumber('at', 0, args)
  return optionalElementResultText(ctx, 'at', '23.1.3.1', element, result, call(ctx, 'at', receiverText, args))
}

/** `emit-carrier-members.ts`'s `arrayAccessText` defers exactly these keys off an `array-object` receiver -- one authority for "is this method implemented". */
export const arrayMethods: ReadonlyMap<string, ArrayCallRenderer> = new Map<string, ArrayCallRenderer>([
  [arrayBulkAppendMethodName, bulkInsertText(arrayBulkAppendMethodName, '23.1.3.23', 'appendRange')],
  ['unshift', bulkInsertText('unshift', '23.1.3.37', 'prependRange')],
  ['map', callbackMethodText('map', '23.1.3.21')],
  ['filter', filterText],
  ['forEach', callbackMethodText('forEach', '23.1.3.15')],
  ['findIndex', callbackMethodText('findIndex', '23.1.3.10')],
  ['some', callbackMethodText('some', '23.1.3.29')],
  ['every', callbackMethodText('every', '23.1.3.6')],
  ['flatMap', callbackMethodText('flatMap', '23.1.3.14')],
  ['find', findText],
  ['at', atText],
  ['pop', optionalNullaryText('pop', '23.1.3.22')],
  ['shift', optionalNullaryText('shift', '23.1.3.27')],
  ['reduce', reduceText('reduce', '23.1.3.24')],
  ['reduceRight', reduceText('reduceRight', '23.1.3.25')],
  ['splice', spliceText],
  ['sort', sortText],
  ['join', joinText],
  // ECMA-262 23.1.3.36 `toString()`: `Let func be ? Get(array, "join"). If
  // IsCallable(func) is false, set func to %Object.prototype.toString%.
  // Return ? Call(func, array).` Every array this backend carries has a real
  // `join` (it is implemented above, unconditionally), so step 3's fallback
  // never applies and this is exactly `join()` with no arguments -- the same
  // fact `test/runtime/static-intrinsic-reflection.runtime.js`'s own
  // `typeof Array.prototype.join` line depends on `join` existing for.
  //
  // Borrowed Object.prototype.toString calls are authenticated ObjectTag
  // computations and never enter this Array-specific algorithm.
  ['toString', (ctx, receiverText, element) => joinText(ctx, receiverText, element, [], null)],
  ['concat', concatText],
  ['flat', flatText],
  ['entries', arrayIteratorText('entries', '23.1.3.5')],
  ['keys', arrayIteratorText('keys', '23.1.3.19')],
  ['values', arrayIteratorText('values', '23.1.3.38')],
  ['slice', sliceText],
  ['indexOf', indexOfText],
  ['lastIndexOf', rangedMethodText('lastIndexOf', '23.1.3.20', [1, 2], 0)],
  ['includes', includesText],
  ['fill', rangedMethodText('fill', '23.1.3.7', [1, 2, 3], 0)],
  ['reverse', rangedMethodText('reverse', '23.1.3.26', [0], null)]
])

/**
 * Members this backend states a REASON for not implementing, rather than
 * letting them fall into the generic "here is the list of what is implemented"
 * refusal. "Not built yet" and "cannot be built without X" are different
 * answers, and only the second tells you what to build.
 */
/**
 * Names an Array INHERITS -- from `Array.prototype` or, past it,
 * `Object.prototype` -- that this backend renders nothing for.
 *
 * Kept apart from `arrayMemberRefusals` above, which is about members
 * `Array.prototype` itself declares and this backend has simply not built.
 * These are the reason `arrayAccessText` may not treat "not an index, not
 * `length`, not an extension field, not a method" as "an ordinary own
 * property, ask the expando sidecar": the sidecar answers OWN properties, and
 * for every name here the language answers from the PROTOTYPE CHAIN instead.
 * Handing one to the sidecar would find nothing and publish `undefined` --
 * turning a compile-time refusal into a silently wrong answer, which is the
 * one trade this backend never makes.
 */
export const arrayInheritedMemberRefusals: ReadonlySet<string> = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'valueOf',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
])

export const arrayMemberRefusals: ReadonlyMap<string, string> = new Map([
  [
    'findLast',
    'ECMA-262 23.1.3.11 findLast(predicate) is `find` walked from the end and is simply unbuilt here, not blocked -- the same optional-element result ' +
      'carrier `find` uses would carry it'
  ],
  [
    'findLastIndex',
    'ECMA-262 23.1.3.12 findLastIndex(predicate) is `findIndex` walked from the end and is simply unbuilt here, not blocked'
  ],
  [
    'copyWithin',
    "ECMA-262 23.1.3.4 copyWithin(target, start, end) is unbuilt here, not blocked -- it is `fill`'s ranged shape over a self-copy"
  ],
  [
    'toSorted',
    'ECMA-262 23.1.3.34 toSorted / toReversed / toSpliced / with are the ES2023 non-mutating twins; each needs the same copy-then-mutate shape ' +
      '`slice` already has and is unbuilt here, not blocked'
  ],
  [
    'toLocaleString',
    "ECMA-262 23.1.3.32 toLocaleString calls each element's own toLocaleString, which is locale-sensitive; there is no locale database here"
  ]
])

/**
 * The Array.prototype members that MUTATE their receiver (ECMA-262 23.1.3).
 *
 * Read by `emitCall` to tick a reactive array's revision cell after a call that
 * changed its contents. It is a property of the language, not of this
 * backend's rendering of it -- `slice` and `concat` build a new array and
 * change nothing, `splice` and `sort` change the receiver in place -- so it is
 * stated once here beside the renderings rather than re-derived from what each
 * one happens to emit.
 */
export const mutatingArrayMembers: ReadonlySet<string> = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin'
])
