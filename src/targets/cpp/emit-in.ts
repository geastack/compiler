import type { HasPropertyOperation, IrOperand } from '../../ir/model.js'
import type { Ownership, RecordField, Representation } from '../../representation/model.js'
import { dictionaryKeyDomainOf } from '../../representation/model.js'
import {
  createCppEmitBlockedError,
  defineValue,
  isIntegerStorageValue,
  operandText,
  wellKnownSymbolMemberOf,
  type EmitContext
} from './emit-context.js'
import { keyedTableKeyText, memberAccessOperator } from './emit-carrier-members.js'
import { emitDynamicHasProperty, propertyKeyText } from './emit-dynamic-properties.js'
import { armAt, armIs } from './emit-union-properties.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import { cppRecordFieldPresenceName } from './types.js'
import { classPrototypeMemberIsPresent, symbolKeyedMemberIsDeclared } from '../../projection/class-property-presence.js'
import { binaryToStringTagText } from './emit-buffers.js'
import { regexpRoleOf } from './prototype/emit-prototype-regexp.js'
import { nativeRecordIndexHasPropertyOf } from '../../ir/native-record-index-transport.js'

/** A shape-named or inline record carrier's ownership, which decides whether its fields are reached through `.` or `->`. */
const ownershipOf = (carrier: Representation): Ownership =>
  carrier.kind === 'record' || carrier.kind === 'record-with-index' || carrier.kind === 'class-ref' || carrier.kind === 'native-record-ref'
    ? carrier.ownership
    : 'owned'

/**
 * `[[HasProperty]]` -- ECMA-262 10.1.7, reached from `k in o` (13.10.1 step 7).
 *
 * Four answers:
 *
 * - a receiver that owns a **runtime property table** consults it. A genuinely
 *   dynamic value is that case, and `emit-dynamic-properties.ts` renders it
 *   through the same `gea::PropertyKey` conversion every other internal method
 *   on that table goes through, so `in` cannot disagree with `get`/`set`/
 *   `delete` about what a key is;
 * - a **required own field** of a closed layout is present on every instance of
 *   that layout, so the answer is the constant `true`. The key had to be a
 *   static string for the field to be named at all;
 * - a **dictionary** is a layout that IS a key table, so the answer is that
 *   container's own non-inserting lookup.
 * - a compiler-owned object with shared identity asks its generated own-field
 *   dispatcher and dynamic-property sidecar, then combines that answer with
 *   prototype members known from the language and the class layout.
 *
 * The refusal is the load-bearing part. `in` walks the prototype chain, so the
 * tempting inverse of the second rule -- "the struct has no such field, answer
 * `false`" -- is wrong for every `Object.prototype` member (`'toString' in o`
 * is `true` for any ordinary object), and wrong again for an optional field or
 * an expando. Presence can be proven from a layout; absence is answered only
 * by the runtime table on an identity-bearing generated object. Every carrier
 * without that proof or table stays refused.
 *
 * `preflight/has-property-key.ts` computes the obligation key from exactly
 * these cases, so a program reaching this file has already been certified
 * against the one it lands on; the checks below are fail-closed re-checks of
 * that, not a first opinion -- the same posture `emit-iterator.ts` takes.
 */

/** Presence bits belong to physical slots, never to flattened checker fields. */
const fieldsOf = (ctx: EmitContext, receiver: Representation): readonly RecordField[] | null => {
  if (receiver.kind === 'record' || receiver.kind === 'record-with-index') return receiver.fields
  if (receiver.kind !== 'native-record-ref' && receiver.kind !== 'class-ref') return null
  return ctx.layouts.forShape(receiver.shapeId)
}

/** Whether this is an ordinary object whose layout the compiler emits and whose identity can own an expando sidecar. */
const generatedSharedObjectCarrier = (carrier: Representation): boolean => {
  if (carrier.kind === 'record' || carrier.kind === 'record-with-index' || carrier.kind === 'class-ref') {
    return carrier.ownership === 'shared-refcount'
  }
  return carrier.kind === 'native-record-ref' && carrier.native === null && carrier.ownership === 'shared-refcount'
}

/** A shared compiler-emitted record can answer a runtime string key without losing its native carrier. */
const generatedSharedRecordCarrier = (carrier: Representation): boolean =>
  (carrier.kind === 'record' || carrier.kind === 'record-with-index') && carrier.ownership === 'shared-refcount'

