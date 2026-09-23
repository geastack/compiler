import type { Ownership, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { isNativeCallableCarrier } from '../../representation/callable-object.js'
import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type {
  DefineOwnPropertyOperation,
  DeleteOperation,
  GetOperation,
  HasPropertyOperation,
  IrOperand,
  SetOperation
} from '../../ir/model.js'
import { createCppEmitBlockedError, defineValue, operandText, type EmitContext, type PrototypeMethodRead } from './emit-context.js'
import { cppAbiParameterType, cppRecordFieldName, cppResultTypeOf, cppStringLiteral, cppTypeOf } from './types.js'
import { intrinsicMemberValueOf } from './host/emit-host-object.js'
import { toStringText } from './emit-tostring.js'
import {
  alignedValueText,
  convertedValueText,
  dynamicCarrierBoxText,
  dynamicTagFor,
  recipeText,
  unboxedLoadText,
  widenedStoreText
} from './emit-narrowing.js'
import { dictionaryTableOf } from './emit-properties.js'
import { keyedTableKeyText, memberAccessOperator, recordIndexSidecarTableOf, recordIndexAttributeKeyText } from './emit-carrier-members.js'
import { declaredRecordFieldOf, recordFieldsOfShape, recordIndexesOfShape } from './records.js'
import { classStaticFieldStorageKeysOf, classMemberOf } from './class-layout.js'
import { classConstructorStaticMemberTextFor, computedClassPrototypeMethodText } from './class-properties/emit-class-properties.js'
import { hostMemberOf } from './host/host-members.js'
import { objectShapePrototypeMethods } from '../../projection/callee.js'
import { cppRegExpNativeTypes } from './regexp-types.js'
import { arrayPrototypeMethods } from './prototype/emit-prototype-array.js'
import { nativeAbsentPropertyReadOf } from '../../ir/native-absent-property.js'

/**
 * Property access over a genuinely dynamic receiver, and over the dynamic
 * half of a receiver that is otherwise native.
 *
 * Two situations, one machine. A value the program itself declared `any` or
 * `unknown` and never narrowed is carried as `gea::Value`, and its properties
 * live in the `gea::DynamicObject` that box owns -- that is a real dynamic
 * boundary, one of the four `representation/model.ts` admits, and the honest
 * answer for it is a real property table rather than a refusal. A value that
 * DOES have a static type but is used dynamically (`(store as any)[key] = v`
 * on a class instance) is the opposite case: its storage stays exactly the
 * native struct it was, and the dynamic key goes into a `gea::DynamicObject`
 * SIDECAR beside the declared fields. Boxing the receiver to make the write
 * compile is the forbidden shortcut, and the sidecar is what makes refusing it
 * cost nothing.
 *
 * The two share this file because they share every hard part: turning a key
 * operand into a `gea::PropertyKey`, deciding what a read of an absent
 * property produces, and reconciling a statically-typed value into a boxed
 * slot on the way in. Splitting them would be two copies of one rule.
 */

/**
 * A key operand as a `gea::PropertyKey`.
 *
 * A key is a String or a Symbol and nothing else (ECMA-262 6.1.7), so this is
 * a two-way decision plus the ToPropertyKey conversions that feed it. A
 * constant key is already the canonical text the language's own
 * ToPropertyKey would produce -- `producers/properties.ts` spells `o[0]` and
 * `o["0"]` identically for exactly that reason -- so it renders as a literal
 * with no runtime conversion at all.
 *
 * A numeric key converts through the same `toStringText` every other ToString
 * in this backend goes through, because ToPropertyKey of a Number *is*
 * ToString of it. A carrier that is neither string, symbol nor number is
 * refused by name: `ToPropertyKey` on an arbitrary object runs `ToPrimitive`,
 * which can call user code, and no such dispatch is installed.
 */
const propertyKeyCarrierText = (ctx: EmitContext, carrier: Representation, text: string, contextDescription: string): string => {
  if (carrier.kind === 'null' || carrier.kind === 'undefined') {
    return `gea::PropertyKey::string(${cppStringLiteral(carrier.kind)})`
  }
  if (carrier.kind === 'string') return `gea::PropertyKey::string(${text})`
  if (carrier.kind === 'symbol') return `gea::PropertyKey::symbol(${text})`
  if (carrier.kind === 'scalar') {
    if (carrier.domain !== 'boolean' && carrier.domain !== 'bigint') return `gea::PropertyKey::number(static_cast<double>(${text}))`
    const converted = toStringText(text, carrier, ctx.classes, ctx.deriver)
    if (converted !== null) return `gea::PropertyKey::string(${converted})`
  }
  if (carrier.kind === 'optional') {
    const present = propertyKeyCarrierText(ctx, carrier.payload, `(*${text})`, contextDescription)
    return `(${text}.has_value() ? ${present} : ` + `gea::PropertyKey::string(${cppStringLiteral(carrier.absence)}))`
  }
  if (carrier.kind === 'tagged-union') {
    const arms = carrier.arms.map((arm, index) => propertyKeyCarrierText(ctx, arm.value, `${text}.get<${index}>()`, contextDescription))
    const dispatched = arms.reduceRight<string>(
      (rest, arm, index) => (index === arms.length - 1 ? arm : `${text}.is<${index}>() ? ${arm} : (${rest})`),
      ''
    )
    if (dispatched !== '') return arms.length > 1 ? `(${dispatched})` : dispatched
  }
  // A BOXED key. ToPropertyKey's ToPrimitive step is the identity for every
  // primitive a box can hold, and the box's own tag says which one it holds --
  // so `gea::host::toPropertyKey` (gea_runtime.h) renders 7.1.19 exactly for
  // those, and aborts by name for the one payload that genuinely needs the
  // dispatch this backend has none of (an Object or Function, whose
  // ToPrimitive calls user code). three's `uuid in _materialCache` and
  // `u.id in values` are the shape: both operands are values the JS source
  // never typed, and refusing the KEY refused the whole operator.
  if (carrier.kind === 'dynamic') return `gea::host::toPropertyKey(${text})`
  throw createCppEmitBlockedError(
    `runtime-helper:computation:to-property-key:${carrier.kind}`,
    `${contextDescription} is keyed by a "${carrier.kind}" carrier; ToPropertyKey over one runs ToPrimitive, which can call ` +
      'user code, and no such dispatch is installed -- only string, symbol and numeric keys are rendered'
  )
}

export const propertyKeyText = (ctx: EmitContext, key: IrOperand, contextDescription: string): string => {
  const staticKey = ctx.constantTexts.get(key.value)
  if (staticKey !== undefined) return `gea::PropertyKey::string(${cppStringLiteral(staticKey)})`
  return propertyKeyCarrierText(ctx, key.representation, operandText(ctx, key), contextDescription)
}

/**
 * The head of a name-comparison chain over a RUNTIME key: declares the
 * `std::string` the chain's `__gea_key == "..."` arms compare.
 *
 * A `string` carrier is that string outright. A `symbol`, a `string | symbol`
 * union (test262's `verifyProperty(obj, name, ...)` carries `name` so, because
 * it spells a symbol's description into its messages) or an optional of either
 * goes through `gea::PropertyKey` first -- the one renderer that already
 * dispatches every key carrier, so a carrier it refuses is refused here by the
 * same name -- and a symbol answers `symbolAnswer` before the chain runs. That
 * is the honest answer for every chain this heads: a record layout's fields,
 * an intrinsic's classified member table and a builtin function's own
 * `name`/`length` are string-keyed without exception, so no arm could ever
 * match a symbol. (`Math[Symbol.toStringTag]` is real but the intrinsic table
 * deliberately holds no symbol-keyed member -- see `hostIntrinsicMembersOf`.)
 */
export const stringKeyPreludeText = (ctx: EmitContext, key: IrOperand, contextDescription: string, symbolAnswer: string): string => {
  if (key.representation.kind === 'string') return `const std::string& __gea_key = ${operandText(ctx, key)};`
  return (
    `const gea::PropertyKey __gea_property_key = ${propertyKeyText(ctx, key, contextDescription)}; ` +
    `if (__gea_property_key.isSymbol()) return ${symbolAnswer}; const std::string& __gea_key = __gea_property_key.text();`
  )
}

/**
 * The receiver expression a property table is reached through, or `null` when
 * this receiver has no table at all.
 *
 * A `dynamic` receiver IS the table's owner: `gea::Value` carries the
 * `DynamicObject` and answers the four internal methods directly. Every other
 * carrier answers `null` here and is picked up by `nativeSidecarGetText` /
 * `emitNativeSidecarSet` below instead, which reach the object's declared
 * members through the field dispatcher `records.ts` renders and its
 * undeclared ones through `gea::detail::expandoFor`. The split is the point:
 * only a value the program itself declared dynamic is CARRIED as one.
 */
const dynamicReceiverText = (ctx: EmitContext, receiver: IrOperand): string | null =>
  receiver.representation.kind === 'dynamic' ? operandText(ctx, receiver) : null

/**
 * Reading a property of a genuinely dynamic receiver.
 *
 * The result of `[[Get]]` on a value whose type the program never stated is
 * usually a value whose type the program never stated, and the box comes back
 * as it is. But a narrowing can state one: `Array.isArray(v)` proves `v` is
 * `any[]`, and `v.length` inside that branch is a `number` the checker really
 * did settle. That result reads through the tag-checked unboxing load
 * `convertedValueText` installs -- which ABORTS BY NAME on a box holding
 * something else, rather than reinterpreting its bytes -- so the narrowing's
 * claim is enforced at the read instead of assumed.
 *
 * A carrier that load has no answer for is still refused here rather than
 * `static_cast`-ed into a plausible wrong answer.
 */
export const dynamicGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = dynamicReceiverText(ctx, operation.receiver)
  if (receiver === null) return null
  const read = `${receiver}.getProperty(${propertyKeyText(ctx, operation.key, 'a "get" on a dynamic receiver')})`
  const produced = operation.result.representation
  if (produced.kind === 'dynamic') return read
  // `read` is a call, not an already-materialized SSA name: on a Proxy
  // receiver it invokes the trap, which is user code with its own
  // observable effects (`log.push(...)` in the measured case). Every
  // rendering path below this point -- `unboxedLoadText`'s `optional` case
  // is the one that fired here -- assumes exactly the opposite, the same
  // invariant `widenedStoreText` states in its own `dynamic` branch
  // ("`text` is read once per arm ... `operandText` answers an
  // already-materialized SSA name, never an expression with effects"), and
  // freely substitutes its `text` argument more than once when a carrier
  // needs both a presence test and a payload load (`tag() == Undefined ?
  // ... : ...(unboxValue(text, ...))`). Handed the raw call, that duplicates
  // the `[[Get]]` itself: one JS property read became two -- four for two
  // reads -- invoking a Proxy `get` trap twice per access.
  // Binding the call to a lambda PARAMETER evaluates it exactly once no
  // matter how many times the converted text below repeats the parameter's
  // name, the same fix `unboxedLoadText`'s own callable-ABI branch already
  // uses for an unrelated case of this identical hazard.
  const materialized = 'gea_get_result'
  const converted = alignedValueText(
    ctx,
    'emit-dynamic-properties.ts:170',
    { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    produced,
    materialized
  )
  if (converted !== null) return `[](const gea::Value& ${materialized}) -> ${cppTypeOf(produced)} { return ${converted}; }(${read})`
  throw createCppEmitBlockedError(
    `conversion:${representationKey({ kind: 'dynamic', reason: 'declared-any-never-narrowed' })}->${representationKey(produced)}`,
    `a "get" on a dynamic receiver publishes a "${produced.kind}" carrier; unboxing a dynamic property read into a concrete ` +
      'carrier needs a tag-checked conversion, which is not installed'
  )
}

/**
 * The value a store writes, reconciled against the boxed slot it lands in.
 *
 * This is the one direction the no-boxing rule permits, and it permits it
 * because the DESTINATION is the dynamic thing: a property of an object the
 * program declared `any` really does hold anything, so writing a `double` into
 * one is a widening the language itself performs. `widenedStoreText` is the
 * same reconciliation a binding cell and a struct member already use
 * (`emit-narrowing.ts`), asked here for a slot rather than for a field, so
 * there is one table of "which carrier boxes under which tag" and not two.
 *
 * A carrier `dynamicTagFor` has no tag for is refused by name -- an iterator,
 * a promise, a proxy. Those are real gaps in the box, not values to guess a
 * tag for.
 */
export const boxedValueText = (ctx: EmitContext, value: IrOperand, contextDescription: string): string => {
  const text = operandText(ctx, value)
  if (value.representation.kind === 'dynamic') return text
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const widened = widenedStoreText(boxed, value.representation, text)
  if (widened !== null) return widened
  throw createCppEmitBlockedError(
    `conversion:${representationKey(value.representation)}->${representationKey(boxed)}`,
    `${contextDescription} writes a "${value.representation.kind}" carrier into a dynamic property, and this backend has no ` +
      'box tag for that carrier'
  )
}

/**
 * Writing a property of a genuinely dynamic receiver.
 *
 * The store's own result -- when the program reads one -- is the receiver
 * threaded onward, exactly as a struct field store publishes the object it
 * wrote into (`emit-properties.ts`'s `emitFieldStore`). A `[[Set]]` nominally
 * returns a success boolean, but that boolean is only observable under strict
 * mode's false-to-throw rule. `Value::reflectSet` is the existing runtime
 * spelling that preserves that boolean; `Value::setProperty` deliberately
 * discards it and is therefore only suitable for callers that have already
 * chosen sloppy behavior. What a consumer of an assignment expression reads
 * is still the assigned object.
 */
export const emitDynamicSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const receiver = dynamicReceiverText(ctx, operation.receiver)
  if (receiver === null) return false
  const key = propertyKeyText(ctx, operation.key, 'a "set" on a dynamic receiver')
  const set = `${receiver}.reflectSet(${key}, ${boxedValueText(ctx, operation.value, 'a "set" on a dynamic receiver')}, ${receiver})`
  if (operation.kind === 'set' && operation.strict) {
    lines.push(`if (!${set}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read-only property");`)
  } else {
    lines.push(`(void)${set};`)
  }
  if (operation.result && operation.result.representation.kind !== 'void') {
    // The receiver is boxed while the result is typed from the receiver's
    // static type (`module.exports`, typed as the function it was assigned),
    // so threading it onward is a conversion like any other, never a copy.
    const threaded = convertedValueText(operation.receiver.representation, operation.result.representation, receiver)
    if (threaded === null)
      throw createCppEmitBlockedError(
        `conversion:${representationKey(operation.receiver.representation)}->${representationKey(operation.result.representation)}`,
        'a "set" on a dynamic receiver threads the receiver onward as its result, and no conversion reaches the result carrier'
      )
    lines.push(`${defineValue(ctx, operation.result)} = ${threaded};`)
  }
  return true
}

