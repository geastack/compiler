import { canonicalIndexLiteral } from '../../representation/array-index.js'
import { disjointNativeRecordIndexOf, nativeRecordIndexReadCarrierOf } from '../../ir/native-record-index.js'
import type { DefineOwnPropertyOperation, GetOperation, IrOperand, IrResult, SetOperation } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import {
  cppDenseLengthName,
  createCppEmitBlockedError,
  defineValueAlias,
  operandText,
  type ReactiveRevisionOrigin,
  type EmitContext,
  type PrototypeMethodRead,
  isIntegerStorageValue,
  wellKnownSymbolMemberOf
} from './emit-context.js'
import type { Ownership, Representation } from '../../representation/model.js'
import {
  carriesUndefined,
  isCanonicalNumberPropertyKeyText,
  recordIndexForKeyCarrier,
  representationKey
} from '../../representation/model.js'
import { alignedValueText, widenedStoreText, type ConversionSite } from './emit-narrowing.js'
import {
  dictionaryPrototypeMethods,
  keyedCollectionPrototypeMethods,
  numberPrototypeMethods,
  promisePrototypeMethods
} from './prototype/emit-prototype-invoke.js'
import { iteratorPrototypeMethods } from './prototype/emit-prototype-iterator.js'
import { arrayInheritedMemberRefusals, arrayMemberRefusals, arrayPrototypeMethods } from './prototype/emit-prototype-array.js'
import { stringMemberRefusals, stringPrototypeMethods } from './prototype/emit-prototype-string.js'
import {
  cppReactiveRevisionFieldName,
  recordFieldsOfShape,
  recordIndexesOfShape,
  cppRecordIndexSidecarNameFor,
  cppRecordIndexAttributesNameFor,
  type RecordIndexSidecar
} from './records.js'
import {
  cppArrayExtensionStructName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn,
  cppUndefinedValue
} from './types.js'
import { toStringText } from './emit-tostring.js'
import {
  typedArrayBufferMemberText,
  typedArrayBufferMembers,
  binaryToStringTagText,
  typedArrayElementSpelling,
  typedArrayPrototypeMethods
} from './emit-buffers.js'

/**
 * How a member reads on each built-in carrier.
 *
 * These are renderings, not decisions. `emit-properties.ts` remains the one
 * place that *chooses* which of them a given key means -- its own header
 * explains why that choice must not be split, and this file does not split it.
 * What moves here is the mechanical part: given that the receiver is already
 * known to be an Array, a typed array, a string or a scalar, what text does
 * the member read render to. Each answers `null` for a receiver that is not
 * its own, so the caller's dispatch stays a single ordered sequence.
 */

export { canonicalIndexLiteral } from '../../representation/array-index.js'

/**
 * The Array-exotic reading of a property access, or `null` when the receiver is
 * not an Array.
 *
 * `length` is the accessor, not a member: an Array's length is derived from its
 * slots, and a struct field spelling would let it drift from them. A constant
 * key that spells a canonical index (`a[0]`, `a["0"]`) is an element access
 * exactly like a computed one, just with the index known at compile time.
 * A constant key naming one of `arrayPrototypeMethods` (see
 * `emit-prototype-array.ts`, the one authority for which those are) defers
 * instead of refusing: the access records which method was reached and renders
 * nothing, and the following call fuses it with the receiver. Every other
 * constant key is still an ordinary property this carrier has no table for,
 * and stays refused by name -- with a stated reason where `arrayMemberRefusals`
 * has one, because "not built yet" and "cannot be built without X" are
 * different answers and only the second tells you what to build.
 *
 * `result` is the `[[Get]]`'s own SSA value id, needed only for the deferred
 * branch (to key `ctx.prototypeMethodReads` by); every other branch ignores
 * it, the same asymmetry `nativeHandleMemberText` already has.
 */
/**
 * An indexed Array read whose result carrier can be ABSENT, or `null` when it
 * cannot and the plain reader is right.
 *
 * `elementAt` has no absent answer -- it aborts -- and under the type
 * `lib.es5.d.ts` gives `a[i]` that is the honest behaviour, because the result
 * carrier is `T` and there is no `undefined` in it to produce.
 * `noUncheckedIndexedAccess` is one case where the checker says otherwise: the
 * result is `T | undefined`, the carrier is absence-capable, and the
 * language's own answer for a hole or an out-of-range index is that
 * `undefined` rather than a fault. A genuinely dynamic element/result pair is
 * the other: `gea::Value` itself carries `undefined`, so returning the bare
 * reader would abort where its stated result can represent the exact answer.
 * Emitting the bare reader for either leaves two authorities on one read --
 * the carrier promising absence the access never produces.
 *
 * The presence test is `ArrayObject::hasElement`, which is `elementAt`'s own
 * abort condition negated and stated once in the runtime, so "readable" cannot
 * drift between the two. Both arms are written in the optional's own spelling
 * rather than relying on the conditional operator to find a common type
 * through `Optional<T>`'s converting constructor -- the same shape
 * `narrowedLoadText` already writes for a narrowed optional load.
 *
 * The receiver and the key are re-mentioned, not re-evaluated: both are
 * operand texts, which are SSA names or literals.
 *
 * `null` for every other mismatch, which keeps this to the case it can answer:
 * a result carrier that differs from the element for some other reason is left
 * exactly as it rendered before.
 */
const absentCapableElementText = (
  ctx: ConversionSite,
  receiverText: string,
  reader: 'elementAt' | 'elementAtIndex',
  keyText: string,
  element: Representation,
  result: IrResult | null
): string | null => {
  const present = presentElementText(ctx, element, result, `${receiverText}->${reader}(${keyText})`)
  if (present === null) return null
  // `hasElementValue`, never `hasElement`: this arm publishes the language's
  // `undefined` for the absent case, and an index whose stored element is
  // ITSELF `undefined` (`pushUndefined` -- a template object's invalid escape,
  // a literal `[0, undefined]`) reads as `undefined` too. `hasElement` answers
  // `[[HasProperty]]`, which is `true` there; see its twin in the runtime for
  // why one predicate must not answer both.
  const has = reader === 'elementAtIndex' ? 'hasElementValueAtIndex' : 'hasElementValue'
  const carrier = result?.representation ?? element
  const absent =
    carrier.kind === 'tagged-union'
      ? alignedValueText(ctx, 'emit-carrier-members.ts:141', { kind: 'undefined' }, carrier, cppUndefinedValue)
      : `${cppTypeOf(carrier)}()`
  return absent === null ? null : `(${receiverText}->${has}(${keyText}) ? ${present} : ${absent})`
}

/**
 * An indexed read whose result carrier is not the element's, RECONCILED --
 * the same read written in the carrier the access publishes.
 *
 * `absentCapableElementText` answers the absence question and nothing else, so
 * every other disagreement between the element and the published carrier fell
 * through to the bare reader, whose C++ type is the ELEMENT's. Two authorities
 * on one read again: hono's `newResponse: NewResponse = (...args) =>
 * this.#newResponse(...args)` reads `args[0]` out of an array of boxes and
 * publishes `Data | null` -- the tuple element the checker states for that
 * position -- and the bare `elementAt(0)` handed a `gea::Value` to a
 * `gea::Optional<gea::TaggedUnion<...>>` parameter with nothing between them.
 *
 * The read is reconciled through the one conversion authority, which for a
 * `dynamic` element is the checked unbox. A pair it cannot answer is left as
 * the bare reader rendered before: this states the conversions that ARE
 * licensed rather than becoming a new refusal over reads that already emit.
 */
const reconciledElementText = (ctx: ConversionSite, element: Representation, result: IrResult | null, text: string): string => {
  const carrier = result?.representation
  if (carrier === undefined || representationKey(carrier) === representationKey(element)) return text
  return alignedValueText(ctx, 'emit-carrier-members.ts:166', element, carrier, text) ?? text
}

/**
 * An element already PROVEN present, written in the result's own carrier, or
 * `null` when that carrier is not absence-capable and the element stands as it
 * is.
 *
 * Two readers produce a proven-present element and both need this: the guarded
 * arm of `absentCapableElementText`, whose guard is the proof, and the dense
 * window's fast path, whose flag is (`ir/dense-loops.ts` admits a window only
 * for an array with no hole and an index the loop's own bound covers -- the
 * general form is what runs otherwise). Stating it once is what keeps the two
 * arms of that window's conditional in one C++ type instead of leaving the
 * conditional operator to find one through `Optional<T>`'s converting
 * constructor.
 */