/** Whether this carrier has ordinary Object.prototype semantics, independent of whether it can own expandos. */
const generatedObjectCarrier = (carrier: Representation): boolean =>
  carrier.kind === 'record' ||
  carrier.kind === 'record-with-index' ||
  carrier.kind === 'class-ref' ||
  (carrier.kind === 'native-record-ref' && carrier.native === null)

/**
 * `k in u` over a `tagged-union` receiver -- decided PER ARM, and compiled to
 * a discriminant dispatch rather than a runtime property probe.
 *
 * This is sound for exactly the reason the general single-receiver rule above
 * stays this cautious about ever answering `false`: that worry is about the
 * PROTOTYPE CHAIN adding a member no layout here names. A tagged union's arms
 * are the checker's own closed set of alternatives, and TypeScript's `in`
 * operator already narrows a union the identical way at the type level --
 * `'respondWith' in this.#executionCtx` (`FetchEventLike | ExecutionContext`)
 * only narrows to `FetchEventLike` because that is the one arm whose type
 * declares the member, and the source only compiles under that same
 * narrowing. Compiling the discriminant test that mirrors it is rendering the
 * rule the checker already applied, not inventing a new one.
 *
 * Each arm answers from `fieldsOf` -- present (own field, required or
 * optional; TypeScript's own `in`-narrowing does not distinguish the two, so
 * this does not either) or absent -- except a `dictionary` arm, which is a
 * real runtime key table and answers through its own non-inserting `has`,
 * the identical primitive `layoutAnswerFor` already uses for a bare
 * dictionary receiver. Any other arm kind (`scalar`, `string`,
 * `array-object`, ...) structurally has no own-property table at all, so it
 * answers the constant `false`.
 *
 * A COMPUTED key stays refused (`null`): a per-arm dispatch of a
 * runtime-only key would need the identical per-arm reconciliation
 * `emit-union-properties.ts`'s own comment already declines to guess at for
 * `get`/`set`, and nothing in this task's evidence needed it for `in`.
 */
const taggedUnionInPropertyText = (
  ctx: EmitContext,
  union: Extract<Representation, { kind: 'tagged-union' }>,
  receiverText: () => string,
  key: IrOperand
): string | null => {
  // `in` dispatches per arm on whether the key IS a static name (2.3 invariant
  // 1's slot question is moot here; this is the property-key claim), so it
  // must ask `staticKeyTexts` -- a key `constantTexts` only later folds (a
  // render-time `typeof` result) must never be treated as a name the program
  // wrote, or a computed key would silently dispatch as a static one.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  const receiver = receiverText()
  const keyText = operandText(ctx, key)
  const armTexts = union.arms.map((arm, index) => {
    // A base class without this physical slot can still hold a descendant
    // that owns it, or an instance with an expando. Use the same native
    // presence route as a non-union receiver, rather than claiming absence.
    if (arm.value.kind === 'class-ref') return layoutAnswerFor(ctx, arm.value, () => armAt(receiver, index), key)
    const fields = fieldsOf(ctx, arm.value)
    if (fields !== null) {
      const field = fields.find((candidate) => candidate.key === staticKey)
      return field === undefined
        ? 'false'
        : `${armAt(receiver, index)}${memberAccessOperator(ownershipOf(arm.value))}${cppRecordFieldPresenceName(field.key)}`
    }
    if (arm.value.kind !== 'dictionary') return 'false'
    return `${armAt(receiver, index)}${memberAccessOperator(arm.value.ownership)}has(${keyText})`
  })
  if (armTexts.some((text) => text === null)) return null
  const dispatched = armTexts.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiver, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) return null
  // The key operand is rendered and discarded through a comma even on the
  // constant-answer arms above, for the identical ECMA-262 13.10.1 reason
  // the single-receiver `record(own-field)` branch below does: `in`
  // evaluates its key operand regardless of what the receiver turns out to
  // answer, and every branch here that skips reading it back would silently
  // leave that evaluation unrendered.
  return `((void)(${keyText}), ${armTexts.length > 1 ? `(${dispatched})` : dispatched})`
}