/**
 * `delete obj[k]` over a dynamic receiver.
 *
 * The operator's own result is the boolean `[[Delete]]` returns -- "the
 * property is gone", which includes "was never there" -- so unlike `[[Set]]`
 * this one really is published when the program reads it.
 */
/** Render the one [[Delete]] outcome, preserving strict-mode's false-to-throw rule. */
const emitDeleteOutcome = (ctx: EmitContext, lines: string[], operation: DeleteOperation, outcome: string): void => {
  if (operation.result) {
    const produced = operation.result.representation
    if (produced.kind !== 'scalar' || produced.domain !== 'boolean') {
      throw createCppEmitBlockedError(
        `runtime-helper:computation:delete-result:${representationKey(produced)}`,
        `a "delete" publishes a "${produced.kind}" carrier; the operator's result is the boolean [[Delete]] returns and nothing else`
      )
    }
    const checked = operation.strict
      ? `([&]() -> bool { if (!(${outcome})) gea::host::throwRuntimeError("TypeError", "Cannot delete non-configurable property"); return true; })()`
      : outcome
    lines.push(`${defineValue(ctx, operation.result)} = ${checked};`)
    return
  }
  if (operation.strict) {
    lines.push(`if (!(${outcome})) gea::host::throwRuntimeError("TypeError", "Cannot delete non-configurable property");`)
    return
  }
  lines.push(`${outcome};`)
}

export const emitDynamicDelete = (ctx: EmitContext, lines: string[], operation: DeleteOperation): boolean => {
  const receiver = dynamicReceiverText(ctx, operation.receiver)
  if (receiver === null) return false
  const key = propertyKeyText(ctx, operation.key, 'a "delete" on a dynamic receiver')
  const call = `${receiver}.deleteProperty(${key})`
  emitDeleteOutcome(ctx, lines, operation, call)
  return true
}

/** `k in obj` over a dynamic receiver -- ECMA-262 13.10.2, which is `[[HasProperty]]` including the prototype chain. */
export const emitDynamicHasProperty = (ctx: EmitContext, lines: string[], operation: HasPropertyOperation): boolean => {
  const receiver = dynamicReceiverText(ctx, operation.receiver)
  if (receiver === null) return false
  const key = propertyKeyText(ctx, operation.key, 'an "in" test on a dynamic receiver')
  lines.push(`${defineValue(ctx, operation.result)} = ${receiver}.hasProperty(${key});`)
  return true
}

/**
 * `delete o.p` as an EXPRESSION.
 *
 * The removal itself is the `[[Delete]]` the property operation already
 * performed; this computation is only the report of its outcome (ECMA-262
 * 13.5.1.2 step 5), whose value is that operation's boolean result. So
 * forwarding the operand is the whole semantics, exactly as unary `void`'s
 * result is settled without consulting a carrier.
 *
 * The operand is CHECKED to be that boolean rather than assumed. An operand of
 * any other carrier means the `[[Delete]]`'s own result was published with the
 * wrong type -- a defect in the producer, which is where it gets fixed -- and
 * coercing it here would hide exactly that.
 */
export const emitUnaryDelete = (ctx: EmitContext, lines: string[], result: string, operand: IrOperand): void => {
  const produced = operand.representation
  if (produced.kind !== 'scalar' || produced.domain !== 'boolean') {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:delete-result:${representationKey(produced)}`,
      `unary "delete" received a "${produced.kind}" operand; the operator's value is the boolean its [[Delete]] published`
    )
  }
  lines.push(`${result} = ${operandText(ctx, operand)};`)
}

/**
 * The receiver of a native sidecar access, or `null` when this is not one.
 *
 * A statically typed object reached through a key only known at runtime --
 * `(this as any)[key]`, `(raw as any)[prop]` -- keeps its own C++ type. The
 * receiver text is the `std::shared_ptr<T>` it already was; nothing about this
 * path widens it, which is the whole point. `owned` ownership is refused
 * rather than copied into a box: a by-value struct has no stable identity for
 * the sidecar table to key on, and giving one a private sidecar per copy would
 * be a plausible-looking wrong answer.
 */
