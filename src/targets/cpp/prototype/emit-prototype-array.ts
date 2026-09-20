import type { IrOperand, IrResult } from '../../../ir/model.js'
import type { Representation } from '../../../representation/model.js'
import { representationKey } from '../../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { alignedValueText, type ConversionSite } from '../emit-narrowing.js'
import { toStringRefusal, toStringText } from '../emit-tostring.js'
import { cppConstantLiteral, cppTypeOf } from '../types.js'

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
  result: IrResult | null
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
export const arrayBulkAppendMethodName = 'push'

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
    // one disagreement is a spelling of the SAME shape: hono's pattern router
    // pushes `[pattern, method, handlerTuple]` into a `Route<T>[]` whose
    // innermost tuple interned under a second shape id with a byte-identical
    // field list, and `recastedRecordText`'s own recast is exactly what
    // reconciles that pair everywhere else. It is applied per element rather
    // than to the pack, because a bulk `appendRange` copies one `ArrayObject`
    // instantiation into another and there is no such copy to make -- only a
    // withheld pack, whose elements are still separate expressions, has
    // anything to convert. `convertedValueText` is the one authority for
    // whether a pair converts at all; a pair it refuses still refuses here.
    const converted =
      withheld?.elements.map((text) => alignedValueText(ctx, 'prototype/emit-prototype-array.ts:174', packedElement, element, text)) ?? null
    if (converted !== null && converted.every((text) => text !== null)) {
      return `gea::runtime::array::${member}(${[receiverText, ...converted].join(', ')})`
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
 * runtime template rather than spelled here: the emitter would have to
 * re-derive it from the plan's carrier for the call's result, which is a
 * second authority for a fact the C++ type system already holds exactly.
 */
const callbackMethodText =
  (member: string, clause: string): ArrayCallRenderer =>
  (ctx, receiverText, _element, args): string => {
    const callback = args[0]
    if (args.length !== 1 || !callback) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:${elementKey(_element)}`,
        `"Array.prototype.${member}" is spelled for its one callback argument (ECMA-262 ${clause}); this call passes ${args.length}` +
          (args.length > 1 ? `, and ECMA-262 ${clause}'s second parameter is a thisArg a CallableObject has nothing to bind` : '')
      )
    }
    return `gea::runtime::array::${member}(${receiverText}, ${elementAdaptedCallbackText(ctx, member, clause, _element, callback)})`
  }

/**
 * The callback, as the runtime's per-element call can invoke it.
 *
 * `gea::runtime::array`'s `mapCall` (and its siblings) hand the callable the
 * element AS the element's own C++ type, at whichever arity the callable takes.
 * That is exact while the callback's first parameter IS the element carrier. A
 * callback declared WIDER than the element -- `nums.map(label)` with `label:
 * (x: number | string) => string`, or hono's `matchResult[0].map(([[, route]])
 * => route)`, whose parameter is the union of the two arms' tuple elements
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
 */
const elementAdaptedCallbackText = (
  ctx: EmitContext,
  member: string,
  clause: string,
  element: Representation,
  callback: IrOperand
): string => {
  const text = operandText(ctx, callback)
  const carrier = callback.representation
  if (carrier.kind !== 'function-value-dispatch' || carrier.abi.receiver !== null) return text
  const [first, index, array, ...beyond] = carrier.abi.parameters
  if (!first || representationKey(first.value) === representationKey(element)) return text
  const refuse = (detail: string): never => {
    throw createCppEmitBlockedError(
      `runtime-helper:callback:${member}:${elementKey(element)}`,
      `"Array.prototype.${member}" (ECMA-262 ${clause}) hands its callback the receiver's element "${elementKey(element)}" and the callback's ` +
        `first parameter carries "${representationKey(first.value)}"; ${detail}`
    )
  }
  if (carrier.abi.restFrom !== null || beyond.length > 0)
    refuse('a callback with more parameters than element, index and array has no runtime call shape')
  const converted = alignedValueText(
    ctx,
    'prototype/emit-prototype-array.ts:elementAdaptedCallbackText',
    element,
    first.value,
    '__gea_element'
  )
  if (converted === null) refuse('no installed conversion reconciles them')
  if (index && representationKey(index.value) !== 'scalar(number)')
    refuse(`its index parameter carries "${representationKey(index.value)}", and the runtime passes a number`)
  if (array && (array.value.kind !== 'array-object' || representationKey(array.value.element) !== representationKey(element)))
    refuse(`its array parameter carries "${representationKey(array.value)}", and the runtime passes the receiver itself`)
  const formals = [`const ${cppTypeOf(element)}& __gea_element`]
  const actuals = [converted as string]
  if (index) {
    formals.push('double __gea_index')
    actuals.push('__gea_index')
  }
  if (array) {
    formals.push(`const ${cppTypeOf(array.value)}& __gea_array`)
    actuals.push('__gea_array')
  }
  return `[__gea_fn = ${text}](${formals.join(', ')}) { return __gea_fn(${actuals.join(', ')}); }`
}

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
const spliceText: ArrayCallRenderer = (ctx, receiverText, element, args) => {
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
  return call(ctx, 'splice', receiverText, args)
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
  if (args.length === 1) return call(ctx, 'sort', receiverText, args)
  if (element.kind !== 'string' && element.kind !== 'scalar') {
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
  const converted = toStringText('__gea_join_src->at(__gea_join_i)', element, ctx.classes, ctx.deriver, false, true)
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
const flatText: ArrayCallRenderer = (ctx, receiverText, element, args) => {
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

/** The reducers: `reduce(cb)` and `reduce(cb, initialValue)` are two physical arities and two runtime overloads; the no-initial form's empty-array TypeError lives in the runtime. */
const reduceText =
  (member: 'reduce' | 'reduceRight', clause: string): ArrayCallRenderer =>
  (ctx, receiverText, _element, args): string => {
    requireArity(member, clause, [1, 2], args)
    return call(ctx, member, receiverText, args)
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
 * S[]` states that every value the guard kept is an `S`. hono's
 * `utils/html.ts` selects the second -- `res.filter<string>(Boolean as any)`
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
  ['slice', rangedMethodText('slice', '23.1.3.28', [0, 1, 2], null)],
  ['indexOf', rangedMethodText('indexOf', '23.1.3.17', [1, 2], 0)],
  ['lastIndexOf', rangedMethodText('lastIndexOf', '23.1.3.20', [1, 2], 0)],
  ['includes', rangedMethodText('includes', '23.1.3.16', [1, 2], 0)],
  ['fill', rangedMethodText('fill', '23.1.3.7', [1, 2, 3], 0)],
  ['reverse', rangedMethodText('reverse', '23.1.3.26', [0], null)]
])

export const arrayPrototypeMethods: ReadonlySet<string> = new Set(arrayMethods.keys())

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
    'keys',
    'ECMA-262 23.1.3.19 keys() returns an ITERATOR object, which is a first-class value this backend does not mint -- emit-iterator.ts lowers only the ' +
      'fused for-of cursor, never a standalone iterator'
  ],
  ['values', 'ECMA-262 23.1.3.38 values() returns an ITERATOR object; see keys()'],
  ['entries', 'ECMA-262 23.1.3.5 entries() returns an ITERATOR of [index, value] pairs; see keys()'],
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
