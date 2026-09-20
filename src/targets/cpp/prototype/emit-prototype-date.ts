import type { CallOperation, ConstructOperation, IrOperand } from '../../../ir/model.js'
import type { Representation } from '../../../representation/model.js'
import type { IrValueId, StructuralTypeId } from '../../../identity/ids.js'
import { representationKey } from '../../../representation/model.js'
import { createCppEmitBlockedError, defineValue, operandText, type EmitContext, type PrototypeMethodRead } from '../emit-context.js'
import { cppRecordFieldName, cppTypeOf } from '../types.js'
import { toNumberText } from '../emit-tonumber.js'

/**
 * `Date.prototype` and the `Date` constructor.
 *
 * The C++ half is `gea::runtime::Date` (`runtime/gea_runtime.h`), ported from
 * v1 geatsc's own `targets/cpp/runtime/date.h` + `date.cpp`. This file is the
 * compiler half: which members are claimed, what each one's call renders to,
 * and -- just as important -- what each unclaimed member's refusal says.
 *
 * ## Why the spelling lives here and not in a plugin package
 *
 * `Date` is an ECMAScript builtin declared by `lib.es5.d.ts`, not a gea host
 * protocol. Nothing installs it; the language has it. So its C++ spelling is
 * the backend's own -- the same place `Promise<T>`, the eight TypedArray views
 * and the four keyed collections keep theirs -- and never the gea plugin's
 * `nativeTypes` table, which is the authority for what a HOST implements.
 *
 * ## Why a Date is a `native-record-ref` and not a `native-handle`
 *
 * `representation/derive.ts` already selected `native-record-ref` for the
 * `Date` interface before this port existed (measured: `native-record-ref(
 * type|3,shared-refcount,)` on a two-line `new Date(0)` probe); all the
 * `DateDeclarationPolicy` adds is the `native` field, which names
 * `gea::runtime::Date` as the struct so `records.ts` emits none of its own.
 * A `native-handle` would be wrong for a reason the model states out loud:
 * `types.ts`'s `carriesAbsence` calls every handle a carrier with an empty
 * state, so `representation/optional.ts` collapses `T | null` onto the handle
 * itself -- and a Date has no empty value for `null` to be spelled as.
 *
 * ## Deferral, exactly as String/Array/Map do it
 *
 * `lib.es5.d.ts` gives an interface method no `this` parameter, so there is no
 * receiver-carrying calling convention a first-class method value could be
 * built from (`emit-prototype-string.ts`'s own comment states this). The
 * `[[Get]]` therefore records which member was reached off which receiver and
 * renders nothing; the call that follows renders the whole fused expression.
 * `datePrototypeMethods` is the one authority for which keys may defer, so a
 * member that defers is always a member `dateCallText` can render.
 */

/**
 * The C++ type a Date is carried in.
 *
 * One constant, read by three places that must not disagree: `compiler.ts`
 * installs it as the `DateDeclarationPolicy`'s answer, `types.ts` spells it
 * from the carrier's own `native` field, and `isDateCarrier` below recognizes
 * it again at every member access and construction.
 */
export const cppDateType = 'gea::runtime::Date'

/** Whether a carrier is a Date -- the `native-record-ref` whose stated native type is `gea::runtime::Date`. */
export const isDateCarrier = (representation: Representation): representation is Extract<Representation, { kind: 'native-record-ref' }> =>
  representation.kind === 'native-record-ref' && representation.native === cppDateType

/**
 * A Date method's call text.
 *
 * `receiverText` is the `std::shared_ptr<gea::runtime::Date>` the access
 * recorded, so every member call below is an arrow call. Ownership is proved
 * before a read defers (`dateMemberText`), not assumed here.
 */
type DateRenderer = (ctx: EmitContext, receiverText: string, args: readonly IrOperand[], member: string) => string

/**
 * Every argument of every Date member is a `number` -- ECMA-262 21.4.4 runs
 * each one through ToNumber, and `lib.es5.d.ts` declares each `number`. An
 * argument carrying anything else is refused by name rather than converted:
 * the conversion this backend would have to render is ToNumber of a value
 * whose carrier says it is not one, and answering NaN for it silently would
 * turn a wrong argument into an Invalid Date instead of a diagnostic.
 */