const nativeSidecarReceiver = (ctx: EmitContext, receiver: IrOperand, contextDescription: string): string | null => {
  const representation = receiver.representation
  const addressable =
    representation.kind === 'class-ref' ||
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'native-record-ref' ||
    // An Array exotic object's ORDINARY own properties -- everything that is
    // not an index, `length`, or a field its extended interface declares --
    // live in the same identity-keyed expando table, and the runtime already
    // writes into it: `finalizeTemplateObject` installs GetTemplateObject's
    // `raw` there. See `arrayAccessText`'s own comment for why that function
    // defers here rather than stating a table exists or does not.
    representation.kind === 'array-object'
  if (!addressable) return null
  if (representation.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `native-boundary:dynamic-property-sidecar:${representation.ownership}`,
      `${contextDescription} has a "${representation.ownership}" receiver; a dynamic-property sidecar needs the object's own ` +
        'shared identity to key on, which a by-value struct does not have'
    )
  }
  return operandText(ctx, receiver)
}

/** A generated record has complete fixed-field and index hooks; host records deliberately do not impersonate that protocol. */
const generatedNativeSidecarReceiver = (ctx: EmitContext, receiver: IrOperand, contextDescription: string): string | null => {
  const representation = receiver.representation
  const generated =
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'class-ref' ||
    (representation.kind === 'native-record-ref' && representation.native === null)
  return generated ? nativeSidecarReceiver(ctx, receiver, contextDescription) : null
}

/**
 * Whether a constant key names no declared field on a GENERATED record/class
 * shape -- the one question `nativeSidecarGetText`'s get arm and
 * `emitNativeSidecarSet`'s set arm both ask before falling through to their
 * expando-sidecar branch. A host-native record (`representation.native !==
 * null`) answers `false` here on purpose: its declared fields stay with its
 * own protocol-specific interceptor, and treating an undeclared name on one as
 * sidecar-only is what let `(error as any).code = value` fall through to a C++
 * member named `code` that the native Error layout never declared -- see
 * `nativeSidecarGetText`'s own comment for the incident. Stated once so a
 * change to which kinds count as "generated", or to `declaredRecordFieldOf`'s
 * own notion of a declared field, updates both the read and the write arm
 * together instead of one of them silently asking a stale question.
 */
const staticKeyIsSidecarOnly = (ctx: EmitContext, representation: Representation, key: string): boolean => {
  const generated =
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'class-ref' ||
    representation.kind === 'native-record-ref'
  // An Array's own layout answers `length`, a canonical index and the fields
  // its extended interface declares; `arrayAccessText` renders all three and
  // only defers a key that is none of them, so by the time one arrives here it
  // is sidecar-only by construction. Restating that test would be a second
  // opinion that can only ever agree.
  if (representation.kind === 'array-object') return true
  return generated && declaredRecordFieldOf(ctx.deriver, representation, key, ctx.classes) === null
}

/** A Pattern keeps prototype-sensitive dynamic access in its exact native protocol. */
const isPatternSidecarReceiver = (receiver: IrOperand): boolean =>
  receiver.representation.kind === 'native-record-ref' && receiver.representation.native === cppRegExpNativeTypes.pattern

/**
 * OrdinarySet / OrdinaryDelete on a GENERATED object (a record, a class
 * instance) go through the runtime's `nativeDynamicSet` / `nativeDynamicDelete`
 * exactly like a host object's do -- there is deliberately no emitter-side
 * spelling of the declared-field routing (`gea_matchesOwnField` ->
 * `gea_writeOwnField` / `gea_deleteOwnField`, then the index sidecar, then
 * the expando table). The runtime states that routing once, behind
 * `if constexpr` on the struct's protocol, and `records.ts` declares that
 * protocol only when the reflection census saw a dynamic operation EXECUTE on
 * the struct. A body the callable flow proved never entered is still emitted
 * (see `reflection-demand.ts`: layout and ABI retain every body, only
 * impossible execution contributes no demand), so a set or delete inside it
 * must compile against a struct whose protocol is off. An inline spelling of
 * the same routing did not: @hono/node-server's lightweight `Response`, once
 * nothing constructed it, named `gea_matchesOwnField` on a struct that had
 * never been asked to declare it, and the unit failed to compile on a line
 * the census had correctly proved dead.
 */
const generatedNativeWriteText = (receiver: string, key: string, value: string): string =>
  `gea::nativeDynamicSet(${receiver}, ${key}, ${value})`

const generatedNativeDeleteText = (receiver: string, key: string): string => `gea::nativeDynamicDelete(${receiver}, ${key})`

/**
 * Whether a carrier is one of the five native callable representations that
 * share a `gea::CallableObject`-style identity-owned property table --
 * `callableSidecarReceiver`, `deferredCallableShapeMethodClaim` and
 * `callableSidecarGetText` all gate on exactly this set, and used to spell it
 * three times. A kind added to (or dropped from) the callable family only
 * needs to change here now; before this, a site that missed the update would
 * silently keep treating that kind as non-callable while its siblings moved
 * on -- which is the "two authorities" shape this file's own header warns
 * about, spelled as three copies rather than two.
 */
export { isNativeCallableCarrier } from '../../representation/callable-object.js'

/**
 * A native callable's own-property sidecar.
 *
 * A `CallableObject` is copied by value for its fixed ABI, but every copy of
 * one JavaScript function preserves the same identity-owned property table.
 * The receiver therefore stays callable here; boxing it solely to reach a
 * property table would lose the static call convention the representation
 * proved.
 */
const callableSidecarReceiver = (ctx: EmitContext, receiver: IrOperand): string | null =>
  isNativeCallableCarrier(receiver.representation.kind) ? operandText(ctx, receiver) : null

/** Function.prototype names that this compiler either defers or still refuses, never treats as an expando. */
const nonExpandoFunctionMemberNames = new Set(['call', 'apply', 'bind', 'toString', 'constructor', 'caller', 'arguments', 'prototype'])

/**
 * A fixed own Function property or a statically named callable expando.
 *
 * Computed symbol keys are the one dynamic-keyed subset this native carrier
 * can state: the modeled Function.prototype surface is string-keyed, so a
 * symbol read reaches only the callable's own sidecar. Other computed keys
 * remain refused rather than guessing whether they name `bind`, `call`, or an
 * unimplemented inherited member.
 */
/**
 * Whether a callable's `hasOwnProperty`/`propertyIsEnumerable` is a deferred
 * `Object.prototype` read answered from the shared function-object table.
 *
 * Stated once; `callableSidecarGetText` and the prototype-read walk both ask
 * it. A symbol key reaches the sidecar instead and a computed key cannot know
 * the name, so both are excluded here exactly as they are there.
 */
export const deferredCallableShapeMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const representation = receiver.representation
  if (!isNativeCallableCarrier(representation.kind)) return null
  if (key.representation.kind === 'symbol') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !objectShapePrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'callable-shape', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