export const presentElementText = (ctx: ConversionSite, element: Representation, result: IrResult | null, text: string): string | null => {
  const carrier = result?.representation
  // A present dynamic element already has the result's exact carrier. Returning
  // its text here lets `absentCapableElementText` guard the fallible reader and
  // use `gea::Value()` for a hole without boxing or changing a present value.
  if (element.kind === 'dynamic' && carrier?.kind === 'dynamic') return text
  if (carrier === undefined) return null
  // A result that is the element plus `undefined` spelled as a tagged union
  // (`undefined | null | T` over a `(T | null)[]`, where an `Optional` of an
  // `Optional` has no primitive): the present arm is the element WIDENED into
  // the union by the one conversion authority, the absent arm is the union's
  // own `undefined`.
  if (carrier.kind === 'tagged-union' && carriesUndefined(carrier))
    return alignedValueText(ctx, 'emit-carrier-members.ts:195', element, carrier, text)
  if (carrier.kind !== 'optional' || carrier.absence !== 'undefined') return null
  // An element that is ITSELF the result's carrier -- `(string | undefined)[]`
  // read at a position, or the `optional(string)` capture slots of a
  // `RegExpExecArray` snapshot -- is present as stored, absence included.
  // Converting it into the carrier's PAYLOAD below narrows it (`(*x)`), which
  // on a stored absent element is the empty payload, and re-wrapping that
  // reports a hole as a present empty value: `const [, b = 'B'] = ['0',
  // undefined]` bound `b` to `''`, so the default never fired.
  if (representationKey(carrier) === representationKey(element)) return text
  const converted = alignedValueText(ctx, 'emit-carrier-members.ts:205', element, carrier.payload, text)
  return converted === null ? null : `${cppTypeOf(carrier)}(${converted})`
}

/**
 * Whether an Array member read is a deferred `Array.prototype` METHOD read,
 * and what it is.
 *
 * The one statement of that test. `arrayAccessText` below asks it rather than
 * repeating it, and so does the walk that settles
 * `EmitContext.prototypeMethodReads` before a body renders -- one
 * implementation, two callers, which is what keeps a fact to one authority.
 * The exclusions are the branches that claim the key FIRST and are therefore
 * part of the same question: `length`, a field the array's extension declares,
 * and a canonical index.
 */
export const deferredArrayMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'array-object') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || staticKey === 'length') return null
  if (carrier.extension?.some((field) => field.key === staticKey) === true) return null
  if (canonicalIndexLiteral(staticKey) !== null) return null
  if (!arrayPrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'array-object',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: representationKey(carrier.element),
    arrayCarrier: carrier
  }
}

export const arrayAccessText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrResult | null): string | null => {
  if (receiver.representation.kind !== 'array-object') return null
  // A wrapped dense window's divisor, already read at its own preheader: the
  // loop cannot resize the array, and re-reading the length there is what stops
  // the backend keeping the window's base pointer in a register.
  const hoisted = result === null ? undefined : ctx.denseLengths.get(result.id)
  if (hoisted !== undefined) return cppDenseLengthName(hoisted)
  const receiverText = operandText(ctx, receiver)
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === 'length') return `${receiverText}->length()`
  // A field the array's extended interface declares (`array-object.extension`,
  // `NodeArray.pos`): read off the extension sidecar the runtime array holds,
  // typed by the generated struct `records.ts` declared for these fields. A
  // read of an array that never gained its fields sees the struct's own
  // defaults (`extensionFields`), never allocates. An optional field answers
  // from its presence bit the way a record's does (`narrowedFieldReadText`):
  // the stored value when set, the published carrier's own `undefined`
  // otherwise -- and a read the branch already proved present publishes a
  // carrier with no `undefined` in it, which is the plain member load.
  const extensionField = staticKey === undefined ? undefined : receiver.representation.extension?.find((field) => field.key === staticKey)
  if (extensionField !== undefined && receiver.representation.extension) {
    const struct = cppArrayExtensionStructName(receiver.representation.extension)
    const fields = `${receiverText}->template extensionFields<${struct}>()`
    const present = reconciledElementText(ctx, extensionField.value, result, `${fields}.${cppRecordFieldName(extensionField.key)}`)
    const absent = extensionField.required || result === null ? null : cppUndefinedIn(result.representation)
    return absent === null ? present : `(${fields}.${cppRecordFieldPresenceName(extensionField.key)} ? ${present} : ${absent})`
  }
  if (wellKnownSymbolMemberOf(ctx, key) === 'toStringTag') return binaryToStringTagText(receiver.representation)
  if (staticKey !== undefined) {
    const index = canonicalIndexLiteral(staticKey)
    if (index !== null) {
      return (
        absentCapableElementText(ctx, receiverText, 'elementAt', index, receiver.representation.element, result) ??
        reconciledElementText(ctx, receiver.representation.element, result, `${receiverText}->elementAt(${index})`)
      )
    }
    if (deferredArrayMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:array-object:get:false',
          `"${staticKey}" is an Array.prototype method, and this access publishes no value for its call to consume`
        )
      }
      // The receiver's reactive origin travels onto the method read so the CALL
      // can tick it if the member mutates (`emitCall`); the read itself renders
      // nothing. Nothing is recorded HERE, because the origin travels through
      // every get alike -- `reactive-dependencies.ts` carries it onto this
      // result the same way it carries it onto a field read, and this rung
      // restating it was a second authority that could only ever agree.
      return ''
    }
    const stated = arrayMemberRefusals.get(staticKey)
    if (stated !== undefined) {
      throw createCppEmitBlockedError(
        'property-access:array-object:get:false',
        `"${staticKey}" is an Array.prototype member this backend states no rendering for: ${stated}`
      )
    }
    if (arrayInheritedMemberRefusals.has(staticKey)) {
      throw createCppEmitBlockedError(
        'property-access:array-object:get:false',
        `"${staticKey}" is a name an Array INHERITS, not an own property, and this backend renders nothing for it off an array receiver -- ` +
          'the dynamic-property sidecar below answers own properties only, so letting this key reach it would publish `undefined` for a ' +
          'value the language reads off the prototype chain'
      )
    }
    // Anything else is an ORDINARY own property of the Array object, and this
    // function is not the authority on those. `gea::nativeDynamicGet` is: an
    // ArrayObject participates in the identity-keyed expando table exactly as
    // every other native object does, and `finalizeTemplateObject` writes
    // GetTemplateObject's `raw` into that very table. Refusing here with "no
    // property table is installed for one" was a second authority stating a
    // premise the runtime contradicts, and it refused every tag declared
    // `readonly string[]` -- the supertype spelling a tag is entitled to use
    // (`test/runtime/template-strings-readonly-array.ts`), whose carrier
    // therefore has no `raw` extension to read the property off statically.
    // Returning `null` hands the key to `nativeSidecarGetText`, which asks
    // that one authority. Nothing that compiles today moves: every key
    // reaching this line is one emission refused outright a moment ago.
    return null
  }
  // A STRING key is what `for (const i in array)` binds -- `arrayOwnEnumerableKeys`
  // publishes `std::to_string(index)` for every present element -- and hono's
  // RegExp router indexes straight back with it (`handlerMap[i] =
  // handlerData[indexReplacementMap[i]]`, the `in` loop over a sparse
  // replacement map). CanonicalNumericIndexString is the whole conversion the
  // language performs there, and `gea::detail::arrayIndexFromKeyText` is it; every
  // read below this line is then the identical number-keyed access, absence
  // rule included. A key that is not a canonical index answers exactly as a
  // non-index NUMBER already does here rather than reaching the Array
  // object's own ordinary properties, which no element access reads.
  if (key.representation.kind === 'string') {
    const indexText = `gea::detail::arrayIndexFromKeyText(${operandText(ctx, key)})`
    return (
      absentCapableElementText(ctx, receiverText, 'elementAt', indexText, receiver.representation.element, result) ??
      reconciledElementText(ctx, receiver.representation.element, result, `${receiverText}->elementAt(${indexText})`)
    )
  }
  if (key.representation.kind !== 'scalar') {
    throw createCppEmitBlockedError(
      'property-access:array-object:get:true',
      `an Array element access keyed by a "${key.representation.kind}" carrier needs a ToPropertyKey conversion, which is not installed`
    )
  }
  // An index the integer census narrowed goes straight in as an integer --
  // see `ArrayObject::elementAtIndex` for why the double round trip is not
  // merely redundant.
  const reader = isIntegerStorageValue(ctx, key.value) ? 'elementAtIndex' : 'elementAt'
  const keyText = operandText(ctx, key)
  return (
    absentCapableElementText(ctx, receiverText, reader, keyText, receiver.representation.element, result) ??
    reconciledElementText(ctx, receiver.representation.element, result, `${receiverText}->${reader}(${keyText})`)
  )
}