/**
 * The C++ expression for `key in receiver` over a carrier that answers from
 * its layout (or from its OWN presence, for a carrier the checker left
 * nullable), or `null` when none does.
 *
 * `receiverText` is a thunk rather than a materialized name for the identical
 * reason `operandText` alone was not enough here: an `optional` receiver
 * answers through its PAYLOAD, at the text `(*receiver)` -- a text this
 * function itself builds, not one `operandText` (an SSA-name lookup) could
 * ever produce. Every other branch still bottoms out at `operandText` for the
 * receiver `IrOperand` it was handed.
 */
const layoutAnswerFor = (ctx: EmitContext, carrier: Representation, receiverText: () => string, key: IrOperand): string | null => {
  if (carrier.kind === 'optional') {
    const payloadText = (): string => `(*${receiverText()})`
    const inner = layoutAnswerFor(ctx, carrier.payload, payloadText, key)
    if (inner === null) return null
    // `k in maybeNull` throws when the receiver is absent -- ECMA-262
    // 13.10.1's own non-Object check, reached before `[[HasProperty]]` is
    // ever consulted -- rendered here rather than guessed at as `false`,
    // exactly as `emit-instanceof.ts`'s `undefined` right-hand side renders
    // ITS spec-mandated throw instead of a fabricated answer.
    return `(${receiverText()}.has_value() ? (${inner}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  if (carrier.kind === 'tagged-union') return taggedUnionInPropertyText(ctx, carrier, receiverText, key)
  // Same claim as above: whether this key names a field the layout declares
  // must come from what the program wrote, not from anything render-time
  // folding has since added to `constantTexts`.
  const staticKey = ctx.staticKeyTexts.get(key.value) ?? null
  const wellKnownSymbol = wellKnownSymbolMemberOf(ctx, key)
  if (wellKnownSymbol === 'toStringTag' && binaryToStringTagText(carrier) !== null) {
    return `((void)(${operandText(ctx, key)}), (void)(${receiverText()}), true)`
  }
  if (regexpRoleOf(carrier) === 'pattern') {
    const receiver = receiverText()
    const property = propertyKeyText(ctx, key, 'an "in" test on Pattern')
    return `((void)(${operandText(ctx, key)}), ${receiver} ? gea::runtime::regex::dynamicHas(${receiver}, ${property}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  if (staticKey !== null && carrier.kind === 'class-ref' && classPrototypeMemberIsPresent(ctx.classes, carrier.declaration, staticKey)) {
    const present =
      ownershipOf(carrier) === 'shared-refcount'
        ? `(${receiverText()} ? true : (gea::host::throwInPropertyNonObject(), false))`
        : `((void)(${receiverText()}), true)`
    return `((void)(${operandText(ctx, key)}), ${present})`
  }
  const fields = fieldsOf(ctx, carrier)
  const field = staticKey === null ? undefined : fields?.find((candidate) => candidate.key === staticKey)
  if (field !== undefined) {
    // A fixed native slot can be removed by a configurable delete, including a
    // TypeScript-required field. The generated presence bit is therefore the
    // physical own-property answer for every declared field, not merely for
    // `?:` fields. Both operands remain evaluated before that answer.
    return `((void)(${operandText(ctx, key)}), ${receiverText()}${memberAccessOperator(ownershipOf(carrier))}${cppRecordFieldPresenceName(field.key)})`
  }
  if (staticKey !== null && generatedObjectCarrier(carrier) && objectPrototypeMemberNames.has(staticKey)) {
    const present =
      ownershipOf(carrier) === 'shared-refcount'
        ? `(${receiverText()} ? true : (gea::host::throwInPropertyNonObject(), false))`
        : `((void)(${receiverText()}), true)`
    return `((void)(${operandText(ctx, key)}), ${present})`
  }
  if (staticKey === null && nativeRecordIndexHasPropertyOf(ctx.deriver, carrier, key.representation)) {
    const receiver = receiverText()
    const property = propertyKeyText(ctx, key, 'an "in" test on a typed record index')
    return `(${receiver} ? gea::nativeDynamicHasProperty(${receiver}, ${property}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  if (wellKnownSymbol !== null && generatedObjectCarrier(carrier)) {
    return `((void)(${operandText(ctx, key)}), (void)(${receiverText()}), false)`
  }
  if (staticKey !== null && generatedSharedObjectCarrier(carrier)) {
    const receiver = receiverText()
    const keyText = propertyKeyText(ctx, key, 'an "in" test on a native receiver')
    return `((void)(${operandText(ctx, key)}), ${receiver} ? gea::nativeDynamicHas(${receiver}, ${keyText}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  // A symbol key read out of a binding rather than spelled as a name -- see
  // `symbolKeyedMemberIsDeclared`, which states why this receiver's own
  // sidecar is the WHOLE answer rather than half of one. The same
  // `gea::nativeDynamicHas` the static-key branch above uses, given a
  // `gea::PropertyKey::symbol(...)` instead of a name.
  if (
    staticKey === null &&
    key.representation.kind === 'symbol' &&
    generatedSharedObjectCarrier(carrier) &&
    !symbolKeyedMemberIsDeclared(ctx.classes, fields, carrier.kind === 'class-ref' ? carrier.declaration : null)
  ) {
    const receiver = receiverText()
    const keyText = propertyKeyText(ctx, key, 'an "in" test with a symbol key on a native receiver')
    return `(${receiver} ? gea::nativeDynamicHas(${receiver}, ${keyText}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  if (staticKey === null && key.representation.kind === 'string' && generatedSharedRecordCarrier(carrier)) {
    const receiver = receiverText()
    const keyText = propertyKeyText(ctx, key, 'an "in" test on a native record')
    return `(${receiver} ? gea::nativeDynamicHasProperty(${receiver}, ${keyText}) : (gea::host::throwInPropertyNonObject(), false))`
  }
  // An `array-object` keeps its own presence bit per index (a hole is a real
  // ECMA-262 distinction, not merely a stored `undefined` -- see
  // `ArrayObject::present`'s own comment), so a canonical numeric key answers
  // from the identical bounds-and-hole test an indexed read already reduces
  // to, rather than from any layout proof. Only a static key is claimed here
  // (`hasPropertyHelperClaims` below): a runtime numeric key is unclaimed
  // until a program actually needs it.
  if (
    carrier.kind === 'array-object' &&
    staticKey !== null &&
    key.representation.kind === 'scalar' &&
    key.representation.domain === 'number'
  ) {
    const receiver = receiverText()
    const keyText = operandText(ctx, key)
    const reader = isIntegerStorageValue(ctx, key.value) ? 'hasElementAtIndex' : 'hasElement'
    return `${receiver}->${reader}(${keyText})`
  }
  if (carrier.kind !== 'dictionary') return null
  if (carrier.key === 'string' && key.representation.kind === 'symbol') {
    // A string-keyed Dictionary has no symbol-key storage. Any attempted
    // symbol write is refused before a program can certify, and the ordinary
    // Object prototype contributes no Symbol.toStringTag of its own, so a
    // symbol lookup on the representable table is exactly false. Preserve
    // evaluation of both operands even though neither value decides it.
    return `((void)(${operandText(ctx, key)}), (void)(${receiverText()}), false)`
  }
  if (carrier.key === 'string' && key.representation.kind === 'dynamic') {
    // A BOXED key against the same string-keyed table. `keyedTableKeyText`
    // below would reach it too, but only through `toStringText`, and `in` is
    // ToPropertyKey (7.1.19), not ToString: the two differ on exactly one tag,
    // and it is the tag that matters here. A symbol IS a legal `in` key and
    // answers `false` against a table with no symbol storage -- the branch just
    // above says so for a statically-symbol key -- whereas ToString of one is a
    // TypeError. Converting first and testing the tag afterwards keeps the two
    // spellings of the same question answering the same thing.
    //
    // hono's trie router is what needs it: `key in curNode.#children`, where
    // `key` is `Array.isArray(pattern) ? pattern[0] : p` and TypeScript types
    // the true arm `any` -- `Array.isArray`'s `arg is any[]` filters nothing
    // out of a union whose array member is a READONLY tuple, so the narrowing
    // widens instead of narrowing. The key really is a string at runtime; the
    // box is the checker's answer, not this program's intent.
    const receiver = receiverText()
    const property = propertyKeyText(ctx, key, 'an "in" test on a string-keyed table')
    return (
      `[&]() -> bool { const gea::PropertyKey __gea_in_key = ${property}; if (__gea_in_key.isSymbol()) return false; ` +
      `return ${receiver}${memberAccessOperator(carrier.ownership)}has(__gea_in_key.text()); }()`
    )
  }
  // Every typed table's own non-inserting membership test is exactly
  // `[[HasProperty]]`. Reuse the subscript-key reconciliation so a symbol
  // table receives a Symbol identity and a property table preserves key text.
  return `${receiverText()}${memberAccessOperator(carrier.ownership)}has(${keyedTableKeyText(ctx, key, dictionaryKeyDomainOf(carrier.key, key.representation))})`
}

const layoutAnswerText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): string | null =>
  layoutAnswerFor(ctx, receiver.representation, () => operandText(ctx, receiver), key)

/**
 * The single `[[HasProperty]]` dispatcher.
 *
 * The runtime-table renderer is asked first and the layout rules second because
 * the two are disjoint by construction -- a `dynamic` receiver has no layout to
 * read fields from, and no other carrier owns that table -- so the order states
 * a preference that can never be exercised rather than hiding a fallthrough.
 */
export const emitHasProperty = (ctx: EmitContext, lines: string[], operation: HasPropertyOperation): void => {
  if (emitDynamicHasProperty(ctx, lines, operation)) return
  const answer = layoutAnswerText(ctx, operation.receiver, operation.key)
  if (answer !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${answer};`)
    return
  }
  // `keyForm` mirrors the `static-${domain}` vs bare-`${domain}` split
  // `preflight/has-property-key.ts`'s obligation key already makes (a
  // compile-time-known key proves more than the same domain read at
  // runtime), so a refusal here lands in the identical `computation:in:*`
  // namespace the certifier's successful claims occupy.
  // The refusal's key form must name the SAME claim certification made about
  // this key -- `staticKeyTexts`, not `constantTexts` -- or a key certified
  // dynamic could print a `static-*` refusal that names no obligation the
  // certifier ever considered.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  const keyForm = staticKey === undefined ? operation.key.representation.kind : `static-${operation.key.representation.kind}`
  throw createCppEmitBlockedError(
    `runtime-helper:computation:in:${keyForm}:${operation.receiver.representation.kind}`,
    `"in" over a "${operation.receiver.representation.kind}" receiver has no [[HasProperty]] in this emitter: presence is provable ` +
      'only from a required own field of a closed layout, from a carrier that keeps a runtime key table, or from a real property ' +
      'table, and absence is never provable from a layout at all (the prototype chain is part of the operator)'
  )
}

/**
 * The `computation:in:*` rows this file renders, stated here rather than in
 * `manifest.ts` so the claim and the rendering are one authority: a row added
 * to the manifest without a branch above would certify a program this file then
 * refuses, which is the certify-then-crash the whole obligation census exists
 * to prevent.
 *
 * `record(own-field)` is the constant `true` above; the two `dictionary(...)`
 * domains are the two containers' own `has`, claimed separately because
 * `gea::Dictionary` (string-keyed) and `gea::NumericDictionary` (double-keyed)
 * are different types and a key of the wrong domain would not compile.
 *
 * The `dynamic` rows are the four key forms `propertyKeyText` can turn into a
 * `gea::PropertyKey` -- a string constant, a numeric constant, a `std::string`,
 * a `gea::Symbol`, and a number through ToString. A boolean or bigint key is
 * deliberately absent: ToPropertyKey over one is ToString of it, which is a
 * conversion this backend does not install for those domains, so it is refused
 * by name at the site rather than certified here and crashed on there.
 */
export const hasPropertyHelperClaims: readonly string[] = [
  'computation:in:static-string:class(prototype-member)',
  'computation:in:static-number:class(prototype-member)',
  'computation:in:static-string:optional(class(prototype-member))',
  'computation:in:static-number:optional(class(prototype-member))',
  'computation:in:static-string:record(own-field)',
  'computation:in:static-number:record(own-field)',
  // `record(optional-field)` reads the field's generated presence flag -- the same
  // bit `host/object-protocol.ts` reads to decide whether the key is in the
  // object's own key set. Claimed for any record-shaped carrier, plain or
  // named, because this answer proves the key IS there and a prototype can
  // only ever add keys.
  'computation:in:static-string:record(optional-field)',
  'computation:in:static-number:record(optional-field)',
  'computation:in:static-string:record(object-prototype-member)',
  'computation:in:static-string:optional(record(object-prototype-member))',
  'computation:in:static-string:record(sidecar)',
  'computation:in:static-number:record(sidecar)',
  'computation:in:string:record(sidecar)',
  // A SYMBOL key over the same shared sidecar -- `layoutAnswerFor`'s own
  // `key.representation.kind === 'symbol'` branch above, gated on the layout
  // declaring no symbol-keyed slot of its own so the sidecar's verdict is the
  // complete one (`symbolKeyedMemberIsDeclared`). `@hono/node-server`'s
  // `cacheKey in res` is what needed it, three times over.
  'computation:in:symbol:record(symbol-sidecar)',
  'computation:in:symbol:record(disjoint-index)',
  'computation:in:number:record(disjoint-index)',
  'computation:in:static-string:optional(record(sidecar))',
  'computation:in:static-number:optional(record(sidecar))',
  'computation:in:string:optional(record(sidecar))',
  'computation:in:static-string:optional(record(optional-field))',
  'computation:in:static-number:optional(record(optional-field))',
  'computation:in:static-string:dictionary(string)',
  'computation:in:string:dictionary(string)',
  'computation:in:symbol:dictionary(string)',
  // A boxed key against a string-keyed table -- the ToPropertyKey branch above.
  'computation:in:dynamic:dictionary(string)',
  'computation:in:static-number:dictionary(number)',
  'computation:in:number:dictionary(number)',
  'computation:in:tagged-union:dictionary(number)',
  'computation:in:symbol:dictionary(symbol)',
  'computation:in:static-string:dynamic',
  'computation:in:static-number:dynamic',
  'computation:in:string:dynamic',
  'computation:in:symbol:dynamic',
  'computation:in:number:dynamic',
  // A boxed KEY over a boxed receiver -- `propertyKeyText`'s own `dynamic`
  // branch, which renders ToPropertyKey (7.1.19) off the box's tag.
  'computation:in:dynamic:dynamic',
  // The identical six rows one `optional` layer out -- a receiver the checker
  // left nullable (`this.image` typed `HTMLVideoElement | null`, three.js's
  // own `if ('requestVideoFrameCallback' in video)`), answered by
  // `layoutAnswerFor`'s presence test plus the SAME record/dictionary rule
  // asked of the unwrapped payload. `optional(record(unproven))` and
  // `optional(dynamic)` are deliberately absent: both recurse to the same
  // `null` their bare counterparts already do, so claiming them would be the
  // exact over-claim `has-property-key.ts`'s own doc comment warns against.
  'computation:in:static-string:optional(record(own-field))',
  'computation:in:static-number:optional(record(own-field))',
  'computation:in:static-string:optional(dictionary(string))',
  'computation:in:string:optional(dictionary(string))',
  'computation:in:static-number:optional(dictionary(number))',
  'computation:in:number:optional(dictionary(number))',
  'computation:in:symbol:optional(dictionary(symbol))',
  // `k in pattern` over a native RegExp `Pattern` with a RUNTIME string key --
  // `layoutAnswerFor`'s `regexpRoleOf(carrier) === 'pattern'` branch above,
  // checked ahead of every other rule in this file for exactly this receiver,
  // so its own dynamic-property sidecar (`gea::runtime::regex::dynamicHas`)
  // answers `in` the same way it already answers a computed `[key]` read/
  // write. Only the exercised key form is claimed here (see this list's own
  // closing comment on unverified rows); a static key, an optional Pattern, or
  // a non-string dynamic key against Pattern are unclaimed until measured.
  'computation:in:string:record(pattern)',
  // `k in u` over a `tagged-union` receiver, static key only
  // (`taggedUnionInPropertyText` above) -- `has-property-key.ts`'s
  // `layoutAnswerSuffix` falls through to the bare `layout.kind` for any
  // representation kind it does not special-case, which is exactly
  // `"tagged-union"` for this receiver. A COMPUTED key stays unclaimed: that
  // half is still refused (see this file's own comment on
  // `taggedUnionInPropertyText`), and `optional(tagged-union)` is left
  // unclaimed too -- the recursion in `layoutAnswerFor` renders it for free,
  // but nothing in this task's evidence exercised it, and claiming an
  // unverified case is exactly what this list exists to prevent.
  'computation:in:static-string:tagged-union',
  // A static numeric key against an Array's own indexed elements --
  // `layoutAnswerFor`'s `array-object` branch above, which reduces `in` to
  // the same bounds-and-hole test `ArrayObject::hasElement`/
  // `hasElementAtIndex` already answers for an indexed read. `0 in tail`
  // over a rest-destructured/spread-gathered array (`dynamic-iterator-gather.ts`)
  // is what needed this; a dynamic numeric key stays unclaimed.
  'computation:in:static-number:array-object'
]