export const callableSidecarGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const representation = operation.receiver.representation
  // A function object with no calling convention (`Array.from`, whose four
  // overloads disagree at parameter 0) owns the same identity table as every
  // callable below, and `name`/`length` are the two facts a program can read
  // off it without a frame. Nothing else is spelled: there is no thunk to bind
  // `.call` to, no expando the backend put there, and a computed key would
  // need the `Function.prototype` walk the arms below only reach through a
  // callable -- all of which stay refused, by the manifest and by here.
  if (representation.kind === 'callable-identity') {
    const fact = ctx.staticKeyTexts.get(operation.key.value)
    if (fact !== 'name' && fact !== 'length') return null
    const site = `a Function own-property read of "${fact}"`
    return unboxedReadText(
      operation.result.representation,
      `gea::functionIdentityDynamicGet(${operandText(ctx, operation.receiver)}, ${propertyKeyText(ctx, operation.key, site)})`,
      site
    )
  }
  if (!isNativeCallableCarrier(representation.kind)) return null
  if (operation.key.representation.kind === 'symbol') {
    const site = 'a computed symbol own-property read on a callable'
    return unboxedReadText(
      operation.result.representation,
      `gea::callableDynamicGet(${operandText(ctx, operation.receiver)}, ${propertyKeyText(ctx, operation.key, site)})`,
      site
    )
  }
  // This picks the whole branch below (fixed name/length/prototype vs. the
  // computed-key runtime dispatch), so it must ask `staticKeyTexts` -- a key
  // `constantTexts` only later folds (a render-time `typeof` result) is not a
  // member name the program wrote, and treating it as one would misroute a
  // genuinely computed key into the fixed-member arm.
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) {
    if (representation.kind !== 'function-value-dispatch' && representation.kind !== 'function-and-constructor') return null
    // A runtime string key reaches the one shared function-object table, the
    // way a constant `name`/`length`/expando key does below. What this arm
    // cannot know statically is whether the key names a `Function.prototype`
    // member the backend does not model -- so it asks at runtime and throws
    // rather than answering `undefined` for `fn[k]` with `k === "call"`.
    const site = 'a computed own-property read on a callable'
    const guarded = [...nonExpandoFunctionMemberNames].map((name) => `__gea_name == ${cppStringLiteral(name)}`).join(' || ')
    const read =
      `([&]() -> gea::Value { const gea::PropertyKey __gea_key = ${propertyKeyText(ctx, operation.key, site)}; ` +
      `if (!__gea_key.isSymbol()) { const std::string& __gea_name = __gea_key.text(); if (${guarded}) ` +
      `gea::host::throwRuntimeError("TypeError", "a computed read of Function.prototype's own \"" + __gea_name + "\" on a callable is not rendered by this backend"); } ` +
      `return gea::callableDynamicGet(${operandText(ctx, operation.receiver)}, __gea_key); })()`
    return unboxedReadText(operation.result.representation, read, site)
  }
  if (deferredCallableShapeMethodClaim(ctx.staticKeyTexts, operation.receiver, operation.key) !== null) {
    // `fn.hasOwnProperty(k)` / `fn.propertyIsEnumerable(k)`: Object.prototype
    // reached through the callable, answered at the call from the one shared
    // function-object table (`callableShapeCallText`) -- never read as an
    // expando, which the table does not hold and would unbox as undefined.
    return ''
  }
  // `prototype` is a fixed own Function property for a `function-and-constructor`
  // by its carrier, and for a `function-value-dispatch` only where the read
  // carries the census's proof that the declaration ran `MakeConstructor`
  // (`GetOperation.callableOwnPrototype`). The printer does not re-derive that
  // proof and cannot: by here only the carrier is left, and the carrier
  // answering this was the defect.
  // The census's `prototype` verdict, carried on the read itself
  // (`GetOperation.callableOwnPrototype`) and present at `false` as well as at
  // `true` -- a declaration that provably owns no `prototype` is the same read
  // with the other answer. Only ABSENCE means unproven, and an unproven read
  // never reaches emission: certification refused it. The printer does not
  // re-derive the verdict and cannot -- by here only the carrier is left, and
  // the carrier answering this was the defect.
  if (representation.kind === 'function-value-dispatch' && key === 'prototype' && operation.callableOwnPrototype !== undefined) {
    return unboxedReadText(
      operation.result.representation,
      `gea::callableOwnPrototypeGet(${operandText(ctx, operation.receiver)}, ${operation.callableOwnPrototype ? 'true' : 'false'})`,
      'a Function own-property read of "prototype"'
    )
  }
  const fixed = key === 'name' || key === 'length' || (representation.kind === 'function-and-constructor' && key === 'prototype')
  if (!fixed && nonExpandoFunctionMemberNames.has(key) && key !== 'call' && key !== 'apply' && key !== 'bind') return null
  const site = fixed ? `a Function own-property read of "${key}"` : 'a static callable expando read'
  // Unless the program shadowed it, `fn.apply` is Function.prototype's own
  // builtin, which no typed payload matches. It is called through its box,
  // with `fn` -- the receiver the typed convention passes first -- boxed by
  // its own ABI so a rest or receiver-bearing callable stays one.
  const builtin = builtinCallableMethodText(
    operation.result.representation,
    key,
    () => `gea::callableDynamicGet(${operandText(ctx, operation.receiver)}, ${propertyKeyText(ctx, operation.key, site)})`
  )
  if (builtin !== null) return builtin
  return unboxedReadText(
    operation.result.representation,
    `gea::callableDynamicGet(${operandText(ctx, operation.receiver)}, ${propertyKeyText(ctx, operation.key, site)})`,
    site
  )
}

const builtinCallableMethodText = (produced: Representation, key: string, read: () => string): string | null => {
  if (key !== 'call' && key !== 'apply' && key !== 'bind') return null
  if (produced.kind !== 'function-value-dispatch') return null
  const abi = produced.abi
  const receiver = abi.receiver
  if (receiver === null) return null
  // `CallableFunction.call`'s receiver is the function itself, already adapted
  // to `(thisArg, ...args)` -- the very parameters `call` takes -- so the
  // method is a plain forward, with nothing to box. `apply` is the same
  // forward when the function's own frame is `(this, rest array)`: the array
  // `apply` spreads is exactly the rest array the body binds.
  const parameterTypes = abi.parameters.map(cppAbiParameterType)
  const sameFrame = cppTypeOf(receiver) === `gea::CallableObject<${cppResultTypeOf(abi.result)}(${parameterTypes.join(', ')})>`
  const restFrame =
    key === 'apply' &&
    receiver.kind === 'function-value-dispatch' &&
    receiver.abi.receiver !== null &&
    receiver.abi.restFrom === 0 &&
    receiver.abi.parameters.length === 1 &&
    abi.parameters.length === 2
  if ((key === 'call' || restFrame) && sameFrame) {
    const formals = [cppTypeOf(receiver), ...parameterTypes].map((type, index) => `${type} gea_argument_${index}`)
    const actuals = parameterTypes.map((_, index) => `gea_argument_${index + 1}`)
    return (
      `${cppTypeOf(produced)}(+[](void*, ${formals.join(', ')}) -> ${cppResultTypeOf(abi.result)} { ` +
      `return gea_argument_0.call(${actuals.join(', ')}); }, static_cast<void*>(nullptr))`
    )
  }
  if (abi.restFrom !== null) return null
  const boxes = [receiver, ...abi.parameters.map((parameter) => parameter.value)].map((carrier, index) =>
    carrier.kind === 'dynamic' ? `gea_argument_${index}` : dynamicCarrierBoxText(carrier, `gea_argument_${index}`)
  )
  if (boxes.some((box) => box === null)) return null
  const called = `gea_source->callWithReceiver(${boxes[0]}, {${boxes.slice(1).join(', ')}})`
  const result = cppResultTypeOf(abi.result)
  let body: string
  if (abi.result.kind === 'void') body = `${called};`
  else if (abi.result.kind === 'dynamic') body = `return ${called};`
  else {
    const loaded = unboxedLoadText(abi.result, called)
    if (loaded === null) return null
    body = `return ${loaded};`
  }
  const formals = [cppTypeOf(receiver), ...abi.parameters.map(cppAbiParameterType)].map((type, index) => `${type} gea_argument_${index}`)
  const type = cppTypeOf(produced)
  return (
    `[&]() { const gea::Value gea_builtin = ${read()}; ` +
    `return ${type}(+[](void* gea_environment${formals.map((formal) => `, ${formal}`).join('')}) -> ${result} { ` +
    `alignas(void*) unsigned char gea_slot[sizeof(void*)]; const gea::Value* gea_source = gea::unpackEnvironment<gea::Value>(gea_environment, gea_slot); ${body} }, ` +
    `gea::packEnvironment<gea::Value>(gea_builtin)); }()`
  )
}

/**
 * A dynamic property read landing in a carrier the checker already fixed.
 *
 * `(this as unknown as Record<symbol, StoreState<S>>)[_PRIV]` reads a property
 * dynamically and the expression's type is a record, not `any`. The value came
 * out of the sidecar as a `gea::Value`, so it has to come back -- and the
 * unbox is TAG- AND TYPE-CHECKED (`detail::unboxAs`), because the write that
 * filled the property is a different expression entirely and nothing at this
 * site proves the two agreed. A mismatch aborts by name; it does not silently
 * reinterpret one struct as another.
 *
 * Exported (with `boxedValueText` above) for one other caller:
 * `emit-prototype-regexp.ts`'s `stringObjectMemberText`/
 * `emitStringObjectSet`. A String OBJECT is the one native-record-ref type
 * whose whole point is arbitrary, program-chosen CONSTANT keys as dynamic
 * properties (`escapedString.isEscaped = true`, hono's `utils/html.ts`) --
 * every other native-record-ref type's constant keys are enumerable ahead of
 * time and handled by a per-protocol interceptor that names each one
 * (`regexpMemberText`, `emitDateConstruct`), so `nativeSidecarGetText`/
 * `emitNativeSidecarSet` below have always been free to skip a constant key
 * outright. String's own interceptor cannot rely on that skip -- it has to
 * route ITS constant, non-`length` keys through the identical
 * box/unbox machinery this pair already implements, rather than duplicate it.
 */