const numericArgumentText = (ctx: EmitContext, argument: IrOperand, member: string, position: number): string => {
  const carrier = argument.representation
  if (carrier.kind === 'scalar' && carrier.domain === 'number') return operandText(ctx, argument)
  const converted = toNumberText(operandText(ctx, argument), carrier) ?? recordToNumberText(ctx, operandText(ctx, argument), carrier)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${member}`,
      `"Date.prototype.${member}" argument ${position} carries "${representationKey(carrier)}", not a number scalar; ` +
        'ECMA-262 21.4.4 applies ToNumber to it, and this backend states no such conversion here'
    )
  }
  return converted
}

/**
 * ToNumber of a compiler-laid-out record -- ECMA-262 7.1.4 step 2 through
 * ToPrimitive with hint number (7.1.1.1): `valueOf` is called first when the
 * record carries one, `toString` otherwise, and the primitive it returns is
 * converted. A record whose method is not a zero-argument callable, or that
 * carries neither, is `null` here: the former has a frame this cannot call
 * without arguments, and the latter reaches `Object.prototype.toString`'s
 * `"[object Object]"` -- NaN, but by way of a prototype chain this record
 * does not carry, so it is refused rather than guessed.
 */
const recordToNumberText = (ctx: EmitContext, text: string, carrier: Representation): string | null => {
  // A `record` carries its fields inline; an anchored literal (a
  // `native-record-ref` with no host native -- `{ valueOf: function () {
  // return this.n } }`, anchored because its method reads `this`) names a
  // shape whose layout the sealed table answers, through the same authority
  // the struct bodies come from.
  // (Asked of the deriver directly rather than through `records.ts`, which
  // imports this renderer's own consumers -- a cycle Node resolves as a
  // temporal-dead-zone crash at load.)
  const body =
    carrier.kind === 'native-record-ref' && carrier.native === null ? ctx.deriver.layoutOf(carrier.shapeId as StructuralTypeId) : null
  const fields =
    carrier.kind === 'record'
      ? carrier.fields
      : body !== null && (body.kind === 'record' || body.kind === 'record-with-index')
        ? body.fields
        : null
  if (fields === null) return null
  for (const method of ['valueOf', 'toString']) {
    const field = fields.find((candidate) => candidate.key === method && candidate.required)
    if (!field) continue
    const abi = field.value.kind === 'function-value-dispatch' || field.value.kind === 'function' ? field.value.abi : null
    if (abi === null) return null
    // ToPrimitive calls the method with NO arguments. A convention whose only
    // formal is the rest slot (a body reading `arguments` -- test262's
    // `arg-coercion-order.js` records them) receives an empty pack, spelled as
    // `virtual-methods.ts` spells an omitted rest: a fresh array of the slot's
    // own element carrier. Any positional formal is a frame this cannot fill.
    const rest = abi.restFrom === 0 && abi.parameters.length === 1 ? (abi.parameters[0] ?? null) : null
    if (rest !== null && rest.value.kind !== 'array-object') return null
    if (rest === null && abi.parameters.length !== 0) return null
    // A method reading `this` declares the receiver, and ToPrimitive calls it
    // ON this very record: the argument is the receiver, so its own carrier
    // must be the one the frame declares. Any other receiver is a frame this
    // site cannot fill.
    if (abi.receiver !== null && representationKey(abi.receiver) !== representationKey(carrier)) return null
    const actuals = [
      ...(abi.receiver === null ? [] : [text]),
      ...(rest === null || rest.value.kind !== 'array-object' ? [] : [`gea::makeRef<gea::ArrayObject<${cppTypeOf(rest.value.element)}>>()`])
    ]
    const call = `${text}->${cppRecordFieldName(method)}.call(${actuals.join(', ')})`
    // A method answering nothing is still CALLED -- for its effects, and for
    // the throw it may be -- and its result is ToNumber(undefined).
    if (abi.result.kind === 'void') return `(${call}, gea::host::detail::toNumberUndefined())`
    return toNumberText(call, abi.result)
  }
  return null
}

/**
 * A member taking no arguments at all -- every getter, and the string forms
 * that are not locale-sensitive.
 *
 * An argument is refused rather than dropped. `d.getFullYear(1)` is legal
 * TypeScript for none of these, so a call that passes one is a call this
 * renderer is not reading correctly, and rendering it as the zero-argument
 * form would hide that.
 */
const nullaryText: DateRenderer = (_ctx, receiverText, args, member) => {
  if (args.length !== 0) {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${member}`,
      `"Date.prototype.${member}" takes no arguments; this call passes ${args.length}`
    )
  }
  return `${receiverText}->${member}()`
}

/**
 * A setter, whose trailing parameters are optional in `lib.es5.d.ts` and
 * default to "keep the current field" in the C++ (each defaults to NaN, which
 * `Date::setFields` reads as "keep" -- v1's own rule).
 *
 * An omitted trailing optional argument never reaches `operation.arguments`
 * at all, so passing exactly what the call passes is what makes
 * `d.setHours(1)` and `d.setHours(1, 2, 3, 4)` both render correctly. The
 * ZERO-argument form is refused: `d.setDate()` is `ToNumber(undefined)`, which
 * is NaN, which invalidates the date -- v1 renders that by defaulting its
 * first parameter to NaN too, but a program that reaches it has almost
 * certainly lost an argument, and this backend does not have the `undefined`
 * operand to prove the call really meant it.
 */
const setterText =
  (maximum: number): DateRenderer =>
  (ctx, receiverText, args, member) => {
    if (args.length === 0) {
      throw createCppEmitBlockedError(
        `host-invocation:Date.prototype.${member}`,
        `"Date.prototype.${member}" takes 1 to ${maximum} argument(s); this call passes none` +
          ' -- the argument-less form is ToNumber(undefined), which is an Invalid Date rather than this operation'
      )
    }
    // An argument past the last the clause names is evaluated by the caller
    // and never coerced: 21.4.4.23 step 2 onward reads exactly its own
    // operands. Its operand is already a computed value here, so leaving it
    // out of the frame is the whole of "ignored".
    const received = args.slice(0, maximum)
    // Every ToNumber runs in argument order, before the C++ member sees any
    // of them (steps 2..5 of each setter), and a function call's argument
    // evaluation order is unspecified in C++ -- so the conversions are
    // sequenced as named locals. A frame of plain numbers keeps the direct
    // spelling: nothing there can observe an order.
    const numbers = received.map((argument, index) => numericArgumentText(ctx, argument, member, index))
    if (received.every((argument) => argument.representation.kind === 'scalar' && argument.representation.domain === 'number')) {
      return `${receiverText}->${member}(${numbers.join(', ')})`
    }
    // The time value is read BEFORE any argument is coerced (each setter's
    // step 3 `Let t be dateObject.[[DateValue]]` precedes its ToNumber steps;
    // test262 `date-value-read-before-tonumber-when-date-is-{valid,invalid}.js`):
    // a `valueOf` that calls `setTime` on this very date is observed by the
    // coercion and forgotten by the setter, whose result derives from `t`. So
    // `t` is read first and put back before the member computes from it -- and
    // an invalid `t` returns NaN WITHOUT writing (step 5 precedes the store),
    // so a time value the coercion installed on an Invalid Date stays. The two
    // full-year setters are the exception the language states (21.4.4.21 step
    // 5: "If t is NaN, set t to +0"): they proceed from the value read first,
    // and the member computes +0 from the NaN put back.
    const locals = numbers.map((number, index) => `const double __gea_n${index} = ${number}; `).join('')
    return (
      `([&]() -> double { const double __gea_t = ${receiverText}->getTime(); ${locals}` +
      `${member === 'setFullYear' || member === 'setUTCFullYear' ? '' : 'if (std::isnan(__gea_t)) return __gea_t; '}${receiverText}->setTime(__gea_t); ` +
      `return ${receiverText}->${member}(${numbers.map((_, index) => `__gea_n${index}`).join(', ')}); })()`
    )
  }

/**
 * `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` --
 * ECMA-262 21.4.4.38-40.
 *
 * The zero-argument form renders; a call passing `locales`/`options` refuses
 * BY NAME. This runtime carries no ECMA-402 locale data, so honoring them is
 * impossible, and accepting and ignoring them (which is what v1 does, through
 * a variadic template) answers a different format than the program asked for
 * -- a green result concealing a degraded path.
 */
const localeText: DateRenderer = (_ctx, receiverText, args, member) => {
  if (args.length !== 0) {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${member}`,
      `"Date.prototype.${member}" is implemented only in its argument-less form; this call passes ${args.length} ` +
        '(`locales`/`options`), and this runtime carries no ECMA-402 locale data to honor them with -- accepting and ' +
        'ignoring them would answer a different format than the call asked for'
    )
  }
  return `${receiverText}->${member}()`
}

/**
 * `Date.prototype.toJSON` -- ECMA-262 21.4.4.37.
 *
 * Step 3 answers **null** when the time value is not finite, and step 4
 * answers the ISO string otherwise -- so the member's real result type is
 * `string | null`. `lib.es5.d.ts` declares it `string`, so the checker
 * publishes a bare `string` carrier for every ordinary call, and `std::string`
 * has no null. Rendering it there would answer `""` or `"null"` for an Invalid
 * Date: a wrong answer rather than a missing one.
 *
 * The refusal is therefore conditional on the CARRIER the checker actually
 * published, not on the member's name: a result carried as an optional over a
 * string renders, because that carrier can hold the absence the clause
 * specifies.
 *
 * MEASURED: with stock `lib.es5.d.ts` that branch is unreachable, and every
 * direct `d.toJSON()` refuses. A `const s: string | null = d.toJSON()`
 * annotation does NOT reach it -- the carrier published for the CALL is the
 * declared `string`, and the annotation applies to the binding downstream of
 * it. The branch is kept for a declaration that publishes the clause's real
 * `string | null`, and is written here rather than left implicit so the
 * refusal above stays a statement about the carrier and not about the member.
 *
 * `JSON.stringify(d)` is unaffected and answers node's bytes exactly: it never
 * reaches this renderer, because the null is expressible in the DOCUMENT --
 * `gea_runtime.h`'s own `gea_json_write` overload writes `null` for a
 * non-finite time value.
 */
const toJsonText = (ctx: EmitContext, receiverText: string, args: readonly IrOperand[], result: Representation): string => {
  if (args.length > 1) {
    throw createCppEmitBlockedError(
      'host-invocation:Date.prototype.toJSON',
      `"Date.prototype.toJSON" takes at most one key argument; this call passes ${args.length}`
    )
  }
  if (result.kind === 'optional' && result.payload.kind === 'string') {
    return `(std::isfinite(${receiverText}->getTime()) ? ${cppTypeOf(result)}(${receiverText}->toISOString()) : ${cppTypeOf(result)}())`
  }
  void ctx
  throw createCppEmitBlockedError(
    'host-invocation:Date.prototype.toJSON',
    `"Date.prototype.toJSON" publishes a "${representationKey(result)}" result, and ECMA-262 21.4.4.37 step 3 answers null for a ` +
      'non-finite time value. `lib.es5.d.ts` declares the member `string`, which is a carrier with no null, so rendering it ' +
      'would answer an empty string for an Invalid Date instead of the specified null. A call whose result is carried as an ' +
      'optional over a string renders'
  )
}

/** Every zero-argument getter, each named exactly as `gea::runtime::Date` spells it. */
export const dateGetters: readonly string[] = [
  'getTime',
  'valueOf',
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'getTimezoneOffset',
  'getUTCFullYear',
  'getUTCMonth',
  'getUTCDate',
  'getUTCDay',
  'getUTCHours',
  'getUTCMinutes',
  'getUTCSeconds',
  'getUTCMilliseconds'
]

/** The zero-argument string forms. `toLocale*` are not here: they take arguments this backend refuses rather than ignores. */
export const dateStringForms: readonly string[] = ['toISOString', 'toString', 'toDateString', 'toTimeString', 'toUTCString']

/** Each setter, with the maximum number of arguments `lib.es5.d.ts` declares for it. */
export const dateSetters: ReadonlyMap<string, number> = new Map([
  ['setTime', 1],
  ['setFullYear', 3],
  ['setMonth', 2],
  ['setDate', 1],
  ['setHours', 4],
  ['setMinutes', 3],
  ['setSeconds', 2],
  ['setMilliseconds', 1],
  ['setUTCFullYear', 3],
  ['setUTCMonth', 2],
  ['setUTCDate', 1],
  ['setUTCHours', 4],
  ['setUTCMinutes', 3],
  ['setUTCSeconds', 2],
  ['setUTCMilliseconds', 1]
])

const dateMethods: ReadonlyMap<string, DateRenderer> = new Map<string, DateRenderer>([
  ...dateGetters.map((member): [string, DateRenderer] => [member, nullaryText]),
  ...dateStringForms.map((member): [string, DateRenderer] => [member, nullaryText]),
  ...[...dateSetters].map(([member, maximum]): [string, DateRenderer] => [member, setterText(maximum)]),
  ['toLocaleString', localeText],
  ['toLocaleDateString', localeText],
  ['toLocaleTimeString', localeText]
])

/**
 * The keys `dateMemberText` may defer -- one authority for "is this method
 * implemented", exactly as `stringPrototypeMethods` is for its family.
 *
 * `toJSON` is deferred even though its ordinary carrier refuses: the refusal
 * is a property of the CALL's published result, so it has to be reached at the
 * call to be stated accurately, and refusing at the access would say "not
 * implemented" about something that is.
 */
export const datePrototypeMethods: ReadonlySet<string> = new Set([...dateMethods.keys(), 'toJSON'])

/**
 * `Date.prototype` members this backend states no rendering for, each with the
 * reason -- "not built yet" and "cannot be built without X" are different
 * answers, and only the second tells you what to build.
 */
export const dateMemberRefusals: ReadonlyMap<string, string> = new Map([
  [
    'getYear',
    'ECMA-262 B.2.3.1, an Annex B legacy member (the year minus 1900). `gea::runtime::Date` could carry it, but ' +
      '`lib.es5.d.ts` does not declare it on `Date` at all, so no ordinary TypeScript program can reach it and there is ' +
      'nothing here to be right about'
  ],
  ['setYear', 'ECMA-262 B.2.3.2, the Annex B twin of `getYear` and undeclared in `lib.es5.d.ts` for the same reason'],
  [
    'toGMTString',
    'ECMA-262 B.2.3.3, an Annex B alias of `toUTCString` that `lib.es5.d.ts` does not declare; write `toUTCString`, which is implemented'
  ],
  [
    'constructor',
    "reading a Date's constructor yields the `Date` constructor OBJECT, and this backend has no first-class value for a " +
      'native constructor -- `new Date(...)` is rendered at the construction, not through a materialized callable'
  ]
])

/**
 * A `[[Get]]` off a Date receiver: defer a claimed method, refuse anything
 * else by name.
 *
 * A NON-constant key answers `null` rather than refusing, so the access falls
 * through to `emit-dynamic-properties.ts`'s native sidecar -- `d[k]` on a Date
 * keeps the native carrier and reads the expando table keyed on this object's
 * own address, which is the sanctioned answer for a native type that needs
 * arbitrary properties (`gea::runtime::regex::Pattern` is the reference
 * implementation, and `gea::runtime::Date` declares the same
 * `gea_readOwnField`/`gea_writeOwnField`/`gea_ownFieldKeys` protocol). Boxing
 * the Date to make such an access compile is the forbidden shortcut.
 */
/** Whether a Date member read is a deferred `Date.prototype` method read. Stated once; the renderer and the prototype-read walk both ask it. */
export const deferredDateMethodClaim = (
  // Every caller passes `ctx.staticKeyTexts`; named for that so nobody hands
  // this the render-widened `ctx.constantTexts` by mistake.
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  if (!isDateCarrier(receiver.representation)) return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !datePrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'date', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

export const dateMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: string | null): string | null => {
  const carrier = receiver.representation
  if (!isDateCarrier(carrier)) return null
  // A claim, not a fold: this decides whether the access is a STATIC member at
  // all (falls through to the dynamic sidecar below when it is not), so it
  // must not see a key text `constantTexts` only holds because the render
  // minted it (e.g. a folded `typeof` result reaching here via `d[typeof x]`).
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  if (deferredDateMethodClaim(ctx.staticKeyTexts, receiver, key) === null) {
    const stated = dateMemberRefusals.get(staticKey)
    throw createCppEmitBlockedError(
      `property-access:${representationKey(carrier)}:get:false`,
      stated !== undefined
        ? `"${staticKey}" is a Date member this backend states no rendering for: ${stated}`
        : `"${staticKey}" is not a member of \`Date.prototype\` this backend implements -- only ` +
            `${[...datePrototypeMethods].sort().join(', ')} are`
    )
  }
  if (carrier.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${staticKey}`,
      `a Date receiver carries ownership "${carrier.ownership}"; a Date is a MUTABLE object whose setters must be observable ` +
        'through every reference to it, so this backend renders member calls only through the shared identity'
    )
  }
  if (result === null) {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${staticKey}`,
      `"${staticKey}" is a Date.prototype method, and this access publishes no value for its call to consume`
    )
  }
  // The read itself is recorded by the prototype-read walk, which asked the
  // same claim before this body rendered.
  return ''
}