/**
 * The TypedArray reading of a property access, or `null` when the receiver
 * is not a typed array.
 *
 * Unlike `array-object`, a typed array has no ordinary-property domain at
 * all -- ECMA-262 23.2's integer-indexed exotic object answers every
 * non-canonical-index key through the ordinary `[[Get]]` this carrier keeps
 * no table for, so a constant key other than `length` or a canonical index
 * is refused by name exactly the way `arrayAccessText` refuses one for an
 * Array.
 */
/**
 * Whether a typed-array member read is a deferred `%TypedArray%.prototype`
 * method read. Stated once, asked by the renderer below and by the walk that
 * settles `EmitContext.prototypeMethodReads`. The exclusions are the keys
 * claimed first and therefore part of the same question: `length`, a canonical
 * index, and the three block-shaped members `emit-buffers.ts` owns.
 */
export const deferredTypedArrayMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'typed-array') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || staticKey === 'length') return null
  if (canonicalIndexLiteral(staticKey) !== null || typedArrayBufferMembers.has(staticKey)) return null
  if (!typedArrayPrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'typed-array',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: typedArrayElementSpelling(carrier)
  }
}

export const typedArrayAccessText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrResult | null): string | null => {
  if (receiver.representation.kind !== 'typed-array') return null
  const receiverText = operandText(ctx, receiver)
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === 'length') return `${receiverText}->length()`
  if (staticKey !== undefined) {
    const index = canonicalIndexLiteral(staticKey)
    if (index !== null) return absentCapableNumericElementText(receiverText, index, result) ?? `${receiverText}->elementAt(${index})`
    // The block-shaped half of the same carrier -- `buffer`/`byteLength`/
    // `byteOffset` and the four range methods -- lives in `emit-buffers.ts`
    // with `ArrayBuffer` and `DataView`, because what each of them is about is
    // the underlying block rather than an element. See that file's header.
    const bufferMember = typedArrayBufferMemberText(receiverText, receiver.representation, staticKey)
    if (bufferMember !== null) {
      // The member's own carrier is not always the one the READ publishes.
      // `Uint8Array.prototype.buffer` is declared `ArrayBufferLike` -- a union
      // of `ArrayBuffer` and `SharedArrayBuffer` -- while a view over a plain
      // buffer hands back exactly one of them, so the store needs the arm
      // injection that `gea::TaggedUnion` has no converting constructor for.
      // @hono/node-server's `handleMessage` reads `data.buffer` off a
      // `Uint8Array` into such a cell and clang refused the assignment.
      //
      // The union-arm reading of the same three members already aligns this
      // way (`emit-union-properties.ts`), with the same source spelling; only
      // the direct receiver handed its text over unaligned, which is the two
      // -authorities shape rather than a missing recipe.
      if (result === null) return bufferMember
      const source: Representation =
        staticKey === 'buffer'
          ? { kind: receiver.representation.buffer, ownership: 'shared-refcount' }
          : { kind: 'scalar', domain: 'number' }
      const aligned = alignedValueText(ctx, 'emit-carrier-members.ts:411', source, result.representation, bufferMember)
      if (aligned === null) {
        throw createCppEmitBlockedError(
          `property-access:typed-array:get:false`,
          `a typed array's "${staticKey}" carries "${representationKey(source)}" while the read publishes ` +
            `"${representationKey(result.representation)}", and no installed conversion reconciles them`
        )
      }
      return aligned
    }
    if (deferredTypedArrayMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:typed-array:get:false',
          `"${staticKey}" is a %TypedArray%.prototype method, and this access publishes no value for its call to consume`
        )
      }
      return ''
    }
    throw createCppEmitBlockedError(
      'property-access:typed-array:get:false',
      `a typed array property "${staticKey}" is an ordinary property, and typed arrays have no ordinary-property table -- ` +
        `only length, ${[...typedArrayBufferMembers].join(', ')} and ${[...typedArrayPrototypeMethods].join(', ')} are implemented`
    )
  }
  if (key.representation.kind !== 'scalar') {
    throw createCppEmitBlockedError(
      'property-access:typed-array:get:true',
      `a typed array element access keyed by a "${key.representation.kind}" carrier needs a ToPropertyKey conversion, which is not installed`
    )
  }
  const keyText = operandText(ctx, key)
  return absentCapableNumericElementText(receiverText, keyText, result) ?? `${receiverText}->elementAt(${keyText})`
}

/**
 * `absentCapableElementText` for the typed-array reader.
 *
 * The same defect and the same cure, one carrier along: under
 * `noUncheckedIndexedAccess` the checker types `view[i]` as `number |
 * undefined`, and `TypedArray::elementAt` cannot answer that `undefined` --
 * it aborts on an index outside the view. Left as the bare reader, this half
 * is WORSE than the Array half was: `Optional<double>` converts implicitly
 * from the `double` the reader returns, so the mismatch compiles, and the
 * program aborts on a read JavaScript answers with a value.
 *
 * The payload is required to be a `scalar` rather than converted, because
 * what `elementAt` produces is not a carrier this backend selected -- the
 * reader's return type is `double` for all eight views, whatever the element
 * domain is. Asking `convertedValueText` would mean inventing a source
 * carrier to ask about; requiring the one payload that reader fits is the
 * same fact stated where it is true.
 */
export const absentCapableNumericElementText = (receiverText: string, keyText: string, result: IrResult | null): string | null => {
  const carrier = result?.representation
  if (carrier === undefined || carrier.kind !== 'optional' || carrier.absence !== 'undefined') return null
  if (carrier.payload.kind !== 'scalar') return null
  const optional = cppTypeOf(carrier)
  return `(${receiverText}->hasElement(${keyText}) ? ${optional}(${receiverText}->elementAt(${keyText})) : ${optional}())`
}

/**
 * The String reading of a property access, or `null` when the receiver is not
 * a `string`.
 *
 * `length` is the only own data property a JavaScript string has; everything
 * else `String.prototype` exposes is a method, and a method reference is a
 * `[[Get]]` too -- `s.slice(...)`'s callee is its own `property` operation,
 * cited by the call the same way a class method's is. Rendering one as a
 * value needs a receiver-carrying calling convention, and the checker's
 * structural signature for an ambient interface method (as opposed to a class
 * method body) carries no `this` parameter -- `structural.ts`'s
 * `implicitReceiverOf` synthesizes one only for a class's own method, not for
 * a `lib.es5.d.ts` interface member. Rendering the method anyway would emit a
 * call that drops the receiver, exactly the mismatch `emit.ts`'s call
 * emission already refuses by its own fail-closed guard.
 *
 * A key naming one of `stringPrototypeMethods` (see `emit-prototype-string.ts`,
 * the one authority for which those are) is the one exception: instead of rendering the method here, the access
 * defers -- it records which member was reached off which receiver and
 * renders nothing, and the following call fuses receiver, method and
 * arguments into one expression, sidestepping the missing-receiver problem
 * entirely rather than solving it generically. Every other key is still
 * refused by name instead of guessed at: the gap is the missing receiver
 * upstream, not a rendering this file could supply for an unimplemented
 * method.
 *
 * The one key that is neither `length` nor a method is a canonical INDEX --
 * `s[i]`, ECMA-262 10.4.3's String exotic `[[Get]]`, which answers a
 * single-code-unit string. See `stringIndexText`.
 */
export const isDeclaredStringPrototypeKey = (key: string): boolean => stringPrototypeMethods.has(key) || stringMemberRefusals.has(key)