export const unboxedReadText = (produced: Representation, text: string, site: string): string => {
  if (produced.kind === 'dynamic') return text
  // Undefined and null have no payload type.  `unboxAs<T>` is intentionally
  // stricter for payload-bearing values, but applying it to these two tags
  // rejects the legitimate default `gea::Value()` absence produced by a
  // missing dynamic property.  Reuse the canonical tag-only loaders from
  // `unboxedLoadText`, preserving refusal for every wrong tag.
  if (produced.kind === 'undefined') return `gea::detail::unboxUndefinedValue(${text}, ${cppStringLiteral(site)})`
  if (produced.kind === 'null') return `gea::detail::unboxNullValue(${text}, ${cppStringLiteral(site)})`
  // A sidecar holds one live JavaScript value, while a tagged union is only
  // the native carrier that records which exact arm it is. This is the AJV
  // `errors?: readonly Error[] | null` path: undefined/null/array are
  // distinct live results, not an optional approximation of one another. Do
  // not use `DynamicCarrier<TaggedUnion>::in` here: that helper is for a CALL
  // argument, where `undefined` means a missing parameter. A property read
  // legitimately returns an `undefined` union arm. `unboxedLoadText` performs
  // an arm-by-arm tag *and payload* decode and builds the matching native arm,
  // with no coercion or reboxing.
  if (produced.kind === 'tagged-union') {
    // The decoder tests and loads the Value in separate expressions. Retain
    // one sidecar result first so an accessor-backed callable property is read
    // once, just as [[Get]] requires.
    const value = '__gea_sidecar_value'
    const decoded = unboxedLoadText(produced, value)
    if (decoded !== null) {
      return `([&]() -> ${cppTypeOf(produced)} { const gea::Value ${value} = ${text}; return ${decoded}; })()`
    }
    throw createCppEmitBlockedError(
      `conversion:${representationKey({ kind: 'dynamic', reason: 'declared-any-never-narrowed' })}->${representationKey(produced)}`,
      `${site} publishes a tagged-union carrier with no exact Value-to-arm decoder`
    )
  }
  // An `optional` result is the property's own absence, not a second carrier
  // to unbox: `Record<string, T>` read under `noUncheckedIndexedAccess` is
  // `T | undefined`, and the missing key is exactly the empty optional.
  if (produced.kind === 'optional') {
    // A record payload is REBUILT, not reinterpreted. `unboxOptional<Ref<R>>`
    // asks the box to already carry that exact C++ struct, which is true only
    // when the value came from this program; a descriptor object the RUNTIME
    // built (`Reflect.getOwnPropertyDescriptor`) is an ordinary dynamic object
    // with the right fields and the wrong payload type, and the assertion
    // aborted at run time. `unboxedLoadText` already renders the field-by-field
    // materialization -- including a fast path that preserves identity when the
    // box does carry the struct -- so the absence stays this branch's question
    // and the payload becomes that function's.
    // A TAGGED-UNION payload is rebuilt for the same reason and by the same
    // decoder. The absence stays this branch's question -- `undefined`/`null`
    // is the optional's own empty state, not an arm -- and what remains is an
    // ordinary union decode, arm by arm, on tag AND payload type. Without
    // this the pair fell through to `dynamicTagFor`, which has no single box
    // tag to name for a union and refused: `@hono/node-server`'s
    // `readBodyBufferedBeforeDisconnect` caches `Buffer | Error` under a
    // symbol key on the incoming message and reads it back as
    // `Buffer | Error | undefined`, which is exactly this shape.
    if (produced.payload.kind === 'record' || produced.payload.kind === 'tagged-union') {
      const value = '__gea_optional_value'
      const load = unboxedLoadText(produced.payload, value)
      if (load !== null) {
        return (
          `([&]() -> ${cppTypeOf(produced)} { const gea::Value ${value} = ${text}; ` +
          `if (${value}.tag() == gea::Value::Tag::Undefined || ${value}.tag() == gea::Value::Tag::Null) return ${cppTypeOf(produced)}(); ` +
          `return ${cppTypeOf(produced)}(${load}); })()`
        )
      }
    }
    const payloadTag = dynamicTagFor(produced.payload)
    if (payloadTag === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey({ kind: 'dynamic', reason: 'declared-any-never-narrowed' })}->${representationKey(produced)}`,
        `${site} publishes an optional over a "${produced.payload.kind}" carrier, which this backend has no box tag for`
      )
    }
    return `gea::detail::unboxOptional<${cppTypeOf(produced.payload)}>(${text}, gea::Value::Tag::${payloadTag}, ${cppStringLiteral(site)})`
  }
  const tag = dynamicTagFor(produced)
  if (tag === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey({ kind: 'dynamic', reason: 'declared-any-never-narrowed' })}->${representationKey(produced)}`,
      `${site} publishes a "${produced.kind}" carrier, and this backend has no box tag to read one back out of a property`
    )
  }
  return `gea::detail::unboxAs<${cppTypeOf(produced)}>(${text}, gea::Value::Tag::${tag}, ${cppStringLiteral(site)})`
}

/**
 * The ownership of a generated record/record-with-index/native-record-ref/
 * class-ref carrier, or `owned` for anything else -- the same question
 * `host/object-protocol.ts` asks of a KNOWN view's own representation, stated
 * once here because that file already imports from this one
 * (`propertyKeyText`) and a second copy on that side of the boundary would be
 * free to answer this differently the next time a "generated shared object"
 * kind is added and only one side is updated for it. `finiteRecordUnionGetText`
 * below is this file's own asker.
 */
export const ownershipOfGeneratedCarrier = (representation: Representation): Ownership =>
  representation.kind === 'record' ||
  representation.kind === 'record-with-index' ||
  representation.kind === 'class-ref' ||
  representation.kind === 'native-record-ref'
    ? representation.ownership
    : 'owned'

/**
 * A computed read whose lowering published a finite fixed-field recipe. The
 * recipe owns the key domain and conversion nodes; this function only renders
 * the already-sealed switch and the field spelling for the native carrier.
 *
 * The old tagged-union path remains below as a migration fallback for reads
 * produced by lowerings that have not published this recipe yet. It keeps the
 * existing unknown-key behavior while the recipe authority is adopted by all
 * property-read producers.
 */
const finiteRecordUnionGetText = (ctx: EmitContext, operation: GetOperation, receiver: string): string | null => {
  const recipe = operation.typedComputedRead
  if (recipe !== undefined && (operation.key.representation.kind === 'string' || recipe.receiverBounded !== undefined)) {
    const produced = operation.result.representation
    if (operation.receiver.representation.kind !== 'record') return null
    if (
      recipe.receiver !== representationKey(operation.receiver.representation) ||
      recipe.result !== representationKey(produced) ||
      (recipe.receiverBounded !== undefined && recipe.receiverBounded.carrier !== representationKey(operation.key.representation))
    ) {
      throw createCppEmitBlockedError(
        'property-access:record:get:typed-computed-read',
        'the sealed computed-read recipe does not match the operation carriers'
      )
    }
    const accessor = memberAccessOperator(operation.receiver.representation.ownership)
    const arms: string[] = []
    for (const arm of recipe.arms) {
      const node = ctx.conversions.nodeById(arm.conversion)
      if (
        node === null ||
        representationKey(node.source) !== representationKey(arm.source) ||
        representationKey(node.target) !== representationKey(produced)
      ) {
        throw createCppEmitBlockedError(
          'property-access:record:get:typed-computed-read',
          `the sealed conversion for field "${arm.key}" no longer matches the read result`
        )
      }
      const read = `${receiver}${accessor}${cppRecordFieldName(arm.key)}`
      const converted = recipeText(ctx, node, read)
      if (converted === null) {
        throw createCppEmitBlockedError(
          'property-access:record:get:typed-computed-read',
          `the sealed conversion for field "${arm.key}" has no renderer`
        )
      }
      arms.push(`if (__gea_key == ${cppStringLiteral(arm.key)}) return ${converted};`)
    }
    if (arms.length > 0) {
      const resultType = cppTypeOf(produced)
      let missing = `gea::host::unreachableValue<${resultType}>()`
      if (recipe.receiverBounded !== undefined) {
        const node = ctx.conversions.nodeById(recipe.receiverBounded.missing)
        if (node === null || node.source.kind !== 'undefined' || representationKey(node.target) !== recipe.result)
          throw createCppEmitBlockedError(
            'property-access:record:get:typed-computed-read',
            'the receiver-bounded read has no matching absence conversion'
          )
        const converted = recipeText(ctx, node, 'gea::Undefined{}')
        if (converted === null)
          throw createCppEmitBlockedError(
            'property-access:record:get:typed-computed-read',
            'the receiver-bounded read absence has no renderer'
          )
        missing = converted
      }
      const key = recipe.receiverBounded === undefined ? operandText(ctx, operation.key) : keyedTableKeyText(ctx, operation.key, 'string')
      return `([&]() -> ${resultType} { const std::string& __gea_key = ${key}; ` + `${arms.join(' ')} return ${missing}; })()`
    }
  }

  // Compatibility route for IR reads lowered before the sealed recipe was
  // introduced (including destructuring and protocol-generated reads). Keep
  // its prior tagged-union condition and conversion behavior intact.
  const produced = operation.result.representation
  if (produced.kind !== 'tagged-union' || operation.key.representation.kind !== 'string') return null
  const representation = operation.receiver.representation
  const fields =
    representation.kind === 'record' || representation.kind === 'record-with-index'
      ? representation.fields
      : representation.kind === 'class-ref' || (representation.kind === 'native-record-ref' && representation.native === null)
        ? recordFieldsOfShape(ctx.deriver, representation.shapeId)
        : null
  if (fields === null || fields.length === 0) return null
  const accessor = memberAccessOperator(ownershipOfGeneratedCarrier(representation))
  const arms: string[] = []
  for (const field of fields) {
    const read = `${receiver}${accessor}${cppRecordFieldName(field.key)}`
    const converted = alignedValueText(ctx, 'emit-dynamic-properties.ts:582', field.value, produced, read)
    if (converted === null) return null
    arms.push(`if (__gea_key == ${cppStringLiteral(field.key)}) return ${converted};`)
  }
  const resultType = cppTypeOf(produced)
  return (
    `([&]() -> ${resultType} { const std::string& __gea_key = ${operandText(ctx, operation.key)}; ` +
    `${arms.join(' ')} return gea::host::unreachableValue<${resultType}>(); })()`
  )
}