/** The call text for a deferred `Date.prototype` read. */
export const dateCallText = (ctx: EmitContext, member: string, receiverText: string, operation: CallOperation): string => {
  if (member === 'toJSON') {
    // A call with no published result cannot be asked what carrier it means to
    // hold the ISO string in, and `toJSON`'s whole refusal is about that
    // carrier (see `toJsonText`), so an unpublished one refuses rather than
    // being guessed at.
    if (!operation.result) {
      throw createCppEmitBlockedError(
        'host-invocation:Date.prototype.toJSON',
        '"Date.prototype.toJSON" publishes no result, and its rendering is decided by the result carrier'
      )
    }
    return toJsonText(ctx, receiverText, operation.arguments, operation.result.representation)
  }
  const render = dateMethods.get(member)
  if (!render) {
    throw createCppEmitBlockedError(
      `host-invocation:Date.prototype.${member}`,
      `"${member}" was recorded as a deferred Date.prototype read but this file renders no call for it`
    )
  }
  return render(ctx, receiverText, operation.arguments, member)
}

/**
 * `new Date(...)` -- ECMA-262 21.4.2.1.
 *
 * The fourth member of `emit-callable.ts`'s `emitTypedArrayConstruct` /
 * `emitArrayConstruct` / `emitKeyedCollectionConstruct` family, and here for
 * the identical structural reason: `DateConstructor`'s checker overload set is
 * `new ()`, `new (value: number | string)`, `new (value: number | string |
 * Date)` and `new (year, monthIndex, ...)`, which have no single physical
 * frame, so `representation/host-abi.ts`'s `widestSubsumingAbi` correctly
 * refuses to join them and `derive.ts` leaves `.construct` null. This reads
 * the construction's own arguments instead.
 *
 * Four forms render, one per constructor `gea::runtime::Date` declares:
 * zero arguments (now), one number (a time value), one string (parsed), and
 * two-to-seven numbers (local calendar components). `new Date(someDate)` --
 * the copy overload -- is refused BY NAME rather than rendered as a copy: it
 * is `ToPrimitive(value)` per 21.4.2.1 step 4, and a shared_ptr copy would
 * alias the ORIGINAL, so a mutation through one would be observable through
 * the other. That is a silently different program, not a missing one.
 */