/**
 * A symbol's own `description` -- `Symbol.prototype.description`, ECMA-262
 * 20.4.3.2, an accessor whose value is `undefined` for `Symbol()` and the
 * string given otherwise, which is exactly the `gea::Optional<std::string>`
 * `gea::symbolDescription` answers and the `optional(string)` carrier the
 * checker's `string | undefined` derives to. test262's `propertyHelper.js`
 * reads it for every symbol-keyed `verifyProperty`. The other
 * `Symbol.prototype` members (`toString`, `valueOf`, `[@@toPrimitive]`) are
 * methods and refuse by name until an invocation asks for them.
 */
export const symbolMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrResult | null): string | null => {
  if (receiver.representation.kind !== 'symbol') return null
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === 'description') {
    const text = `gea::symbolDescription(${operandText(ctx, receiver)})`
    if (result === null) return text
    const source: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
    const converted = alignedValueText(ctx, 'emit-carrier-members.ts:423', source, result.representation, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        'property-access:symbol:get:false',
        `"description" is an optional string, and no conversion is installed into the "${representationKey(result.representation)}" this read publishes`
      )
    }
    return converted
  }
  throw createCppEmitBlockedError(
    `property-access:symbol:get:${String(staticKey === undefined)}`,
    `"${staticKey ?? '<computed>'}" is not a member this backend renders on a symbol receiver; only "description" is`
  )
}

/**
 * Whether a String member read is a deferred `String.prototype` method read.
 * One statement of the test; `stringMemberText` and the prototype-read walk
 * both ask it.
 */
export const deferredStringMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  if (receiver.representation.kind !== 'string') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || staticKey === 'length') return null
  if (!stringPrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'string', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

export const stringMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrResult | null): string | null => {
  if (receiver.representation.kind !== 'string') return null
  const receiverText = operandText(ctx, receiver)
  const staticKey = ctx.staticKeyTexts.get(key.value)
  // A JavaScript String's `length` is its count of UTF-16 CODE UNITS
  // (ECMA-262 6.1.4 / 22.1.4.1), which is not its byte count once anything
  // outside ASCII appears. This backend stores a string as UTF-8, so the two
  // index spaces differ and the spec's is the one that wins -- the same answer
  // v1 gives (`ir/emission/cpp/passes/properties/access.ts`, which spells this
  // read as `gea_cpp_string_utf16_length` for exactly this receiver).
  //
  // `gea::runtime::string::utf16Length` is v1's own function, ported with its
  // memo: this read sits inside `for (i...) s.charCodeAt(i)` loops, so an
  // unmemoized scan here is what makes such a loop quadratic.
  if (staticKey === 'length') return `static_cast<double>(gea::runtime::string::utf16Length(${receiverText}))`
  if (staticKey !== undefined) {
    if (deferredStringMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:string:get:false',
          `"${staticKey}" is a String.prototype method, and this access publishes no value for its call to consume`
        )
      }
      return ''
    }
    // A constant key that spells a canonical index is an element access
    // exactly as a computed one is, just with the index known here --
    // the same carve-out `arrayAccessText` makes above, and for the same
    // reason: `s[0]` and `s["0"]` reach this file as one constant text,
    // because `ToPropertyKey` already turned the number into a String.
    const index = canonicalIndexLiteral(staticKey)
    if (index !== null) return stringIndexText(receiverText, index, result, staticKey)
    const stated = stringMemberRefusals.get(staticKey)
    throw createCppEmitBlockedError(
      'property-access:string:get:false',
      stated !== undefined
        ? `"${staticKey}" is a String.prototype member this backend states no rendering for: ${stated}`
        : `"${staticKey}" is a String.prototype method, not a data property; calling it needs a receiver-carrying calling ` +
            'convention this program did not derive one for, and reading it as a value has no native implementation installed -- ' +
            `only ${[...stringPrototypeMethods].join(', ')} ${stringPrototypeMethods.size === 1 ? 'is' : 'are'} implemented`
    )
  }
  // A genuinely computed key. On a string there is exactly one thing it can
  // be: an index. `ToPropertyKey` of a number is its String, and no
  // `String.prototype` member has a name a number spells, so a computed key
  // that is a `scalar` reaches the exotic `[[Get]]` and nothing else. A key
  // carried as anything but a scalar would need the ToPropertyKey conversion
  // this backend has not installed, and stays refused by name.
  if (key.representation.kind !== 'scalar') {
    throw createCppEmitBlockedError(
      'property-access:string:get:true',
      `a String property access keyed by a "${key.representation.kind}" carrier needs a ToPropertyKey conversion, which is not installed`
    )
  }
  return stringIndexText(receiverText, operandText(ctx, key), result, null)
}

/**
 * `s[i]` -- ECMA-262 10.4.3's String exotic `[[Get]]`.
 *
 * The result is a one-code-unit string, and the unit is
 * `gea::runtime::string::charAt`'s: this backend stores a string as UTF-8 and
 * the spec indexes it in UTF-16 code units, so `charAt` -- which already owns
 * that projection (`substringUtf16` over `utf16Length`) -- is where the index
 * space is decided, rather than restated here where the two could disagree.
 *
 * ## Out of range, and the carrier
 *
 * The spec's answer for an out-of-range or non-integer index is `undefined`,
 * and `charAt`'s is the empty string. That divergence is not observable
 * through the type the checker gives this read: `lib.es5.d.ts` declares
 * `String`'s index signature `readonly [index: number]: string`, so the result
 * carrier is `string`, there is no `undefined` in it to produce, and a program
 * that compares the result against `undefined` is refused by the checker
 * before this emitter is reached ("types 'string' and 'undefined' have no
 * overlap"). `arrayAccessText`'s `elementAt` answers an out-of-range Array
 * index the same way and for the same reason -- the checker types `a[i]` as
 * `T`, not `T | undefined` -- so this is the backend's existing convention,
 * not a new one taken here.
 *
 * A program compiled with `noUncheckedIndexedAccess` is the case where the
 * difference IS in the type: the checker then says `string | undefined`, the
 * carrier is absence-capable, and a bare `std::string` would be the wrong
 * one. That is refused by name rather than rendered, because producing the
 * absence needs a materialization this function is not the place to decide.
 *
 * The integer guard on the computed path is this access's own rule and not
 * `charAt`'s: `charAt(1.5)` truncates to 1 and answers a real code unit,
 * while `s[1.5]` reads the ordinary property `"1.5"`, which a string does not
 * have. Under a `string` carrier the honest answer for it is the same empty
 * string every other out-of-range index gets. A constant index has already
 * been proved canonical by `canonicalIndexLiteral`, so it needs no guard at
 * all.
 */
export const stringIndexText = (receiverText: string, indexText: string, result: IrResult | null, staticKey: string | null): string => {
  // `noUncheckedIndexedAccess` types this read `string | undefined`: the
  // checker's own admission the index may be out of range. `charAtOrAbsent`
  // (gea_runtime.h) is the exact materialization -- see its own comment for
  // why `charAt`'s empty-string-means-out-of-range convention loses nothing
  // by becoming `Optional<std::string>()`.
  const isOptionalString = (representation: Representation): boolean =>
    representation.kind === 'optional' && representation.absence === 'undefined' && representation.payload.kind === 'string'
  const wantsAbsence = result !== null && isOptionalString(result.representation)
  if (result !== null && result.representation.kind !== 'string' && !wantsAbsence) {
    throw createCppEmitBlockedError(
      `property-access:string:get:${String(staticKey === null)}`,
      `a String index read${staticKey === null ? '' : ` ("${staticKey}")`} whose result is carried as ` +
        `"${result.representation.kind}" rather than "string" needs an absence materialization this backend has not installed ` +
        '-- the shape `noUncheckedIndexedAccess` gives every indexed read'
    )
  }
  const charAtSpelling = wantsAbsence ? 'charAtOrAbsent' : 'charAt'
  if (staticKey !== null) return `gea::runtime::string::${charAtSpelling}(${receiverText}, ${indexText})`
  const emptyResult = wantsAbsence ? 'gea::Optional<std::string>()' : 'std::string()'
  const returnType = wantsAbsence ? 'gea::Optional<std::string>' : 'std::string'
  return (
    `([&]() -> ${returnType} { const double gea_index = ${indexText}; ` +
    `if (!std::isfinite(gea_index) || gea_index < 0.0 || std::floor(gea_index) != gea_index) return ${emptyResult}; ` +
    `return gea::runtime::string::${charAtSpelling}(${receiverText}, gea_index); })()`
  )
}