/** `[[Get]]` with a runtime key on a receiver that keeps its native type. */
/**
 * `C[key]` with a key only known at runtime, read off the class constructor
 * object itself: the cpn (computed property name) family's
 * `C[String(1)]` after `static [1] = 2`.
 *
 * A constructor object has no expando sidecar to consult -- every property it
 * carries is a static member the layout declares, an assignment-only static
 * the whole-program census gave storage to, or its own `name`/`length` --
 * and all of those are spelled at compile time. So the runtime read is a
 * dispatch over that finite key set, each arm rendered by the SAME per-key
 * renderer a constant-key read uses (`classConstructorStaticMemberTextFor`),
 * with the result boxed: the checker types a computed read of a class
 * constructor as `any`, and an arm that publishes anything narrower is
 * converted through the ordinary tag-checked path at the site. The set is
 * collected along the base chain because `Derived[k]` resolves through
 * `Derived`'s `[[Prototype]]`, the base constructor, exactly as
 * `classStaticMemberOf` walks it for a constant key. A key nothing declares
 * is the language's `undefined`.
 */
const constructorFamilyComputedGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  // Deciding whether THIS function even applies (a constant key defers to
  // `classConstructorStaticMemberText`'s own per-key renderer instead), so the
  // claim is `staticKeyTexts` -- a key `constantTexts` only later folds must
  // never be admitted here as if the program had named a static member.
  if (receiver.kind !== 'constructor-family' || ctx.staticKeyTexts.has(operation.key.value)) return null
  const site = 'a computed "get" on a class constructor'
  const keys = new Set<string>()
  const walked = new Set<DeclarationId>()
  for (const member of receiver.members) {
    let current: DeclarationId | null = member
    while (current !== null && !walked.has(current)) {
      walked.add(current)
      const layout = ctx.classes.get(current)
      if (!layout) break
      for (const field of layout.staticFields) keys.add(field.key)
      for (const method of layout.staticMethods) keys.add(method.key)
      for (const accessor of layout.staticAccessors) keys.add(accessor.key)
      for (const key of classStaticFieldStorageKeysOf(ctx.classes, current)) keys.add(key)
      if (layout.name !== null) {
        keys.add('name')
        keys.add('length')
      }
      current = layout.base
    }
  }
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const receiverText = operandText(ctx, operation.receiver)
  const arms = [...keys].map((key) => {
    const text = classConstructorStaticMemberTextFor(ctx, receiver, key, boxed, () => receiverText)
    if (text === null)
      throw createCppEmitBlockedError('property-access:constructor-family:get:true', `${site} cannot render its static member "${key}"`)
    return `if (gea_key == gea::PropertyKey::string(${cppStringLiteral(key)})) return ${text}; `
  })
  const read = `([&](const gea::PropertyKey& gea_key) -> gea::Value { ${arms.join('')}return gea::Value(); })(${propertyKeyText(ctx, operation.key, site)})`
  return unboxedReadText(operation.result.representation, read, site)
}

/**
 * A sidecar read's rendering, plus the DECLARED type the read's own slot has
 * to be spelled with when it is not `operation.result.representation`'s.
 *
 * Non-null `spelling` for exactly one shape, and it is not an option this
 * chooses: a METHOD read through a runtime key publishes a value whose
 * physical convention leads with the receiver
 * (`class-properties/emit-class-properties.ts`'s
 * `boundMethodValueRepresentation`, and `direct-call-receivers.ts`'s claim,
 * which has already committed the CALL to passing that receiver), while the
 * TS signature the result carrier was derived from declares none. Both arms of
 * the read are rendered at that corrected carrier, so the slot has to be too.
 */
export interface SidecarGetValue {
  readonly text: string
  readonly spelling: string | null
}

export const nativeSidecarGetText = (ctx: EmitContext, operation: GetOperation): SidecarGetValue | null => {
  const constructorRead = constructorFamilyComputedGetText(ctx, operation)
  if (constructorRead !== null) return { text: constructorRead, spelling: null }
  // Whether this key names a DECLARED field (below) or the Array.prototype
  // refusal applies is a claim, not a fold: ask `staticKeyTexts` so a value
  // `constantTexts` only later accumulates (a render-time `typeof` fold)
  // can never make a computed key look like a name the program wrote.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  // This is a normal-completion certificate. A native reference still owes
  // the null receiver check, even though no successful lookup can find a key.
  const absent = nativeAbsentPropertyReadOf(operation)
  if (absent === 'checked-reference')
    return {
      text: `gea::nativeAbsentPropertyGet(${operandText(ctx, operation.receiver)}, ${propertyKeyText(ctx, operation.key, 'a proven absent numeric read')})`,
      spelling: null
    }
  if (absent === 'primitive') return { text: 'gea::Undefined{}', spelling: null }
  if (staticKey !== undefined) {
    const representation = operation.receiver.representation
    // A key the generated layout declares is reached by the ordinary member
    // path below. A key it does not declare can still be an own property when
    // source reached the object through `any`; that property lives in this
    // object's expando table even though its spelling happened to be static.
    // A host-native record's declared fields stay with its protocol-specific
    // interceptor, which runs before this fallback. An undeclared key reached
    // through a dynamic view is still an ordinary expando on that same native
    // object, so it belongs in the generic sidecar just as it does for a
    // generated record. Excluding host-native records here made
    // `(error as any).code = value` fall through to a C++ member named `code`
    // that the native Error layout never declared.
    if (!staticKeyIsSidecarOnly(ctx, representation, staticKey)) return null
    // A key naming one of `Array.prototype`'s own members, undeclared on a
    // receiver whose static type is not an array, is the one shape this
    // fallback must NOT answer generically. `borrowed-builtin-call-bind-
    // source-transform.ts` rewrites `Array.prototype.<member>.call(receiver,
    // ...)` to `receiver.<member>(...)` syntactically, before the checker
    // runs, on the documented assumption that a receiver the borrowed member
    // cannot natively serve is refused "by the ordinary member-call machinery,
    // under its own name" -- i.e. that this very fallback would fail closed.
    // It does not: an expando sidecar exists precisely to answer a program's
    // OWN dynamically-assigned property of this name (`o.join = fn; o.join()`
    // is sound, ordinary JS), so `gea::nativeDynamicGet` renders unconditionally
    // and, finding nothing, throws a `gea::Value` `TypeError` this program
    // never asked for and, unless the borrowed call happens to sit inside a
    // `try`, never catches -- an unrelated pass (real JS: `Array.prototype.join
    // .call(o, sep)` never does a `[[Get]]` of "join" on `o` at all; it invokes
    // the method directly) that certifies clean and aborts at runtime instead.
    // So this refuses BY NAME, the same way `arrayAccessText`'s own
    // `arrayMemberRefusals` refuses a member the array carrier itself cannot
    // render: a program that reaches here is not turned into a silent
    // TypeError or a SIGABRT, it is told at compile time which method and why.
    if (arrayPrototypeMethods.has(staticKey)) {
      throw createCppEmitBlockedError(
        `property-access:${representation.kind}:get:false`,
        `"Array.prototype.${staticKey}" has no rendering off a "${representationKey(representation)}" receiver -- only a genuine array carrier ` +
          `dispatches an Array.prototype method natively (emit-prototype-array.ts's arrayMethods); an undeclared "${staticKey}" here would fall through ` +
          `to this receiver's dynamic-property sidecar, which states no generic non-native Array.prototype method and, finding none assigned, would ` +
          `resolve to a non-callable value at the call that follows`
      )
    }
    // A read the census typed as the ABSENCE itself -- a constant key a closed
    // record declares no field for, `const { fn = function () {} } = {}` --
    // is the language's `undefined`, and there is nothing to consult for it:
    // the layout has no such field by construction, and the census only
    // answers `undefined` for a holder whose static type is closed. Reading
    // the sidecar and demanding an `Undefined` tag back aborted at runtime on
    // exactly the absent key it was meant to spell.
    if (representation.kind === 'record' && operation.result.representation.kind === 'undefined')
      return { text: 'gea::Undefined{}', spelling: null }
  }
  const site = staticKey === undefined ? 'a computed "get" on a native receiver' : 'a dynamic-view "get" on a native receiver'
  const finiteUnion = finiteRecordUnionGetText(ctx, operation, operandText(ctx, operation.receiver))
  if (finiteUnion !== null) return { text: finiteUnion, spelling: null }
  const receiver = nativeSidecarReceiver(ctx, operation.receiver, site)
  if (receiver === null) return null
  const key = propertyKeyText(ctx, operation.key, site)
  const read = isPatternSidecarReceiver(operation.receiver)
    ? `gea::runtime::regex::dynamicGet(${receiver}, ${key})`
    : `gea::nativeDynamicGet(${receiver}, ${key})`
  const prototypeMethod = computedClassPrototypeMethodText(ctx, operation)
  // ONE carrier for the whole read, and it is the prototype arm's when there
  // is a prototype arm. A `?:` has a single type, and the two arms are the two
  // halves of one `[[Get]]`: whatever this read yields, it yields at one
  // convention. `boundMethodValueRepresentation` is the authority that decides
  // it for a method value -- receiver first, because that is what the thunk the
  // value points at really takes -- and the sidecar arm's `unboxAs` tag check
  // is equally exact at either spelling, since the expando holds a boxed
  // callable that the same `receivesThis` convention hands the instance back
  // through. Spelling the sidecar arm from the UNCORRECTED result carrier made
  // hono's `raw[key]()` (`HonoRequest.#cachedBody`, five monomorphs) emit a
  // ternary whose arms were `CallableObject<Promise<std::string>()>` and
  // `CallableObject<Promise<std::string>(Ref<Request>)>` and a slot declared as
  // the first while the call passed the receiver the second wants.
  const result = prototypeMethod === null ? operation.result.representation : prototypeMethod.carrier
  const decoded = unboxedReadText(result, read, site)
  const own =
    result.kind === 'dynamic' || isPatternSidecarReceiver(operation.receiver)
      ? decoded
      : `gea::nativeFieldGet<${cppTypeOf(result)}>(${receiver}, ${key}, [&]() { return ${decoded}; })`
  if (prototypeMethod === null) return { text: own, spelling: null }
  // OrdinaryGetOwnProperty runs before the prototype walk.  The native field
  // table and the identity-keyed expando are precisely this object's own
  // properties, so preserve their shadowing before selecting a generated
  // prototype method by name.
  return {
    text: `(gea::nativeDynamicHas(${receiver}, ${key}) ? ${own} : ${prototypeMethod.text})`,
    // Only where the correction actually moved the carrier. Where it did not,
    // the ordinary declaration is already right, and overriding it with the
    // identical spelling would drop the slot out of `ownedValues` for no
    // reason -- a different program, not a different spelling of this one.
    spelling: representationKey(result) === representationKey(operation.result.representation) ? null : (prototypeMethod.spelling ?? null)
  }
}