export const emitDateConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'native-record-ref' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      'host-invocation:Date.construct',
      `a Date allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const name = defineValue(ctx, operation.result)
  const args = operation.arguments
  if (args.length === 0) {
    lines.push(`${name} = gea::makeRef<${cppDateType}>();`)
    return
  }
  const first = args[0]
  if (args.length === 1 && first) {
    const carrier = first.representation
    if (carrier.kind === 'string') {
      lines.push(`${name} = gea::makeRef<${cppDateType}>(${operandText(ctx, first)});`)
      return
    }
    if (carrier.kind === 'scalar' && carrier.domain === 'number') {
      lines.push(`${name} = gea::makeRef<${cppDateType}>(${operandText(ctx, first)});`)
      return
    }
    throw createCppEmitBlockedError(
      'host-invocation:Date.construct',
      `constructs a Date from a single "${representationKey(carrier)}" argument; ECMA-262 21.4.2.1 step 4 applies ` +
        'ToPrimitive to it, and only a number (a time value) and a string (parsed) are rendered here -- `new Date(otherDate)` ' +
        'in particular is refused rather than rendered as a pointer copy, which would ALIAS the original instead of copying it'
    )
  }
  if (args.length > 7) {
    throw createCppEmitBlockedError(
      'host-invocation:Date.construct',
      `constructs a Date from ${args.length} arguments; ECMA-262 21.4.2.1 declares at most seven (year, monthIndex, date, hours, minutes, seconds, ms)`
    )
  }
  const components = args.map((argument, index) => {
    const carrier = argument.representation
    if (carrier.kind !== 'scalar' || carrier.domain !== 'number') {
      throw createCppEmitBlockedError(
        'host-invocation:Date.construct',
        `constructs a Date whose component ${index} carries "${representationKey(carrier)}", not a number scalar; ` +
          'the calendar-component form of ECMA-262 21.4.2.1 applies ToNumber to each, and this backend states no such conversion here'
      )
    }
    return operandText(ctx, argument)
  })
  lines.push(`${name} = gea::makeRef<${cppDateType}>(${components.join(', ')});`)
}

/**
 * `Date.parse(s)` and `Date.UTC(...)` -- ECMA-262 21.4.3.2 / 21.4.3.4.
 *
 * Registered as the `DateConstructor` protocol's call-site renderer
 * (`emit-host-invoke.ts`'s `hostMemberRenderers`), for the reason that
 * mechanism exists: `Date.UTC` takes one to seven arguments, and the fixed
 * `arity` a `hostMembers` template row states cannot express that.
 *
 * `Date.now()` is deliberately NOT here. It is a real readable
 * `gea::CallableObject<double()>` in `gea_runtime.h`, so its row stays a
 * `property` and its call goes through that callable carrier -- rendering it
 * as a free function here would be a second spelling of a member that already
 * has one.
 */
export const dateConstructorCallText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  if (member === 'parse') {
    const source = operation.arguments[0]
    if (operation.arguments.length !== 1 || !source) {
      throw createCppEmitBlockedError(
        'host-member-call:DateConstructor.parse',
        `"Date.parse" takes one string argument (ECMA-262 21.4.3.2); this call passes ${operation.arguments.length}`
      )
    }
    if (source.representation.kind !== 'string') {
      throw createCppEmitBlockedError(
        'host-member-call:DateConstructor.parse',
        `"Date.parse" argument 0 carries "${representationKey(source.representation)}", not a string; 21.4.3.2 applies ToString to it, ` +
          'and this backend states no such conversion here'
      )
    }
    return `${cppDateType}::parse(${operandText(ctx, source)})`
  }
  if (member === 'UTC') {
    const args = operation.arguments
    if (args.length === 0 || args.length > 7) {
      throw createCppEmitBlockedError(
        'host-member-call:DateConstructor.UTC',
        `"Date.UTC" takes one to seven arguments (ECMA-262 21.4.3.4); this call passes ${args.length}`
      )
    }
    const components = args.map((argument, index) => {
      const carrier = argument.representation
      if (carrier.kind !== 'scalar' || carrier.domain !== 'number') {
        throw createCppEmitBlockedError(
          'host-member-call:DateConstructor.UTC',
          `"Date.UTC" argument ${index} carries "${representationKey(carrier)}", not a number scalar; 21.4.3.4 applies ToNumber to each, ` +
            'and this backend states no such conversion here'
        )
      }
      return operandText(ctx, argument)
    })
    return `${cppDateType}::UTC(${components.join(', ')})`
  }
  throw createCppEmitBlockedError(
    `host-member-call:DateConstructor.${member}`,
    `"DateConstructor.${member}" is claimed with a call-site spelling, and only "parse" and "UTC" have one here ` +
      '-- `now` is a readable callable and renders through its own carrier'
  )
}