/**
 * The scalar reading of a property access, or `null` when the receiver is not
 * a `scalar`.
 *
 * A `scalar` (`number`, `boolean`, `bigint`, ...) has no own data property at
 * all: `Number.prototype`/`Boolean.prototype` expose only methods (`toFixed`,
 * `toString`, `valueOf`, ...), never a stored field the way String's `length`
 * is. So this is `stringMemberText`'s non-`length` branch with nothing left
 * over to carve out first -- and it defers on the same terms: a key naming one
 * of `numberPrototypeMethods` records the read and renders nothing, so the
 * call that follows fuses receiver, method and arguments into one expression.
 * Every other key is a method reference refused for the identical reason the
 * String path refuses one: the checker's structural signature for a
 * `lib.es5.d.ts` interface method carries no `this` parameter, so there is no
 * receiver a rendered call could close over.
 */
/**
 * A `promise` receiver's members.
 *
 * A promise has no data property at all: `then`/`catch`/`finally` are
 * `Promise.prototype` methods, and the checker's structural signature for one
 * carries no `this` parameter -- the same missing-receiver reason
 * `stringMemberText` and `scalarMemberText` state. So `then` defers and fuses
 * with its call, and every other member is refused by name.
 *
 * `finally` is deliberately not deferred. 27.2.5.3 runs its callback on BOTH
 * settlements and then re-raises the original one -- a fulfilled promise's
 * value passes through and a rejected promise's rejection is re-thrown after
 * the callback -- which is a rendering this backend does not have. `catch`
 * does: `gea::Promise` carries a rejection (an `exception_ptr`, see the
 * carrier's own comment) and `promiseCatchText` renders the handler over it.
 */
/** Whether a Promise member read is a deferred `Promise.prototype` method read. Stated once; the renderer and the walk both ask it. */
export const deferredPromiseMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'promise') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !promisePrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'promise',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: null,
    promiseCarrier: carrier
  }
}

export const promiseMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  if (receiver.representation.kind !== 'promise') return null
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      'property-access:promise:get:true',
      'a promise property access keyed by a non-constant key has no ToPropertyKey or native member table installed'
    )
  }
  if (deferredPromiseMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
    if (result === null) {
      throw createCppEmitBlockedError(
        'property-access:promise:get:false',
        `"${staticKey}" is a Promise.prototype method, and this access publishes no value for its call to consume`
      )
    }
    return ''
  }
  throw createCppEmitBlockedError(
    'property-access:promise:get:false',
    `"${staticKey}" is a Promise.prototype member this backend states no rendering for -- only ${[...promisePrototypeMethods].join(', ')} ` +
      'is implemented'
  )
}

/**
 * An `iterator` receiver's members -- a generator value or one of the four
 * fixed-storage cursor sources, all carried as `gea::Iterator<T, TReturn,
 * TNext>` (`representation/model.ts`'s `iterator` kind) -- of which `next`,
 * `return` and `throw` are the ones this backend renders.
 *
 * Deferred and fused with its call exactly as a Promise member is, and for
 * the same reason `stringMemberText` states: the ambient `Generator`
 * interface method has no `this` parameter, so there is no receiver-carrying
 * calling convention a first-class value could be built from. The claimed
 * member set is `iteratorPrototypeMethods`'s (`emit-prototype-iterator.ts`),
 * one authority with the renderer -- and `manifest/capabilities.ts` claims
 * the same members by name (`iterator(next):get:false`, and its `return`/
 * `throw` siblings), so a member that reaches here unclaimed is a preflight
 * defect, reported as one. `iteratorCallText` refines `return`/`throw`
 * further, by the receiver's own `source` tag, to the one carrier
 * (`'generator'`) whose real prototype defines them at all.
 */
/** Whether an iterator member read is a deferred `%GeneratorPrototype%` method read. Stated once; the renderer and the walk both ask it. */
export const deferredIteratorMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'iterator') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !iteratorPrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'iterator',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: representationKey(carrier.element),
    iteratorCarrier: carrier
  }
}

export const iteratorMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'iterator') return null
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      'property-access:iterator:get:true',
      'an iterator property access keyed by a non-constant key has no ToPropertyKey or native member table installed'
    )
  }
  if (deferredIteratorMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
    if (result === null) {
      throw createCppEmitBlockedError(
        'property-access:iterator:get:false',
        `"${staticKey}" is a %GeneratorPrototype% method, and this access publishes no value for its call to consume`
      )
    }
    return ''
  }
  throw createCppEmitBlockedError(
    'property-access:iterator:get:false',
    `"${staticKey}" is a %GeneratorPrototype% member this backend states no rendering for -- only ${[...iteratorPrototypeMethods].join(', ')} is implemented`
  )
}

/**
 * A `keyed-collection` receiver's members -- `Map`/`Set`/`WeakMap`/`WeakSet`.
 *
 * `size` is the one member that renders here and now: it is an accessor over
 * the collection's own storage (ECMA-262 23.1.3.14 / 24.2.3.9), not a method,
 * so there is no call to fuse with. Every claimed METHOD defers and fuses with
 * its call exactly as `substring` does off a string, for the identical reason
 * `stringMemberText` states: the checker gives an ambient interface method no
 * `this` parameter, so a materialized method value would have nowhere to carry
 * the receiver.
 *
 * Which methods are claimed is `keyedCollectionMethods`'s answer, per family
 * (`emit-prototype-invoke.ts`) -- one authority, so a member that defers here
 * is always a member that renders there. `size` is deliberately absent from
 * the weak families: ECMA-262 gives a WeakMap/WeakSet no `size`, no `clear`
 * and no iteration at all, because none of it is observable when entries may
 * be collected.
 */
/**
 * Whether a `keyed-collection`'s `size` is the DATA property 23.1.3.14 and
 * 24.2.3.9 declare -- true for `Map`/`Set`, false for the weak pair, which
 * has no `size` at all.
 *
 * The two callers below have to disagree about `size` in exactly opposite
 * directions: the claim must EXCLUDE it, because a data property is not a
 * deferred method read, and the renderer must SPELL it. They said so in two
 * separately-written boolean expressions over the same two facts, which is
 * the two-authorities defect at its smallest -- if either side ever learned
 * about a third strong family, or `WeakMap` ever grew a `size`, only one of
 * them would learn it, and a `.size` read would silently become a refusal or
 * a method reference.
 */
const keyedCollectionSizeIsDataProperty = (
  carrier: Extract<Representation, { readonly kind: 'keyed-collection' }>,
  staticKey: string
): boolean => staticKey === 'size' && (carrier.family === 'map' || carrier.family === 'set')

/** Whether a Map/Set/WeakMap/WeakSet member read is a deferred prototype method read. Stated once; the renderer and the walk both ask it. */
export const deferredKeyedCollectionMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'keyed-collection') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  if (keyedCollectionSizeIsDataProperty(carrier, staticKey)) return null
  if (!keyedCollectionPrototypeMethods(carrier.family).has(staticKey)) return null
  return {
    receiverKind: 'keyed-collection',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: representationKey(carrier.key),
    collectionFamily: carrier.family,
    collectionCarrier: carrier
  }
}

export const keyedCollectionMemberText = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand,
  result: IrValueId | null
): string | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'keyed-collection') return null
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      'property-access:keyed-collection:get:true',
      `a ${carrier.family} property access keyed by a non-constant key has no ToPropertyKey or native member table installed`
    )
  }
  const strong = carrier.family === 'map' || carrier.family === 'set'
  if (keyedCollectionSizeIsDataProperty(carrier, staticKey)) {
    return `${operandText(ctx, receiver)}${memberAccessOperator(carrier.ownership)}size()`
  }
  if (deferredKeyedCollectionMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
    if (result === null) {
      throw createCppEmitBlockedError(
        'property-access:keyed-collection:get:false',
        `"${staticKey}" is a ${carrier.family} prototype method, and this access publishes no value for its call to consume`
      )
    }
    return ''
  }
  throw createCppEmitBlockedError(
    'property-access:keyed-collection:get:false',
    `"${staticKey}" is a ${carrier.family} member this backend states no rendering for -- only ` +
      `${[...(strong ? ['size'] : []), ...keyedCollectionPrototypeMethods(carrier.family)].join(', ')} ` +
      `${keyedCollectionPrototypeMethods(carrier.family).size === 0 ? 'is' : 'are'} implemented`
  )
}