/** `[[Set]]` with a runtime key on a receiver that keeps its native type. */
export const emitNativeSidecarSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const callable = callableSidecarReceiver(ctx, operation.receiver)
  if (callable !== null && operation.kind === 'set') {
    // The "own" vs "computed" wording names whether the KEY is one the
    // program wrote, so it asks `staticKeyTexts` -- a value `constantTexts`
    // only later folds would otherwise mislabel a genuinely computed key as
    // an own, statically-named one in this description.
    const site = ctx.staticKeyTexts.has(operation.key.value)
      ? 'an own "set" on a callable receiver'
      : 'a computed "set" on a callable receiver'
    const key = propertyKeyText(ctx, operation.key, site)
    const value = boxedValueText(ctx, operation.value, site)
    // CallableConstructorObject has the same identity-owned Function table as
    // CallableObject, but must first materialize its non-configurable own
    // `prototype` before an ordinary Set/Delete can observe it. Keep this as
    // a native table operation; widening the constructor itself would erase
    // its independently typed [[Call]] and [[Construct]] entries.
    const write =
      operation.receiver.representation.kind === 'function-and-constructor'
        ? `([&]() -> bool { const auto& __gea_callable = ${callable}; gea::installCallableOwnFacts(__gea_callable.functionObjectIdentity(), __gea_callable.name(), __gea_callable.length()); ` +
          `const gea::PropertyKey __gea_key = ${key}; ` +
          `if (!__gea_key.isSymbol() && __gea_key.text() == "prototype") gea::installCallableConstructorPrototype(__gea_callable); ` +
          `return __gea_callable.functionObjectIdentity()->properties->set(__gea_key, ${value}, gea::Value::box(gea::Value::Tag::Function, __gea_callable)); })()`
        : `gea::callableDynamicSet(${callable}, ${key}, ${value})`
    if (operation.strict) {
      lines.push(`if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read-only Function own property");`)
    } else lines.push(`${write};`)
    if (!operation.result || operation.result.representation.kind === 'void') return true
    const threaded = alignedValueText(
      ctx,
      'emit-dynamic-properties.ts:752',
      operation.receiver.representation,
      operation.result.representation,
      callable
    )
    if (threaded === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(operation.receiver.representation)}->${representationKey(operation.result.representation)}`,
        `${site} publishes a "${operation.result.representation.kind}" carrier as the assignment's own value, and this backend cannot spell a ` +
          `"${operation.receiver.representation.kind}" receiver as one`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${threaded};`)
    return true
  }
  // Whether this write lands on a declared field/accessor (deferred to
  // another branch) or the expando sidecar is a claim, not a fold: ask
  // `staticKeyTexts` so a value `constantTexts` only later accumulates (a
  // render-time `typeof` fold) can never be mistaken for a declared name.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  if (staticKey !== undefined) {
    const representation = operation.receiver.representation
    if (!staticKeyIsSidecarOnly(ctx, representation, staticKey)) return false
    // An accessor is installed on the class prototype rather than in instance
    // storage, so `declaredRecordFieldOf` correctly finds no struct field for
    // it. That absence does not make the write an expando: OrdinarySet must
    // call the inherited setter. Leave this constant key for emit-properties'
    // class accessor branch. Methods remain sidecar writes because assigning
    // one creates an own property that shadows the writable prototype method.
    if (representation.kind === 'class-ref' && classMemberOf(ctx.classes, representation.declaration, staticKey)?.kind === 'accessor') {
      return false
    }
  }
  const site = staticKey === undefined ? 'a computed "set" on a native receiver' : 'a dynamic-view "set" on a native receiver'
  const receiver = nativeSidecarReceiver(ctx, operation.receiver, site)
  if (receiver === null) return false
  const key = propertyKeyText(ctx, operation.key, site)
  const value = boxedValueText(ctx, operation.value, site)
  const generated = generatedNativeSidecarReceiver(ctx, operation.receiver, site)
  const write = isPatternSidecarReceiver(operation.receiver)
    ? `gea::runtime::regex::dynamicSet(${receiver}, ${key}, ${value})`
    : generated === null
      ? `gea::nativeDynamicSet(${receiver}, ${key}, ${value})`
      : generatedNativeWriteText(generated, key, value)
  if (operation.kind === 'set' && operation.strict) {
    lines.push(`if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read-only property");`)
  } else {
    lines.push(`${write};`)
  }
  // The store's own result is the receiver threaded onward, exactly as a
  // struct field store publishes the object it wrote into. It is RECONCILED
  // rather than assigned as it stands: the receiver of a sidecar write reached
  // its native carrier through a cast, so the expression's own published
  // carrier is what the cast said (`dynamic` for `(this as any)[k] = v`) and
  // not what the receiver physically is. A pair the conversion table cannot
  // spell is refused by name -- writing a `class-ref` into a slot declared as
  // something else would be a wrong answer, not a spelling gap.
  if (!operation.result || operation.result.representation.kind === 'void') return true
  const produced = operation.result.representation
  const threaded = alignedValueText(ctx, 'emit-dynamic-properties.ts:808', operation.receiver.representation, produced, receiver)
  if (threaded === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.receiver.representation)}->${representationKey(produced)}`,
      `${site} publishes a "${produced.kind}" carrier as the assignment's own value, and this backend cannot spell a ` +
        `"${operation.receiver.representation.kind}" receiver as one`
    )
  }
  lines.push(`${defineValue(ctx, operation.result)} = ${threaded};`)
  return true
}

/**
 * `delete` over a `dictionary` receiver's own `std::map`-backed table --
 * `Dictionary::erase`/`NumericDictionary::erase` (gea_runtime.h), the same
 * table `dictionaryTableOf` (emit-properties.ts) already builds the
 * read/subscript spellings for. Reused rather than re-derived so a delete and
 * a read of the identical receiver can never disagree about which member
 * expression reaches the table.
 *
 * `deleteProperty` and not `erase`: since `Object.defineProperty` on a
 * dictionary retains attributes, an entry CAN be non-configurable, and
 * `[[Delete]]` (ECMA-262 10.1.10) answers false for one rather than removing
 * it. This used to be `erase` plus a literal `true` -- correct while every
 * entry was configurable, and the honest comment for it said so. `erase`
 * stays the unconditional removal the container's internal rewrites need.
 */
const emitDictionaryDelete = (ctx: EmitContext, lines: string[], operation: DeleteOperation): boolean => {
  const table = dictionaryTableOf(ctx, operation.receiver, operation.key)
  if (table === null) return false
  emitDeleteOutcome(ctx, lines, operation, `${table.member}deleteProperty(${table.key})`)
  return true
}

/**
 * `delete` over the native-sidecar receiver: a statically typed object's own
 * expando table, the same one `nativeSidecarGetText`/`emitNativeSidecarSet`
 * above read and write. `gea::nativeDynamicDelete` (gea_runtime.h) is the
 * runtime's own answer for BOTH halves of what a dynamic key on a native
 * receiver can name: a currently-present declared struct field, which it
 * refuses to remove because a runtime-only key carries no field-specific
 * reset recipe, and an expando key, which it actually erases. That runtime check
 * is exactly what makes a COMPUTED key safe to route here even though it
 * might, at runtime, turn out to name a field: the answer is still correct,
 * never a silent no-op reported as success.
 *
 * A constant key naming an optional generated field has more information: the
 * emitter can clear its typed value and independent presence bit, which is the
 * ordinary configurable-property delete. A plain record's REQUIRED field never
 * reaches here: `ir/certify/property-access.ts` leaves its `record:delete`
 * row unclaimed (`deleteNamesRecordExpandoKey`), because no direct read of a
 * required field consults its presence bit, and claiming the field disappeared
 * would make direct reads and reflective key queries disagree. A class
 * instance's constructor-assigned field is the one exception this emitter
 * keeps: `grouped-field-read.runtime.js` deletes one and reads it back only
 * through the computed chain, which does consult presence.
 */