/**
 * `shared-refcount` is a `shared_ptr` and needs `->`; `owned`/`borrowed` are the
 * struct itself (or a reference to it) and use `.`.
 *
 * Lives here rather than in `emit-properties.ts`, where every call site of it
 * is, because `recordIndexSidecarTableOf` below needs it too and this file
 * cannot import back from that one (`emit-properties.ts` already imports the
 * carrier renderers *from* here; the dependency only runs one way). A single
 * mechanical helper crossing that line is cheaper than reversing it.
 */
export const memberAccessOperator = (ownership: Ownership): string => (ownership === 'shared-refcount' ? '->' : '.')

/**
 * The companion revision cell a reactive origin ticks, spelled.
 *
 * The fact (`ReactiveRevisionOrigin`) names the owning OPERAND and the field;
 * the C++ name of that operand exists only once its defining operation has
 * rendered, which is why the spelling is taken here, at the store that ticks
 * it, and not at the read that recorded the origin.
 */
export const reactiveRevisionText = (ctx: EmitContext, origin: ReactiveRevisionOrigin): string => {
  const carrier = origin.receiver.representation
  // A carrier with no ownership of its own is a value, and `.` reaches its
  // member -- the same default `memberAccessOperator` gives everything that is
  // not a shared reference.
  const ownership: Ownership = 'ownership' in carrier ? carrier.ownership : 'owned'
  return `${operandText(ctx, origin.receiver)}${memberAccessOperator(ownership)}${cppReactiveRevisionFieldName(origin.key)}`
}

/**
 * One key, spelled in the domain the keyed container is actually keyed by --
 * for a struct's index sidecar and for a bare `dictionary` receiver alike.
 *
 * A property key is a string in the source language: `a[0]` and `{ [N]: v }`
 * with `const N = 2` both publish the constant `"0"`/`"2"`, while
 * `gea::NumericDictionary` is keyed by `double`. The two have to be reconciled
 * or the emitted subscript does not compile. This is the identical rule
 * `emit-allocation.ts`'s `emitAllocateDictionary` already applies to the fields
 * an allocation installs, lifted to one function so an allocation, a later
 * store and a read cannot end up with three opinions about how a key is
 * spelled.
 *
 * A key whose own carrier already matches the container's domain passes through
 * untouched -- `strings[i]` with a `double` index is already a `double`. Only a
 * cross-domain key needs the language conversion. A number used against a
 * string-keyed sidecar is ordinary `ToPropertyKey`, so it goes through the
 * backend's exact Number::toString renderer. A string used against a
 * number-keyed sidecar only passes when it is constant and canonicalizable;
 * converting an arbitrary runtime string would make `a["01"]` and `a[1]`
 * name the same slot.
 */
/**
 * An `Object.prototype` method reached through a `dictionary` receiver:
 * recorded as a deferred prototype read and rendered at the call, exactly as a
 * String or Date member is.
 *
 * Answering `true` means the access produced no C++ of its own and the caller
 * must return -- the read's value is materialized by
 * `prototypeMethodCallText`, which fuses receiver and call into one
 * expression. `false` means this is not one, and every remaining path is
 * unchanged.
 *
 * Only a CONSTANT key is claimed. `bag[k]` with a runtime `k` really is an
 * index read even when `k` happens to spell `"hasOwnProperty"` at runtime,
 * and the checker types it as the index's own value; claiming it here would
 * be this file disagreeing with the carrier the rest of the program agreed
 * on.
 */
/**
 * Whether a dictionary member read is a deferred `Object.prototype` method
 * read. Stated once; the renderer and the walk both ask it. Only a CONSTANT
 * key is claimed -- `bag[k]` with a runtime `k` is an index read even when `k`
 * happens to spell `"hasOwnProperty"`.
 */
export const deferredDictionaryMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'dictionary') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !dictionaryPrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'dictionary',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: null,
    dictionaryTable: { accessor: memberAccessOperator(carrier.ownership), key: carrier.key }
  }
}

export const dictionaryPrototypeMemberRead = (ctx: EmitContext, operation: GetOperation): boolean => {
  if (deferredDictionaryMethodClaim(ctx.staticKeyTexts, operation.receiver, operation.key) === null) return false
  // `dictionaryTableOf` is not asked for the member spelling here: it also
  // reconciles the KEY, and this key is a method name rather than an entry --
  // against a number-keyed table that reconciliation would (rightly) refuse
  // `"hasOwnProperty"` as not spelling a numeric key. Only the accessor half
  // is wanted, and it is the same `memberAccessOperator` that function uses.
  return true
}

export const keyedTableKeyText = (ctx: EmitContext, key: IrOperand, domain: 'string' | 'number' | 'symbol'): string => {
  const text = operandText(ctx, key)
  const carrier = key.representation
  const matches =
    domain === 'number'
      ? carrier.kind === 'scalar' && carrier.domain === 'number'
      : domain === 'symbol'
        ? carrier.kind === 'symbol'
        : carrier.kind === 'string'
  if (matches) return text
  if (domain === 'string' && carrier.kind === 'scalar' && carrier.domain === 'number') {
    const converted = toStringText(text, carrier, ctx.classes, ctx.deriver)
    if (converted !== null) return converted
  }
  if (
    domain === 'string' &&
    carrier.kind === 'tagged-union' &&
    carrier.arms.every((arm) => arm.value.kind === 'string' || (arm.value.kind === 'scalar' && arm.value.domain === 'number'))
  ) {
    const arms = carrier.arms.map((arm, index) => {
      const value = `${text}.get<${index}>()`
      if (arm.value.kind === 'string') return value
      const converted = toStringText(value, arm.value, ctx.classes, ctx.deriver)
      if (converted === null) {
        throw createCppEmitBlockedError(
          `runtime-helper:computation:to-property-key:${representationKey(arm.value)}`,
          `a string-keyed index sidecar cannot convert the numeric arm "${representationKey(arm.value)}" to a property key`
        )
      }
      return converted
    })
    const dispatched = arms.reduceRight<string>(
      (rest, arm, index) => (index === arms.length - 1 ? arm : `${text}.is<${index}>() ? ${arm} : (${rest})`),
      ''
    )
    return arms.length > 1 ? `(${dispatched})` : dispatched
  }
  // A string index signature is reached through ToPropertyKey just like an
  // ordinary object property. `toStringText` is exact for every non-Symbol
  // primitive carrier, including an optional/tagged union's nullish arms and
  // a genuinely dynamic box's primitive tags. Its boxed Symbol/Object cases
  // abort by name instead of fabricating a string slot this sidecar cannot
  // represent.
  if (domain === 'string') {
    const converted = toStringText(text, carrier, ctx.classes, ctx.deriver)
    if (converted !== null) return converted
  }
  if (domain === 'symbol') {
    throw createCppEmitBlockedError(
      'runtime-helper:computation:to-property-key:symbol',
      `a symbol-keyed index sidecar is subscripted with a "${representationKey(carrier)}" key; symbols are identity values and cannot be ` +
        'recovered from a string or numeric property-key spelling'
    )
  }
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:to-property-key:${domain}`,
      `a ${domain}-keyed index sidecar is subscripted with a "${representationKey(carrier)}" key that is not a compile-time constant; ` +
        'converting one domain to the other at runtime is a ToPropertyKey conversion this subscript does not perform'
    )
  }
  if (domain === 'string') return cppStringLiteral(staticKey)
  if (!isCanonicalNumberPropertyKeyText(staticKey)) {
    throw createCppEmitBlockedError(
      'runtime-helper:computation:to-property-key:number',
      `a number-keyed index sidecar is subscripted with "${staticKey}", which does not spell a numeric key`
    )
  }
  return cppStringLiteral(staticKey)
}

/**
 * The dynamic-property sidecar behind a `record-with-index`/`native-record-ref`
 * receiver, in both spellings a use of it needs -- the identical shape a bare
 * `dictionary` carrier's own table function returns (`emit-properties.ts`'s
 * `dictionaryTableOf`), aimed one member deeper at the struct's `gea_dynamic`
 * field instead of at the receiver itself.
 *
 * `record-with-index` carries its `indexes` inline (model.ts); a
 * `native-record-ref` only names a shape, so its sidecar (if it has one) is
 * resolved through `records.ts`'s `recordIndexesOfShape` -- the identical
 * deriver-backed lookup `emit-properties.ts`'s `declaredFieldRepresentation`
 * already uses for a `native-record-ref`'s named fields, asked for its index
 * instead of its fields. `null` covers three different receivers with one
 * answer -- neither carrier, a `record-with-index` (impossible: every one has
 * an index by construction), and a `native-record-ref` whose named shape has
 * none -- the last of which is exactly what `preflight/property-access.ts`'s
 * `nativeRecordRefHasIndexSidecar` already refuses to certify, so an
 * uncertified program is the only way emission reaches here for one.
 *
 * The sidecar field is always embedded *by value* in the struct
 * (`records.ts`'s `renderStructDefinition`), regardless of the struct's own
 * ownership -- so reaching the struct itself uses the receiver's own
 * accessor (`->` for `shared-refcount`, `.` otherwise), and every operation
 * on the sidecar value it names uses `.`, never a second dispatch on an
 * ownership the sidecar does not have its own copy of.
 */
export const recordIndexSidecarTableOf = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand
): {
  readonly member: string
  readonly subscript: string
  readonly key: string
  readonly value: Representation
  readonly receiver: string
  readonly accessor: string
  readonly propertyKey: string
  readonly attributes: string
  readonly disjoint: boolean
  readonly index: RecordIndexSidecar
} | null => {
  const representation = receiver.representation
  if (representation.kind !== 'record-with-index' && representation.kind !== 'native-record-ref') return null
  const indexes: readonly RecordIndexSidecar[] =
    representation.kind === 'record-with-index' ? representation.indexes : recordIndexesOfShape(ctx.deriver, representation.shapeId)
  const staticKey = ctx.staticKeyTexts.get(key.value)
  const index = recordIndexForKeyCarrier(indexes, key.representation, staticKey)
  if (!index) return null
  // A constant key that names one of the receiver's own declared fields is
  // that field -- the struct half of the split layout -- and must not be
  // shadowed by the sidecar sitting beside it (`.length` on an
  // `ArrayLike<number>`).
  //
  // Asked here for BOTH carriers rather than only for `native-record-ref`.
  // `emitGet` reaches this only after `recordWithIndexFieldText` has already
  // declined, so for a `record-with-index` read the test is redundant -- but
  // that made the answer depend on the caller having asked in the right order,
  // and the STORE path has no such predecessor: its declared-field case is the
  // generic struct-member write at the very END of `emitFieldStoreLines`, so a
  // sidecar branch placed before it can only be correct if this function
  // declines a declared key on its own. Making it total is what lets the store
  // side exist at all.
  if (staticKey !== undefined) {
    const fields =
      representation.kind === 'record-with-index' ? representation.fields : recordFieldsOfShape(ctx.deriver, representation.shapeId)
    if (fields?.some((field) => field.key === staticKey)) return null
  }
  const structAccessor = memberAccessOperator(representation.ownership)
  const receiverText = operandText(ctx, receiver)
  const sidecarText = `${receiverText}${structAccessor}${cppRecordIndexSidecarNameFor(index, indexes)}`
  const keyText = keyedTableKeyText(ctx, key, index.key)
  const propertyKey =
    index.key === 'symbol'
      ? `gea::PropertyKey::symbol(${keyText})`
      : index.key === 'number'
        ? key.representation.kind === 'scalar' && key.representation.domain === 'number'
          ? `gea::PropertyKey::number(${keyText})`
          : `gea::PropertyKey::string(${keyText})`
        : `gea::PropertyKey::string(${keyText})`
  return {
    member: `${sidecarText}.`,
    subscript: `${sidecarText}[${keyText}]`,
    key: keyText,
    value: index.value,
    receiver: receiverText,
    accessor: structAccessor,
    propertyKey,
    attributes: `${receiverText}${structAccessor}${cppRecordIndexAttributesNameFor(index, indexes)}`,
    disjoint: disjointNativeRecordIndexOf(ctx.deriver, representation, key.representation, staticKey) !== null,
    index
  }
}

/**
 * Reading a computed-keyed property out of a `record-with-index`/
 * `native-record-ref` receiver's dynamic-property sidecar.
 *
 * Identical to `emit-properties.ts`'s `dictionaryReadText`, one member
 * deeper: the checker itself routes a computed numeric/string read of an
 * interface that mixes named fields with an index signature
 * (`ArrayLike<number>`) through the index signature rather than through any
 * specific named field, because a runtime key's identity is not known at
 * compile time -- so this is reached exactly when
 * `preflight/property-access.ts` admits it, over the identical
 * `gea::Dictionary`/`gea::NumericDictionary` machinery, never over a struct
 * member the checker could not have meant.
 */
export const recordIndexSidecarReadText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const table = recordIndexSidecarTableOf(ctx, operation.receiver, operation.key)
  if (table === null) return null
  const read = operation.result.representation
  const source = nativeRecordIndexReadCarrierOf(table.index, read)
  const raw = `${table.member}read(${table.key})`
  const lookup =
    read.kind === 'optional' && read.absence === 'undefined'
      ? `(${table.member}has(${table.key}) ? ${cppTypeOf(source)}(${raw}) : ${cppTypeOf(source)}())`
      : raw
  const indexedRead = (() => {
    if (representationKey(source) === representationKey(read)) return lookup
    const converted = alignedValueText(ctx, 'emit-carrier-members.ts:995', source, read, lookup)
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(read)}`,
      `reads an index sidecar value carried as "${representationKey(source)}" into "${representationKey(read)}", and no conversion is installed`
    )
  })()
  const representation = operation.receiver.representation
  const generated =
    representation.kind === 'record-with-index' || (representation.kind === 'native-record-ref' && representation.native === null)
  const fields =
    representation.kind === 'record-with-index'
      ? representation.fields
      : representation.kind === 'native-record-ref'
        ? recordFieldsOfShape(ctx.deriver, representation.shapeId)
        : null
  // A runtime key can equal a declared field even though the checker typed the
  // expression through the index signature. Query the fixed layout before the
  // sidecar and decode the transient Value into the published native carrier;
  // a deleted fixed slot therefore yields undefined (or a checked mismatch),
  // never an older sidecar entry with the same PropertyKey.
  if (!table.disjoint && generated && ctx.staticKeyTexts.get(operation.key.value) === undefined && fields !== null && fields.length > 0) {
    const fixed = alignedValueText(
      ctx,
      'emit-carrier-members.ts:1017',
      { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
      read,
      '__gea_fixed'
    )
    if (fixed === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey({ kind: 'dynamic', reason: 'declared-any-never-narrowed' })}->${representationKey(read)}`,
        `a computed key can collide with a fixed field, but its transient reflected value cannot be decoded as "${representationKey(read)}"`
      )
    }
    return (
      `([&]() -> ${cppTypeOf(read)} { const gea::PropertyKey __gea_key = ${table.propertyKey}; ` +
      `if (${table.receiver}${table.accessor}gea_matchesOwnField(__gea_key)) { gea::Value __gea_fixed; ` +
      `${table.receiver}${table.accessor}gea_readOwnField(__gea_key, __gea_fixed); return ${fixed}; } return ${indexedRead}; })()`
    )
  }
  return indexedRead
}

/**
 * Writing a property that names no declared field -- constant or computed --
 * into a `record-with-index`/`native-record-ref` receiver's index sidecar.
 *
 * The store counterpart of `recordIndexSidecarReadText` directly above, and
 * built the identical way: `recordIndexSidecarTableOf` already declines a
 * CONSTANT key that names one of the receiver's own declared fields (the
 * struct half of the split layout, written by the generic field store at the
 * end of `emitFieldStoreLines` instead), so asking it is enough to tell the
 * two halves apart -- this function does not re-decide that split, only
 * dispatch on its answer. A COMPUTED key can never name a declared field in
 * the first place (`recordIndexSidecarReadText`'s own comment states why:
 * the checker itself routes a computed access of a mixed-shape type through
 * the index signature, never through a named field, because a runtime key's
 * identity is not known at compile time), so `recordIndexSidecarTableOf`
 * answers it unconditionally, the same way `record-with-index:get:true`
 * already claims the read.
 *
 * `{ count: 1, 0: 'zero' }` against
 * `interface Mixed { count: number; [index: number]: string }` is ordinary
 * TypeScript: `count` is the struct half of the split layout and `0` is the
 * open half. Only an index signature admits the second key at all -- without
 * one TypeScript rejects it as an excess property -- so this is reached
 * exactly when the sidecar is the key's only possible home.
 *
 * The read side has resolved both halves since it was written; the store
 * side originally had a counterpart for the constant half only, so a
 * constant key that named no field fell through every branch of
 * `emitFieldStoreLines` to the generic struct-member write at its end and
 * spelled `receiver->gea_slot_0`, a member `records.ts` never laid out
 * because it laid out the sidecar instead -- and a COMPUTED key that named no
 * field fell all the way to `emitNativeSidecarSet`, which reaches this same
 * receiver but through the wrong table: its own `gea::nativeDynamicSet` is
 * the BOXED dynamic-property expando a native type's `(this as any)[k] = v`
 * cast reaches, keyed and valued in `gea::Value`, not the typed table this
 * carrier's own index signature already states a value carrier for -- so an
 * array-typed (or otherwise unboxed) sidecar value had no box tag to go
 * through and refused outright, though the identical value already reads
 * back correctly through `recordIndexSidecarReadText` on the very same
 * carrier. Widening this function to the computed case, ahead of
 * `emitNativeSidecarSet` in `emitFieldStoreLines`'s own dispatch order
 * (unchanged), is what makes the store side total the way the read side
 * already is; `emitNativeSidecarSet` keeps its computed-key claim for every
 * receiver that has no such typed sidecar to route into at all.
 */
export const recordIndexAttributeKeyText = (index: RecordIndexSidecar, key: Representation, text: string): string =>
  index.key === 'number' && key.kind === 'scalar' ? `gea::PropertyKey::number(${text}).text()` : text

export const emitRecordIndexSidecarStore = (
  ctx: EmitContext,
  lines: string[],
  operation: SetOperation | DefineOwnPropertyOperation
): boolean => {
  const table = recordIndexSidecarTableOf(ctx, operation.receiver, operation.key)
  if (table === null) return false
  // Reconciled against the table's declared value carrier for the reason
  // `emit-properties.ts`'s `dictionary` branch states: the sidecar holds one
  // joined carrier, and a value written into it becomes that carrier through
  // the conversion, never through an overload that does not exist.
  const valueText = operandText(ctx, operation.value)
  // A post-definition indexed assignment must consult the same writable and
  // extensible state `Object.defineProperty` installed. The value itself
  // stays in the typed sidecar -- only the boolean result crosses this
  // control-flow boundary, never the value through `gea::Value`.
  const stored = alignedValueText(ctx, 'emit-carrier-members.ts:1094', operation.value.representation, table.value, valueText)
  if (stored === null)
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.value.representation)}->${representationKey(table.value)}`,
      'the indexed store has no selected native value conversion'
    )
  const extensible = table.accessor === '->' ? `gea::nativeIsExtensible(${table.receiver})` : 'true'
  const write = (() => {
    if (operation.kind !== 'define-own-property') {
      return `${table.receiver}${table.accessor}gea_writeOwnIndexNative(${table.propertyKey}, ${stored}, ${extensible})`
    }
    if (table.disjoint) {
      const attributes = operation.attributes
      const attributeKey = recordIndexAttributeKeyText(table.index, operation.key.representation, '__gea_key')
      return (
        `([&]() -> bool { const auto __gea_key = ${table.key}; const ${cppTypeOf(table.value)} __gea_value = ${stored}; ` +
        `const bool __gea_exists = ${table.member}has(__gea_key); if (!__gea_exists && !${extensible}) return false; ` +
        `const auto __gea_attribute_key = ${attributeKey}; auto __gea_attributes = ${table.attributes}.attributes(__gea_attribute_key); ` +
        `auto __gea_next = __gea_exists ? ${table.member}read(__gea_key) : __gea_value; ` +
        `if (!gea::applyNativeFixedDataDescriptor(__gea_next, __gea_attributes, __gea_value, __gea_exists, ` +
        `true, ${attributes.writable}, true, ${attributes.enumerable}, true, ${attributes.configurable})) return false; ` +
        `${table.member}operator[](__gea_key) = std::move(__gea_next); ${table.attributes}.set(__gea_attribute_key, __gea_attributes); return true; })()`
      )
    }
    const boxed =
      widenedStoreText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, table.value, stored) ??
      (table.value.kind === 'dynamic' ? stored : null)
    if (boxed === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(table.value)}->dynamic`,
        `define-own-property needs a transient descriptor value for "${representationKey(table.value)}", but that carrier has no authenticated Value boundary`
      )
    }
    const attributes = operation.attributes
    return (
      `([&]() -> bool { const gea::PropertyKey __gea_key = ${table.propertyKey}; ` +
      `gea::PropertyDescriptor __gea_descriptor = gea::PropertyDescriptor::assignment(${boxed}); ` +
      `__gea_descriptor.writable = ${attributes.writable}; __gea_descriptor.enumerable = ${attributes.enumerable}; ` +
      `__gea_descriptor.configurable = ${attributes.configurable}; ` +
      `if (${table.receiver}${table.accessor}gea_matchesOwnField(__gea_key)) ` +
      `return ${table.receiver}${table.accessor}gea_defineOwnField(__gea_key, __gea_descriptor, ${extensible}); ` +
      `return ${table.receiver}${table.accessor}gea_defineOwnIndex(__gea_key, __gea_descriptor, ${extensible}); })()`
    )
  })()
  if (operation.kind === 'set' && operation.strict) {
    lines.push(`if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot assign to indexed property");`)
  } else if (operation.kind === 'define-own-property') {
    lines.push(`if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot define indexed property");`)
  } else {
    lines.push(`${write};`)
  }
  // A store publishes the object it wrote into, not a success boolean, and it
  // NAMES the receiver rather than copying it -- the same handover every other
  // store branch performs.
  if (operation.result) defineValueAlias(ctx, operation.result, operandText(ctx, operation.receiver))
  return true
}