const emitNativeSidecarDelete = (ctx: EmitContext, lines: string[], operation: DeleteOperation): boolean => {
  const table = recordIndexSidecarTableOf(ctx, operation.receiver, operation.key)
  if (table?.disjoint) {
    const attributeKey = recordIndexAttributeKeyText(table.index, operation.key.representation, '__gea_key')
    const answer =
      `([&]() -> bool { const auto __gea_key = ${table.key}; const auto __gea_attribute_key = ${attributeKey}; ` +
      `if (${table.member}has(__gea_key) && !${table.attributes}.deleteAllowed(__gea_attribute_key)) return false; ` +
      `${table.member}erase(__gea_key); ${table.attributes}.erase(__gea_attribute_key); return true; })()`
    emitDeleteOutcome(ctx, lines, operation, answer)
    return true
  }
  const site = 'a "delete" on a native receiver'
  const representation = operation.receiver.representation
  const ownedIndexed =
    (representation.kind === 'record-with-index' && representation.ownership !== 'shared-refcount') ||
    (representation.kind === 'native-record-ref' &&
      representation.ownership !== 'shared-refcount' &&
      representation.native === null &&
      recordIndexesOfShape(ctx.deriver, representation.shapeId).length > 0)
  if (ownedIndexed) {
    const receiver = operandText(ctx, operation.receiver)
    const ownership =
      representation.kind === 'record-with-index' || representation.kind === 'native-record-ref' ? representation.ownership : 'owned'
    const accessor = memberAccessOperator(ownership)
    const key = propertyKeyText(ctx, operation.key, site)
    const call =
      `([&]() -> bool { const gea::PropertyKey __gea_key = ${key}; ` +
      `if (${receiver}${accessor}gea_matchesOwnField(__gea_key)) return ${receiver}${accessor}gea_deleteOwnField(__gea_key); ` +
      `if (${receiver}${accessor}gea_matchesOwnIndex(__gea_key)) return ${receiver}${accessor}gea_deleteOwnIndex(__gea_key); return true; })()`
    emitDeleteOutcome(ctx, lines, operation, call)
    return true
  }
  const receiver = nativeSidecarReceiver(ctx, operation.receiver, site)
  if (receiver === null) return false
  const key = propertyKeyText(ctx, operation.key, site)
  const generated = generatedNativeSidecarReceiver(ctx, operation.receiver, site)
  const call = generated === null ? `gea::nativeDynamicDelete(${receiver}, ${key})` : generatedNativeDeleteText(generated, key)
  emitDeleteOutcome(ctx, lines, operation, call)
  return true
}

/**
 * `delete` over a `native-handle` receiver (`Math`, `Array.prototype`, ...),
 * for a compile-time-constant key.
 *
 * A `native-handle` is a zero-size compile-time tag, not a runtime object
 * with a table to erase a slot from -- so what this answers is ECMA-262
 * 10.1.10.1 `OrdinaryDelete`'s OWN outcome, not a real removal:
 *
 * - A key the host member table does not claim at all names no own property
 *   (`hostMemberOf` returns `undefined`), so `[[GetOwnProperty]]` would answer
 *   `undefined` and step 2 of `OrdinaryDelete` returns `true` immediately --
 *   there was never anything to delete, so nothing needs to happen.
 * - A `'property'` row is a data constant: every one of these (21.3.1's Math
 *   values; a builtin function's own restricted `name`/`length`, 10.2.4) is
 *   specified non-configurable, so `OrdinaryDelete` returns `false` without
 *   removing anything, and that is exactly what deleting one of these
 *   observably does -- nothing, forever.
 * - A `'method'` row (`Math.pow`, ...) IS specified configurable, so a
 *   faithful answer would actually remove it -- and this compiler has no
 *   per-instance storage a `native-handle` could lose a member from (every
 *   handle of one protocol is the same zero-size tag), so refusing by name is
 *   the honest answer rather than reporting a `true` that changes nothing.
 *
 * A computed (runtime) key refuses for the same reason `nativeHandleMemberText`
 * does for a get: there is no runtime member table to search a non-constant
 * key against.
 */
const emitNativeHandleDelete = (ctx: EmitContext, lines: string[], operation: DeleteOperation): boolean => {
  const representation = operation.receiver.representation
  if (representation.kind !== 'native-handle') return false
  const site = 'a "delete" on a native-handle receiver'
  // Which branch fires (a per-protocol member lookup vs. the runtime search
  // over the intrinsic table) is a claim, not a fold: ask `staticKeyTexts` so
  // a value `constantTexts` only later accumulates (a render-time `typeof`
  // fold) can never be treated as a name the program wrote.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  const memberProtocol = representation.native ?? representation.protocol
  if (staticKey === undefined) {
    // The computed-key half, over the same per-protocol sidecar the computed
    // get and set use (`emit-host-properties.ts`'s
    // `computedNativeHandleGetText` states the design): a non-configurable
    // member answers false and changes nothing, anything else is marked
    // removed there and answers true.
    const members = representation.native === null ? ctx.hosts.intrinsicMembers.get(memberProtocol) : undefined
    if (members === undefined) {
      throw createCppEmitBlockedError(
        'property-access:native-handle:delete:true',
        `${site} has no compile-time-constant key, and a "${representation.protocol}" host handle has no runtime member table for a computed key to search`
      )
    }
    const computedSite = `a computed "delete" on a "${representation.protocol}" host handle`
    const fixed = members
      .filter((member) => !intrinsicMemberValueOf(ctx, memberProtocol, member, computedSite).configurable)
      .map((member) => `__gea_key.text() == ${cppStringLiteral(member.name)}`)
    const keep = fixed.length === 0 ? 'false' : `(!__gea_key.isSymbol() && (${fixed.join(' || ')}))`
    const answer =
      `([&]() -> bool { const gea::PropertyKey __gea_key = ${propertyKeyText(ctx, operation.key, computedSite)}; if (${keep}) return false; ` +
      `gea::detail::hostIntrinsicSidecar(${cppStringLiteral(memberProtocol)}).remove(__gea_key); return true; })()`
    emitDeleteOutcome(ctx, lines, operation, answer)
    return true
  }
  const host = hostMemberOf(ctx.hosts.members, memberProtocol, staticKey)
  const answer = host === undefined ? 'true' : host.kind === 'property' ? 'false' : null
  if (answer === null) {
    throw createCppEmitBlockedError(
      'property-access:native-handle:delete:false',
      `${site} names "${representation.protocol}.${staticKey}", a host METHOD -- ECMA-262 specifies it configurable, so a faithful ` +
        '[[Delete]] would actually remove it, and this backend has no per-instance storage a zero-size native handle could lose a member from'
    )
  }
  emitDeleteOutcome(ctx, lines, operation, answer)
  return true
}

/**
 * `[[Delete]]` and `[[HasProperty]]` as IR operations, with their refusals.
 *
 * Four receivers have an answer for a key to remove: a `gea::Value`, whether
 * it owns a `DynamicObject` outright or boxes a native struct whose field
 * dispatcher and expando together describe it (`emitDynamicDelete`); a
 * `dictionary`'s own `std::map`-backed storage (`emitDictionaryDelete`); a
 * statically typed object's own expando sidecar, reached through a computed
 * key (`emitNativeSidecarDelete`); and a `native-handle`, which has no table
 * at all but whose ANSWER (never its effect) is still knowable from the same
 * static attribute table its property reads already consult
 * (`emitNativeHandleDelete`). Every other carrier is a fixed struct with no
 * sidecar or an Array's slots -- none of which has a key to remove at all --
 * so it is refused by name rather than given a plausible `true`.
 */
/**
 * `delete fn[k]` on a callable: the shared function-object table's own
 * [[Delete]], with the `name`/`length` facts installed first so deleting one
 * of them answers the way ECMA-262 says (both configurable, 10.2.10) and a
 * later `hasOwnProperty` sees it gone.
 */
const emitCallableSidecarDelete = (ctx: EmitContext, lines: string[], operation: DeleteOperation): boolean => {
  const callable = callableSidecarReceiver(ctx, operation.receiver)
  if (callable === null) return false
  const site = 'a "delete" on a callable receiver'
  const key = propertyKeyText(ctx, operation.key, site)
  const constructorSetup =
    operation.receiver.representation.kind === 'function-and-constructor'
      ? `if (!__gea_key.isSymbol() && __gea_key.text() == "prototype") gea::installCallableConstructorPrototype(__gea_callable); `
      : ''
  const answer =
    `([&]() -> bool { const auto& __gea_callable = ${callable}; ` +
    'gea::installCallableOwnFacts(__gea_callable.functionObjectIdentity(), __gea_callable.name(), __gea_callable.length()); ' +
    `const gea::PropertyKey __gea_key = ${key}; ${constructorSetup}` +
    'return __gea_callable.functionObjectIdentity()->properties->deleteOwnProperty(__gea_key); })()'
  emitDeleteOutcome(ctx, lines, operation, answer)
  return true
}

export const emitDeleteOperation = (ctx: EmitContext, lines: string[], operation: DeleteOperation): void => {
  if (emitDynamicDelete(ctx, lines, operation)) return
  if (emitCallableSidecarDelete(ctx, lines, operation)) return
  if (emitDictionaryDelete(ctx, lines, operation)) return
  if (emitNativeSidecarDelete(ctx, lines, operation)) return
  if (emitNativeHandleDelete(ctx, lines, operation)) return
  // The refusal's key-form suffix names whether the key is one the program
  // wrote, matching the claim every branch above just asked -- `staticKeyTexts`,
  // not `constantTexts`, or a render-time `typeof` fold could make this code
  // report "static" for a key none of those branches actually treated as one.
  throw createCppEmitBlockedError(
    `property-access:${operation.receiver.representation.kind}:delete:${String(ctx.staticKeyTexts.get(operation.key.value) === undefined)}`,
    `a "delete" on a "${operation.receiver.representation.kind}" receiver has no property table to remove a key from`
  )
}