/**
 * Whether a scalar member read is a deferred `Number`/`BigInt.prototype`
 * method read. Stated once; the renderer and the walk both ask it.
 */
export const deferredScalarMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'scalar') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  const operand = { kind: 'operand', operand: receiver } as const
  if (carrier.domain === 'number' && numberPrototypeMethods.has(staticKey))
    return { receiverKind: 'number', member: staticKey, receiver: operand, receiverElement: null }
  if (carrier.domain === 'bigint' && (staticKey === 'toString' || staticKey === 'valueOf'))
    return { receiverKind: 'bigint', member: staticKey, receiver: operand, receiverElement: null }
  return null
}

export const scalarMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  if (receiver.representation.kind !== 'scalar') return null
  const domain = receiver.representation.domain
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey !== undefined) {
    // The same deferral `stringMemberText` performs, for the same reason: the
    // member has no receiver-carrying convention to build a callable from, so
    // the read renders nothing and the call that follows fuses the two.
    // `emit-prototype-invoke.ts` owns which keys that is.
    const claim = deferredScalarMethodClaim(ctx.staticKeyTexts, receiver, key)
    if (claim?.receiverKind === 'number') {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:scalar:get:false',
          `"${staticKey}" is a Number.prototype method, and this access publishes no value for its call to consume`
        )
      }
      return ''
    }
    if (claim?.receiverKind === 'bigint' && result !== null) return ''
    throw createCppEmitBlockedError(
      'property-access:scalar:get:false',
      `"${staticKey}" is a ${domain}-valued scalar's prototype method, not a data property; calling it needs a ` +
        'receiver-carrying calling convention this program did not derive one for, and reading it as a value has no native ' +
        `implementation installed -- only ${[...numberPrototypeMethods].join(', ')} are implemented, and only off a number`
    )
  }
  throw createCppEmitBlockedError(
    'property-access:scalar:get:true',
    'a scalar property access keyed by a non-constant key has no ToPropertyKey or native member table installed'
  )
}
