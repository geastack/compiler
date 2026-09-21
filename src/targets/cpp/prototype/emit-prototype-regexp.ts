import type { IrOperand, IrResult, SetOperation, DefineOwnPropertyOperation } from '../../../ir/model.js'
import type { IrValueId } from '../../../identity/ids.js'
import type { Ownership, RecordAccessor, RecordField, RecordIndexSidecar, Representation } from '../../../representation/model.js'
import { representationKey } from '../../../representation/model.js'
import type { RegExpDeclarationKind } from '../../../representation/policies.js'
import { recordLayoutPolicyOf } from '../../../projection/fields.js'
import {
  createCppEmitBlockedError,
  defineValue,
  operandText,
  wellKnownSymbolMemberOfKey,
  type EmitContext,
  type PrototypeMethodRead
} from '../emit-context.js'
import { memberAccessOperator } from '../emit-carrier-members.js'
import { boxedValueText, propertyKeyText, unboxedReadText } from '../emit-dynamic-properties.js'
import { alignedValueText } from '../emit-narrowing.js'
import { toStringText } from '../emit-tostring.js'
import { cppRecordFieldKeyIsSymbol, cppRecordFieldName } from '../types.js'
import { cppRecordIndexSidecarNameFor } from '../records.js'
import { cppConstructPatternEntry, cppRegExpNativeTypes, cppStringObjectNativeType } from '../regexp-types.js'
import { arrayPrototypeMethods } from './emit-prototype-array.js'

/**
 * `RegExp.prototype`, `RegExpExecArray` and `RegExpMatchArray`, as this
 * backend renders them.
 *
 * The mechanism for the two METHODS is `emit-prototype-invoke.ts`'s deferred
 * `[[Get]]` fused with the call that follows -- the same one String and Array
 * use, for the same reason: `re.test` on its own is a function value bound to
 * a receiver, and this backend mints no such value.
 *
 * The DATA members are rendered here and now, because on this carrier they
 * really are native slots. `lastIndex` is deliberately different: it is the
 * one writable own data property, so its cell retains a `gea::Value` and the
 * typed read/write paths use the same native property operations as computed
 * paths. Pattern itself remains a native shared reference throughout.
 *
 * Nothing here is allowed to fall through to the generic struct-member path.
 * That path emits `receiver->key` for ANY key, so an unimplemented member
 * would reach clang as an unknown-member error instead of a refusal naming the
 * member -- which is the exact bug this lane exists to fix on the String side.
 */

/** Which of the three regular-expression carriers an operand holds, or `null` for anything else. */
export const regexpRoleOf = (representation: Representation): RegExpDeclarationKind | null => {
  if (representation.kind !== 'native-record-ref' || representation.native === null) return null
  if (representation.native === cppRegExpNativeTypes.pattern) return 'pattern'
  if (representation.native === cppRegExpNativeTypes['exec-result']) return 'exec-result'
  if (representation.native === cppRegExpNativeTypes['match-result']) return 'match-result'
  return null
}

/** The record layout an object-shaped pattern argument exposes, or `null` for a carrier whose members this cannot read. */
const objectPatternLayoutOf = (
  ctx: EmitContext,
  carrier: Representation
): {
  readonly fields: readonly RecordField[]
  readonly accessors: readonly RecordAccessor[]
  readonly ownership: Ownership
  readonly indexes: readonly RecordIndexSidecar[]
} | null => {
  if (carrier.kind === 'record') return { fields: carrier.fields, accessors: carrier.accessors, ownership: carrier.ownership, indexes: [] }
  // An object that also declares an index signature is still the ordinary
  // object 22.2.4.1 step 6 reads `source`/`flags` off -- the index is where
  // its OTHER keys live, and `@@match` is one of them whenever the object
  // states it with a computed symbol key. Declining the whole carrier for
  // having an index refused `{ [Symbol.match]: false, source, toString() }`
  // outright.
  if (carrier.kind === 'record-with-index')
    return { fields: carrier.fields, accessors: [], ownership: carrier.ownership, indexes: carrier.indexes }
  // A `native` name means a compiler-owned layout (Pattern, Date, a recursive
  // wrapper) or a host struct, none of which is the ordinary object 22.2.4.1
  // step 6 reads `source`/`flags` off.
  if (carrier.kind !== 'native-record-ref' || carrier.native !== null) return null
  const layouts = recordLayoutPolicyOf(ctx.deriver, ctx.classes)
  const fields = layouts.forShape(carrier.shapeId)
  if (fields === null) return null
  return { fields, accessors: layouts.accessorsForShape?.(carrier.shapeId) ?? [], ownership: carrier.ownership, indexes: [] }
}

/**
 * One `Get(pattern, key)` of 22.2.4.1 step 6, already folded through
 * `RegExpInitialize`'s own ToString of the result (22.2.3.2 steps 1 and 3).
 *
 * A key the shape does not declare is `undefined`, which `RegExpInitialize`
 * turns into the empty string -- so an object with `[Symbol.match]` but no
 * `flags` really does construct an unflagged pattern, and that is an answer,
 * not a gap. A key backed by an ACCESSOR or by a field that may be absent is
 * not: the first is a call this has no receiver-binding machinery for and the
 * second makes "declared" and "present" different questions, so both refuse.
 */
const objectPatternMemberText = (
  ctx: EmitContext,
  layout: { readonly fields: readonly RecordField[]; readonly accessors: readonly RecordAccessor[]; readonly ownership: Ownership },
  text: string,
  key: string
): string | null => {
  if (layout.accessors.some((accessor) => accessor.key === key)) return null
  const field = layout.fields.find((candidate) => candidate.key === key)
  if (field === undefined) return 'std::string()'
  if (!field.required) return null
  return toStringText(`${text}${memberAccessOperator(layout.ownership)}${cppRecordFieldName(key)}`, field.value, ctx.classes, ctx.deriver)
}

/**
 * ECMA-262 22.2.4.1 steps 5-7 for a pattern argument that is an ordinary
 * OBJECT -- neither a string nor a value already carrying `[[RegExpMatcher]]`.
 *
 * Step 5 has already been answered `false` by the caller: a value with the
 * internal slot is exactly this backend's `Pattern` carrier, which the caller
 * spells directly. What remains is the choice between step 6 and step 7, and
 * it turns on `patternIsRegExp` -- `IsRegExp` (22.1.3.6), which for an object
 * without the slot is `ToBoolean(Get(pattern, @@match))`.
 *
 * That is a RUNTIME question here even though the shape is fully static:
 * `{ [Symbol.match]: true }` gives the member the widened type `boolean`, so
 * no carrier proves which branch runs and both are rendered. The WHOLE
 * construction is what the conditional selects, not the two arguments
 * separately: `patternIsRegExp` is computed once at step 2 in the language, and
 * a conditional per argument would read the member twice, in an order C++ does
 * not fix, with step 7's ToString -- potentially a call to the object's own
 * `toString` -- able to run between the two reads and change the second.
 *
 * A shape that declares no `@@match` member at all answers `IsRegExp` false
 * statically, and only step 7 is rendered.
 *
 * `null` is returned for anything this cannot answer exactly, leaving the
 * caller's own refusal to name the carrier.
 */
export const regExpConstructionFromObject = (ctx: EmitContext, argument: IrOperand, flagsArgument: IrOperand | null): string | null => {
  const carrier = argument.representation
  const layout = objectPatternLayoutOf(ctx, carrier)
  if (layout === null) return null
  // Every text this composes is a `std::string`, so a flags argument that is
  // not already one would have to be ToStringed into the same conditional; a
  // non-string carrier there leaves the whole construction to the caller's
  // refusal rather than answering half of it.
  if (flagsArgument !== null && flagsArgument.representation.kind !== 'string') return null
  const flagsText = flagsArgument === null ? null : operandText(ctx, flagsArgument)
  const text = operandText(ctx, argument)
  // Step 7 reaches `RegExpInitialize` with the object itself, whose ToString
  // is the ONE authority every other spelling of that operation uses.
  const stringified = toStringText(text, carrier, ctx.classes, ctx.deriver)
  const absentFlags = flagsText ?? 'std::string()'
  const match = layout.fields.find(
    (field) => cppRecordFieldKeyIsSymbol(field.key) && wellKnownSymbolMemberOfKey(ctx.wellKnownSymbols, field.key) === 'match'
  )
  const initialize = (pattern: string, flags: string): string => `${cppConstructPatternEntry}(${pattern}, ${flags})`
  // A symbol-keyed index is where a computed `[Symbol.match]` key lands, so
  // an object carrying one has NOT been shown to lack `@@match` -- reading it
  // as absent and going straight to step 7 would answer a question the layout
  // never settled. `SymbolDictionary::read` returns a default-constructed
  // value for a key it does not hold, which for a boolean table is `false`:
  // exactly the `undefined`-is-falsy the specification asks for, so presence
  // and value collapse into the one read the condition already needs.
  //
  // Only a boolean table is admitted, for the same reason the named-field
  // branch below admits only a boolean field: any other carrier makes the
  // condition a ToBoolean of an arbitrary value, which is a different
  // operation than this composes.
  const symbolIndex = layout.indexes.find((index) => index.key === 'symbol')
  const indexedMatch =
    match === undefined && symbolIndex !== undefined && symbolIndex.value.kind === 'scalar' && symbolIndex.value.domain === 'boolean'
      ? `${text}${memberAccessOperator(layout.ownership)}${cppRecordIndexSidecarNameFor(symbolIndex, layout.indexes)}` +
        '.read(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Match))'
      : null
  if (match === undefined && symbolIndex !== undefined && indexedMatch === null) return null
  if (match === undefined && indexedMatch === null) return stringified === null ? null : initialize(stringified, absentFlags)
  // The presence bit and the value are two different facts; a member that may
  // be absent would need both tested, so it refuses rather than reading a
  // field whose storage the language says is not there.
  if (match !== undefined && (!match.required || match.value.kind !== 'scalar' || match.value.domain !== 'boolean')) return null
  const source = objectPatternMemberText(ctx, layout, text, 'source')
  // Step 6.b: the object's own `flags` is consulted only when the CALL passed
  // none. A supplied flags argument is step 6.c and wins in both arms.
  const ownFlags = flagsText === null ? objectPatternMemberText(ctx, layout, text, 'flags') : flagsText
  if (stringified === null || source === null || ownFlags === null) return null
  const condition = match !== undefined ? `${text}${memberAccessOperator(layout.ownership)}${cppRecordFieldName(match.key)}` : indexedMatch!
  return `(${condition} ? ${initialize(source, ownFlags)} : ${initialize(stringified, absentFlags)})`
}

/**
 * The ten `RegExp.prototype` accessors (ECMA-262 22.2.6), each a real member of
 * the ported `Pattern` under the interface's own name.
 *
 * `lastIndex` is in the same table as the other nine and is the only one that
 * is not read-only -- 22.2.6.9 makes it an own writable data property while
 * the rest are prototype getters. Both directions land on the same C++ member,
 * so the read table is the write table.
 */
const patternDataMembers: ReadonlySet<string> = new Set([
  'source',
  'flags',
  'lastIndex',
  'global',
  'ignoreCase',
  'multiline',
  'sticky',
  'unicode',
  'dotAll',
  'hasIndices'
])

/**
 * The `RegExp.prototype` methods this backend renders.
 *
 * Deliberately absent, each refused BY NAME at its access below:
 *
 * - `compile` -- ECMA-262 B.2.3, a legacy Annex B method that RE-INITIALIZES an
 *   existing pattern in place. Nothing here has been built for it, and it is
 *   the one member whose whole purpose is to make a pattern object change
 *   identity of behaviour mid-life.
 * - the six `Symbol.match`/`Symbol.matchAll`/`Symbol.replace`/`Symbol.search`/
 *   `Symbol.split`/`Symbol.species` members -- these are reached by SYMBOL
 *   key, so they arrive with no constant text at all and are refused by the
 *   non-constant branch. The String-side members that dispatch THROUGH them
 *   (`s.match(re)` and friends) are rendered, directly, in
 *   `emit-prototype-string.ts`: the indirection through a well-known symbol is
 *   an extension point this backend does not install, not the operation.
 */
const patternMethods: ReadonlySet<string> = new Set(['test', 'exec', 'toString'])

/**
 * The NAMED members of the two match-result interfaces.
 *
 * `length` is named here because match-result access is routed through this
 * native member table. `MatchResult` inherits `ArrayObject<string>`, so its
 * value comes from the base carrier's `length()` method.
 *
 * `indices` (the ES2022 `d` flag, `RegExpIndicesArray`) is deliberately
 * absent and refused by name: it needs a per-capture `[start, end]` tuple
 * array that neither this runtime nor v1's builds, and `std::regex` does not
 * report group positions for non-participating groups at all.
 */
const resultDataMembers: ReadonlySet<string> = new Set(['index', 'input', 'length', 'groups'])

/**
 * What each of those members PHYSICALLY holds, per role.
 *
 * Stated here because nothing else can state it. These two structs are
 * compiler-owned native layouts: `representation/derive.ts` deliberately does
 * NOT seal a record layout for `RegExpExecArray`/`RegExpMatchArray` -- see its
 * own comment on why sealing "a plausible-looking struct" for them would emit
 * a program that compiles and is not a regular expression -- so
 * `recordFieldsOfShape` answers nothing for their shape id and the generic
 * `narrowedFieldReadText` has no declared carrier to reconcile against. It
 * therefore returned the bare member load for every read, which is right only
 * while the read is NOT narrowed.
 *
 * It is wrong the moment it is. `if (m.groups !== undefined) m.groups['id']`
 * publishes the payload while the field stores the optional, and the bare load
 * emitted `Optional<Ref<Dictionary<std::string>>>` where a
 * `Ref<Dictionary<std::string>>` was wanted -- `->has` then resolved on
 * `gea::Ref`, which has no such member, and every program that read a named
 * capture group by key failed to compile (node-compat's `apps/http-parity`
 * router was the first). The narrowing obligation the `narrow` parameter
 * documents was being honoured at the call and dropped inside it, for want of
 * this table.
 *
 * The three optionals are the two interfaces' own `?`, and they differ by
 * role on purpose: `RegExpExecArray` declares `index`/`input` REQUIRED and
 * `RegExpMatchArray` declares them optional, because a global pattern's match
 * really does answer an array with neither. `length` is `double` on an exec
 * result and the inherited `ArrayObject::length()` on a match result; neither
 * is optional. Keep this in step with `ExecResult`/`MatchResult` in
 * `runtime/gea_runtime.h` -- they are the same two facts, and clang checks
 * only one of them.
 */
const namedGroupsStorage: Representation = {
  kind: 'optional',
  payload: { kind: 'dictionary', key: 'string', value: { kind: 'string' }, ownership: 'shared-refcount' },
  absence: 'undefined'
}
const numberStorage: Representation = { kind: 'scalar', domain: 'number' }
const stringStorage: Representation = { kind: 'string' }
const optionalOf = (payload: Representation): Representation => ({ kind: 'optional', payload, absence: 'undefined' })

const resultDataMemberStorage = (role: RegExpDeclarationKind, key: string): Representation | null => {
  if (key === 'groups') return namedGroupsStorage
  if (key === 'length') return numberStorage
  if (key === 'index') return role === 'match-result' ? optionalOf(numberStorage) : numberStorage
  if (key === 'input') return role === 'match-result' ? optionalOf(stringStorage) : stringStorage
  return null
}

/** Whether `text` is a canonical array index -- a run of digits with no sign, point, or leading zero. */
const canonicalCaptureSlot = (text: string): boolean => {
  if (text.length === 0) return false
  if (text.length > 1 && text.charCodeAt(0) === 48) return false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 48 || code > 57) return false
  }
  return true
}

/** Whether a read's own carrier is `string`, or an optional whose payload is. */
const capturePayloadOf = (representation: Representation | undefined): 'string' | 'optional-string' | null => {
  if (representation === undefined) return null
  if (representation.kind === 'string') return 'string'
  if (representation.kind === 'optional' && representation.payload.kind === 'string') return 'optional-string'
  return null
}

/**
 * A capture slot read -- `m[0]`, `m[1]`, `m[i]`.
 *
 * Rendered through `capture`/`capturedOrAbsent` rather than as a member or a
 * sidecar lookup, and the choice between the two is the READ's own carrier,
 * never a preference. `RegExpExecArray extends Array<string>`, so an ordinary
 * program types `m[1]` as `string` and cannot observe a non-participating
 * group's `undefined` at all; a program compiled with
 * `noUncheckedIndexedAccess` types the same read `string | undefined` and can.
 * Answering the first with an optional would not compile, and answering the
 * second with the empty string would be a silently wrong answer for a case the
 * program is written to handle -- so both spellings exist and the plan picks.
 */
const captureReadText = (
  role: RegExpDeclarationKind,
  receiverText: string,
  slotText: string,
  result: Representation | undefined
): string => {
  const payload = capturePayloadOf(result)
  if (payload === null) {
    throw createCppEmitBlockedError(
      `property-access:${role}:get:true`,
      `a capture slot of a ${role} carries "${result ? representationKey(result) : 'nothing'}"; ECMA-262 22.2.7.2 puts a string or \`undefined\` in ` +
        'every slot, so this backend renders the read only into a string or an optional string'
    )
  }
  return `${receiverText}->${payload === 'string' ? 'capture' : 'capturedOrAbsent'}(${slotText})`
}

/**
 * A `[[Get]]` off any of the three regular-expression carriers, or `null` when
 * the receiver is not one -- in which case `emitGet` carries on unchanged.
 *
 * An empty string is a deferred method read, the same convention every other
 * prototype table in this directory uses.
 */
/**
 * Whether a RegExp-family member read is a deferred prototype-method read, and
 * what it is.
 *
 * Two shapes under one claim, because `regexpRoleOf` is what tells them apart:
 * a PATTERN's own `RegExp.prototype` method, and an `Array.prototype` method
 * reached through a match RESULT, which really is an Array in the language
 * (22.1.3.13) and is read through `gea::runtime::regex::matchElements` -- a
 * view over the receiver, which is why the receiver travels as its own kind
 * rather than as pre-rendered text.
 *
 * Stated once; `regexpMemberText` and the prototype-read walk both ask it.
 */
export const deferredRegexpMethodClaim = (
  // Every caller passes `ctx.staticKeyTexts`; named for that so nobody hands
  // this the render-widened `ctx.constantTexts` by mistake.
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const role = regexpRoleOf(receiver.representation)
  if (role === null) return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  if (role === 'pattern') {
    if (staticKey === 'lastIndex' || patternDataMembers.has(staticKey) || !patternMethods.has(staticKey)) return null
    return { receiverKind: 'regexp', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
  }
  if (resultDataMembers.has(staticKey) || canonicalCaptureSlot(staticKey)) return null
  if (!arrayPrototypeMethods.has(staticKey)) return null
  const element: Representation = { kind: 'string' }
  return {
    receiverKind: 'array-object',
    member: staticKey,
    receiver: { kind: 'match-elements', operand: receiver },
    receiverElement: representationKey(element),
    arrayCarrier: { kind: 'array-object', element, ownership: 'shared-refcount', extension: null }
  }
}

export const regexpMemberText = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand,
  result: IrValueId | null,
  resultRepresentation: Representation | undefined,
  // The caller's own narrowing reconciliation, applied to the DATA members
  // and to nothing else. A read of `m.groups` guarded by `m.groups !==
  // undefined` publishes the payload carrier while the field stores the
  // optional, and that is exactly the reconciliation the generic struct-member
  // path already performs -- this branch preempts that path, so it has to
  // carry the same obligation rather than emit a raw member access that then
  // fails to assign. The capture reads below do NOT go through it: they choose
  // between `capture` and `capturedOrAbsent` on the published carrier already,
  // and are not fields at all.
  //
  // `declared` is what the member physically holds. The caller cannot look it
  // up for these two receivers -- their layout is never sealed -- so this
  // supplies it from `resultDataMemberStorage`, and passing `null` (a RegExp
  // pattern member) leaves the caller on its own lookup exactly as before.
  narrow: (fieldName: string, storage: string, declared: Representation | null) => string
): string | null => {
  const role = regexpRoleOf(receiver.representation)
  if (role === null) return null
  const receiverText = operandText(ctx, receiver)
  // A claim, not a fold: this decides whether the access is a STATIC member at
  // all, so it must not see a key text `constantTexts` only holds because the
  // render minted it (a folded `typeof` reaching here via a computed key).
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    // A computed key is admissible on a match result and only there: an
    // element read (`m[i]`) is a capture slot, which this backend renders. A
    // computed key on a PATTERN would be a property lookup on an object whose
    // members are all statically known, so there is nothing for it to find.
    if (role !== 'pattern' && key.representation.kind === 'scalar' && key.representation.domain === 'number') {
      return captureReadText(role, receiverText, operandText(ctx, key), resultRepresentation)
    }
    if (role === 'pattern') {
      const site = 'a computed own-property read on a RegExp'
      return unboxedReadText(
        resultRepresentation ?? { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
        `gea::runtime::regex::dynamicGet(${receiverText}, ${propertyKeyText(ctx, key, site)})`,
        site
      )
    }
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver.representation)}:get:true`,
      `a ${role} property access keyed by a "${representationKey(key.representation)}" carrier has no ToPropertyKey conversion here; the well-known-symbol ` +
        'members (Symbol.match, Symbol.replace, Symbol.search, Symbol.split, Symbol.matchAll, Symbol.species) are the extension point this backend does not ' +
        'install -- the String members that dispatch through them are rendered directly instead'
    )
  }
  if (role === 'pattern') {
    if (staticKey === 'lastIndex') {
      const site = 'an own-property read of RegExp.lastIndex'
      return unboxedReadText(
        resultRepresentation ?? { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
        `gea::runtime::regex::dynamicGet(${receiverText}, ${propertyKeyText(ctx, key, site)})`,
        site
      )
    }
    if (patternDataMembers.has(staticKey)) return narrow(staticKey, `${receiverText}->${staticKey}`, null)
    if (deferredRegexpMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          `host-invocation:RegExp.prototype.${staticKey}`,
          `"${staticKey}" is a RegExp.prototype method, and this access publishes no value for its call to consume`
        )
      }
      // Recorded by the prototype-read walk, which asked the same claim.
      return ''
    }
    if (staticKey === 'compile') {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(receiver.representation)}:get:false`,
        '"compile" is RegExp’s legacy in-place reinitializer (ECMA-262 B.2.3); it is not an expando and has no native rendering'
      )
    }
    const site = 'an own-property read on a RegExp'
    return unboxedReadText(
      resultRepresentation ?? { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
      `gea::runtime::regex::dynamicGet(${receiverText}, ${propertyKeyText(ctx, key, site)})`,
      site
    )
  }
  if (resultDataMembers.has(staticKey)) {
    // `length` is a DATA member of `ExecResult` (`double length`, beside
    // `index`/`input`) and the inherited `ArrayObject::length()` of
    // `MatchResult`; one spelling for both compiled the exec result's read as
    // a call on a `double`.
    const member = staticKey === 'length' && role === 'match-result' ? 'length()' : staticKey
    return narrow(staticKey, `${receiverText}->${member}`, resultDataMemberStorage(role, staticKey))
  }
  if (canonicalCaptureSlot(staticKey)) return captureReadText(role, receiverText, staticKey, resultRepresentation)
  // An `Array.prototype` member reached through `extends Array<string>`.
  //
  // A match result IS an Array in the language -- 22.1.3.13 builds one, and
  // `RegExpMatchArray` says so in the type. The runtime carrier inherits
  // `ArrayObject<string>` and adds `index`, `input` and `groups`, so this
  // upcast preserves the object while reusing the existing Array prototype
  // implementation. Hono's pattern router is the first case that needed it:
  // `(path.match(/.../g) || []).map(...)` over every route it registers.
  if (deferredRegexpMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
    if (result === null) {
      throw createCppEmitBlockedError(
        `host-invocation:Array.prototype.${staticKey}`,
        `"${staticKey}" is an Array.prototype method, and this access publishes no value for its call to consume`
      )
    }
    // Recorded by the prototype-read walk, which asked the same claim.
    return ''
  }
  throw createCppEmitBlockedError(
    `property-access:${representationKey(receiver.representation)}:get:false`,
    `"${staticKey}" is a ${role === 'exec-result' ? 'RegExpExecArray' : 'RegExpMatchArray'} member this backend states no rendering for. Implemented: ` +
      `${[...resultDataMembers].join(', ')}, and every canonical capture index. "indices" (the ES2022 \`d\` flag) needs a [start, end] tuple per capture ` +
      'group, which this runtime does not build and std::regex does not report for a group that did not participate'
  )
}

/**
 * `regexpStoreRefusal`'s whole decision, spelled as three outcomes rather than
 * collapsed into "throws or doesn't":
 *
 * - `null`: the receiver is not a RegExp-family carrier at all.
 * - `{ kind: 'declines' }`: the receiver IS one, but this write needs no
 *   refusal -- either `lastIndex` (falls through to the ordinary
 *   struct-member write, since on this carrier it IS one) or a genuine
 *   expando (falls through to Pattern's identity-keyed native sidecar).
 * - `{ kind: 'result-mutation' | 'exec-override' | 'unsupported-member' }`: a
 *   REFUSAL, with the facts its message is built from (`role`/`staticKey`)
 *   rather than the message itself -- the receiver operand the message also
 *   needs (for `representationKey`) is already in the caller's hand, so
 *   nothing here pre-renders any of it.
 *
 * `declines` and a genuine refusal used to be one `return`/`throw` choice
 * buried in the same branch; keeping them apart is the whole point of lifting
 * this into a claim instead of a boolean.
 */
export type RegExpStoreRefusalDecision =
  | { readonly kind: 'declines' }
  | { readonly kind: 'result-mutation'; readonly role: RegExpDeclarationKind; readonly staticKey: string }
  | { readonly kind: 'exec-override' }
  | { readonly kind: 'unsupported-member'; readonly role: RegExpDeclarationKind; readonly staticKey: string | undefined }

/**
 * Lifted out of `regexpStoreRefusal` below. Unlike `namespaceMemberStoreClaim`
 * and `regexpDynamicSetClaim`, this one has exactly ONE caller
 * (`regexpStoreRefusal` itself): its only outcomes past "not a RegExp" are
 * "declines silently" and "refuses", and neither is a fact anything else
 * reads. A refusal has no C++ to schedule and no value id to key a census by,
 * so recording it in a prepass walk would mean either throwing from the walk
 * -- which would report whichever refusal this store-only walk reaches
 * first, rather than whichever operation of ANY kind actually renders first
 * in the body, a reordering this refactor's own byte-identical gate cannot
 * see -- or keeping a map nothing consults, the "capability with zero
 * consumers" shape this codebase has already paid for once. So this claim is
 * extracted for the same reason every other one is (the resolver no longer
 * decides anything inline), without manufacturing a second caller it has no
 * honest use for yet.
 */
export const regexpStoreRefusalClaim = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): RegExpStoreRefusalDecision | null => {
  const role = regexpRoleOf(receiver.representation)
  if (role === null) return null
  // A claim deciding which stored member this is (or that it's an ordinary
  // expando, below) -- must not admit a render-time-minted key text.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (role === 'pattern' && staticKey === 'lastIndex') return { kind: 'declines' }
  // A named property that is not part of RegExp's own surface is an ordinary
  // expando. It stays on Pattern's identity-keyed native sidecar, so the
  // receiver remains `Ref<Pattern>` rather than being widened to `Value`.
  if (
    role === 'pattern' &&
    (staticKey === undefined || (!patternDataMembers.has(staticKey) && !patternMethods.has(staticKey) && staticKey !== 'compile'))
  )
    return { kind: 'declines' }
  // `index`, `input`, `length` and `groups` only. A CAPTURE SLOT is not a
  // member of the result object at all -- it is an element of the Array the
  // language built (22.1.3.13) -- and `regexpCaptureSlotStoreClaim` below
  // renders a write to one, so it must not be refused as a mutation of the
  // runtime's answer alongside the four members that genuinely are.
  if (role !== 'pattern' && staticKey !== undefined && resultDataMembers.has(staticKey)) {
    return { kind: 'result-mutation', role, staticKey }
  }
  if (staticKey === 'exec') return { kind: 'exec-override' }
  return { kind: 'unsupported-member', role, staticKey }
}

/**
 * A store into a regular-expression member.
 *
 * `lastIndex` is the one writable own data property ECMA-262 defines
 * (22.2.6.9). It stays in the Pattern-owned `Value` cell through both direct
 * and computed stores; the runtime applies ToLength only when matching.
 *
 * The `exec` override is the one case worth naming outright. `r.exec = fn` is
 * legal TypeScript and legal ECMAScript, and 22.2.7.1 `RegExpExec` really does
 * look the own property up and call it -- v1 carries a `gea_cpp_value
 * exec_override` field for exactly this. Supporting it here would mean giving
 * every pattern a boxed callable slot and routing every `exec`/`match`/
 * `replace` through a dynamic check for it, which is the boxing this backend
 * does not do. So it is refused, by name, with what it would cost.
 *
 * Decides nothing itself any more -- `regexpStoreRefusalClaim` above is the
 * one authority; this only spells whichever of its outcomes came back.
 */
export const regexpStoreRefusal = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): void => {
  const decision = regexpStoreRefusalClaim(ctx, receiver, key)
  if (decision === null || decision.kind === 'declines') return
  if (decision.kind === 'result-mutation') {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver.representation)}:set:false`,
      `writing "${decision.staticKey}" on a ${decision.role === 'exec-result' ? 'RegExpExecArray' : 'RegExpMatchArray'} would mutate a result object ` +
        'this backend hands back by shared pointer from the runtime; the match result is an answer, and no store into one is rendered'
    )
  }
  if (decision.kind === 'exec-override') {
    throw createCppEmitBlockedError(
      'host-invocation:RegExp.prototype.exec',
      'installing an own "exec" on a RegExp (ECMA-262 22.2.7.1 RegExpExec, step 3) makes every exec/match/replace/split dispatch through a ' +
        'user-supplied callable found at run time. v1 geatsc carries that as a boxed `gea_cpp_value exec_override` field on every pattern; this ' +
        'backend has no boxed callable slot on a native carrier and does not add one, so the override is refused rather than silently ignored -- ' +
        'silently ignoring it would run the built-in matcher for a program that replaced it'
    )
  }
  throw createCppEmitBlockedError(
    `property-access:${representationKey(receiver.representation)}:set:${decision.staticKey === undefined}`,
    `writing "${decision.staticKey ?? 'a computed key'}" on a RegExp has no rendering here; "lastIndex" is the one writable member ECMA-262 22.2.6.9 ` +
      'defines, and the other nine are read-only accessors on the prototype'
  )
}

/**
 * A capture-slot STORE -- `m[0] = s`, `m[j] = s` -- with the slot's own text,
 * or `null` when the operation is not one.
 *
 * A match result IS an Array in the language, and its capture slots are that
 * Array's elements rather than members of the result object, so writing one is
 * an ordinary element store and not a mutation of an answer the runtime owns.
 * The read side has always agreed: `captureReadText` renders `m[i]` off both a
 * static canonical index and a computed numeric key. This is the same access
 * in the other direction, admitted on the same two key shapes, so the pair
 * cannot disagree about which keys name a slot.
 *
 * hono's `Trie.insert` is the program that named it: `tokens[j] =
 * tokens[j].replace(mark, groups[i][1])` over `path.match(re) || []`, whose
 * union collapses to the match result alone (`normalize/structural.ts` drops
 * the empty-array arm).
 */
export const regexpCaptureSlotStoreClaim = (
  ctx: EmitContext,
  operation: SetOperation | DefineOwnPropertyOperation
): { readonly slotText: string } | null => {
  if (operation.kind !== 'set') return null
  const role = regexpRoleOf(operation.receiver.representation)
  if (role === null || role === 'pattern') return null
  // A claim deciding whether this key names a slot -- must not admit a
  // render-time-minted key text, for the reason every other claim here states.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  if (staticKey !== undefined) return canonicalCaptureSlot(staticKey) ? { slotText: staticKey } : null
  if (operation.key.representation.kind !== 'scalar' || operation.key.representation.domain !== 'number') return null
  return { slotText: operandText(ctx, operation.key) }
}

/**
 * `emitRegExpSet`'s whole decision: is this a `set` whose receiver is a
 * Pattern and whose key is NOT one of the ten `RegExp.prototype` members (a
 * computed key, or a named expando) -- the dynamic write into Pattern's
 * identity-keyed native sidecar. `null` for anything else, including a
 * `define-own-property` (this dynamic path only ever reached a `set` even
 * before the extraction) and a write to a method name, which stays refused
 * by `regexpStoreRefusalClaim` instead of silently accepted here.
 *
 * Carries the resolved static key text (or `undefined` for a computed key)
 * rather than the `site` diagnostic string built from it -- a fact, not
 * pre-rendered text, exactly like every other claim in this file.
 */
export interface RegExpDynamicSetClaim {
  readonly staticKey: string | undefined
}

export const regexpDynamicSetClaim = (
  ctx: EmitContext,
  operation: SetOperation | DefineOwnPropertyOperation
): RegExpDynamicSetClaim | null => {
  if (operation.kind !== 'set' || regexpRoleOf(operation.receiver.representation) !== 'pattern') return null
  // A claim deciding whether this write targets a method name (and so is
  // refused elsewhere) -- must not admit a render-time-minted key text.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  // Method replacement still needs RegExpExec dispatch support; preserve the
  // existing explicit refusal instead of accepting an ignored override.
  if (staticKey !== undefined && (patternMethods.has(staticKey) || staticKey === 'compile')) return null
  return { staticKey }
}

/**
 * RegExp [[Set]] for every key whose writability must be decided at run time.
 * The receiver remains Ref<Pattern>; only the property value crosses the
 * dynamic boundary required by a computed key.
 *
 * Decides nothing itself any more -- `regexpDynamicSetClaim` above is the one
 * authority; this only spells the write once the claim admits it.
 */
export const emitRegExpSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const claim = regexpDynamicSetClaim(ctx, operation)
  // `claim` is non-`null` only when `operation.kind === 'set'` -- the claim
  // already proved it -- but that fact does not cross the function boundary
  // for the type checker, which is all this second half of the check is for:
  // narrowing `operation` to `SetOperation` so `.strict` below type-checks.
  if (claim === null || operation.kind !== 'set') return false
  const { staticKey } = claim

  const site = staticKey === undefined ? 'a computed "set" on a RegExp' : `a "set" of RegExp.${staticKey}`
  const receiverText = operandText(ctx, operation.receiver)
  const write =
    `gea::runtime::regex::dynamicSet(${receiverText}, ${propertyKeyText(ctx, operation.key, site)}, ` +
    `${boxedValueText(ctx, operation.value, site)})`
  if (operation.strict) {
    lines.push(`if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read-only RegExp property");`)
  } else lines.push(`${write};`)

  if (!operation.result || operation.result.representation.kind === 'void') return true
  const threaded = alignedValueText(
    ctx,
    'prototype/emit-prototype-regexp.ts:350',
    operation.receiver.representation,
    operation.result.representation,
    receiverText
  )
  if (threaded === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.receiver.representation)}->${representationKey(operation.result.representation)}`,
      `${site} publishes a "${representationKey(operation.result.representation)}" carrier, and the native RegExp receiver cannot be represented as it`
    )
  }
  lines.push(`${defineValue(ctx, operation.result)} = ${threaded};`)
  return true
}

/**
 * The call text for a deferred `RegExp.prototype` method read.
 *
 * `test` is a member call on the `shared_ptr` because it is a member of the
 * ported `Pattern` (v1: `Pattern::test`). `exec` is a free function because it
 * builds an `ExecResult`, which is a second type -- and because the boxed
 * `gea_cpp_value exec(...)` overload sitting beside it in v1 is deliberately
 * not ported; this is the typed one (v1: `Pattern::exec_typed`).
 */
export const regexpMethodCallText = (
  ctx: EmitContext,
  member: string,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null
): string => {
  if (member === 'toString') {
    if (args.length !== 0) {
      throw createCppEmitBlockedError(
        'host-invocation:RegExp.prototype.toString',
        `"RegExp.prototype.toString" takes no arguments; this call passes ${args.length}`
      )
    }
    return `${receiverText}->toString()`
  }
  const input = args[0]
  if (args.length !== 1 || !input) {
    throw createCppEmitBlockedError(
      `host-invocation:RegExp.prototype.${member}`,
      `"RegExp.prototype.${member}" is spelled for its one string argument (ECMA-262 22.2.6.${member === 'test' ? '16' : '8'}); this call passes ${args.length}`
    )
  }
  if (input.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      `host-invocation:RegExp.prototype.${member}`,
      `"RegExp.prototype.${member}" argument 0 carries "${representationKey(input.representation)}"; the specification ToStrings it, and ToString of an ` +
        'arbitrary value is what this backend has no box for'
    )
  }
  const inputText = operandText(ctx, input)
  if (member === 'test') return `${receiverText}->test(${inputText})`
  // The result carrier is checked rather than assumed: 22.2.6.8 answers `null`
  // on no match, so an `exec` whose result was not given an optional carrier
  // would either not compile or silently unwrap an absent match into a
  // zero-initialized result object.
  const carrier = result?.representation
  const payload = carrier === undefined ? null : carrier.kind === 'optional' ? carrier.payload : carrier
  if (payload !== null && regexpRoleOf(payload) !== 'exec-result') {
    throw createCppEmitBlockedError(
      'host-invocation:RegExp.prototype.exec',
      `"RegExp.prototype.exec" answers a RegExpExecArray or \`null\` (ECMA-262 22.2.6.8), so this backend renders it as an optional ` +
        `${cppRegExpNativeTypes['exec-result']}; this call's result carries "${representationKey(carrier ?? payload)}"`
    )
  }
  return `gea::runtime::regex::exec(*${receiverText}, ${inputText})`
}

/**
 * The five `String.prototype` members whose argument may be a regular
 * expression, rendered here rather than in `emit-prototype-string.ts` because
 * what they need is this file's carrier knowledge, not that file's arity
 * table.
 *
 * Each answers `null` when the call's first argument is NOT a pattern, and the
 * string-shaped rendering there carries on unchanged -- `s.split(',')` is
 * untouched by any of this. `match` and `search` have no string-argument form
 * to fall back to (ECMA-262 22.1.3.11 / 22.1.3.13 both `RegExpCreate` a
 * non-RegExp argument first), so they refuse by name when handed one.
 *
 * `matchAll` is not here. See `regexpStringMemberRefusals`.
 */
const patternArgumentText = (ctx: EmitContext, argument: IrOperand | undefined): string | null => {
  if (!argument || regexpRoleOf(argument.representation) !== 'pattern') return null
  // The runtime takes the pattern by `const Pattern&` and the carrier is a
  // `shared_ptr`, so the dereference is the whole of the impedance -- no copy,
  // and `lastIndex` mutation stays visible to every other holder.
  return `*${operandText(ctx, argument)}`
}

const requirePatternArgument = (ctx: EmitContext, member: string, clause: string, args: readonly IrOperand[]): string => {
  const pattern = patternArgumentText(ctx, args[0])
  if (pattern === null) {
    throw createCppEmitBlockedError(
      `host-invocation:String.prototype.${member}`,
      `"String.prototype.${member}" argument 0 carries "${args[0] ? representationKey(args[0].representation) : 'nothing'}"; ECMA-262 ${clause} ` +
        'RegExpCreates a non-RegExp argument, and constructing a pattern out of an arbitrary value at a call site is a coercion this backend does not render'
    )
  }
  if (args.length !== 1) {
    throw createCppEmitBlockedError(
      `host-invocation:String.prototype.${member}`,
      `"String.prototype.${member}" is spelled for its one argument (ECMA-262 ${clause}); this call passes ${args.length}`
    )
  }
  return pattern
}

/** ECMA-262 22.1.3.11 `String.prototype.match(regexp)` -> 22.2.6.8, answering `RegExpMatchArray | null`. */
export const regexpMatchText = (ctx: EmitContext, receiverText: string, args: readonly IrOperand[], result: IrResult | null): string => {
  const pattern = requirePatternArgument(ctx, 'match', '22.1.3.11', args)
  const carrier = result?.representation
  const payload = carrier === undefined ? null : carrier.kind === 'optional' ? carrier.payload : carrier
  if (payload !== null && regexpRoleOf(payload) !== 'match-result') {
    throw createCppEmitBlockedError(
      'host-invocation:String.prototype.match',
      `"String.prototype.match" answers a RegExpMatchArray or \`null\` (ECMA-262 22.1.3.11 step 3), so this backend renders it as an optional ` +
        `${cppRegExpNativeTypes['match-result']}; this call's result carries "${representationKey(carrier ?? payload)}"`
    )
  }
  return `gea::runtime::string::matchByPattern(${receiverText}, ${pattern})`
}

/** ECMA-262 22.1.3.13 `String.prototype.search(regexp)` -> 22.2.6.11, answering the index of the first match or -1. */
export const regexpSearchText = (ctx: EmitContext, receiverText: string, args: readonly IrOperand[]): string =>
  `gea::runtime::string::search(${receiverText}, ${requirePatternArgument(ctx, 'search', '22.1.3.13', args)})`

/**
 * ECMA-262 22.1.3.23 `String.prototype.split(separator)` -> 22.2.6.14, when
 * the separator is a pattern -- `null` when it is not, so the string form
 * renders unchanged.
 *
 * The spec APPENDS every capture group to the output (step 19.d), so
 * `'a1b'.split(/(\d)/)` is three elements, not two. That is in the runtime's
 * `splitByPattern`, which is why the element carrier is checked here: an
 * array of anything but strings would mean the plan and the runtime disagree
 * about what a split produces.
 */
export const regexpSplitText = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null
): string | null => {
  const pattern = patternArgumentText(ctx, args[0])
  if (pattern === null) return null
  if (args.length !== 1) {
    throw createCppEmitBlockedError(
      'host-invocation:String.prototype.split',
      `"String.prototype.split" with a RegExp separator is spelled for that one argument (ECMA-262 22.1.3.23); this call passes ${args.length} ` +
        '-- the optional `limit` parameter (step 5) is not rendered'
    )
  }
  const carrier = result?.representation
  if (carrier !== undefined && (carrier.kind !== 'array-object' || carrier.element.kind !== 'string')) {
    throw createCppEmitBlockedError(
      'host-invocation:String.prototype.split',
      `"String.prototype.split" answers an array of strings; this call's result carries "${representationKey(carrier)}"`
    )
  }
  return `gea::runtime::string::splitByPattern(${receiverText}, ${pattern})`
}

/**
 * ECMA-262 22.1.3.18 `replace` / 22.1.3.20 `replaceAll` with a pattern
 * searchValue -- `null` when the searchValue is a string, so the two-string
 * form renders unchanged.
 *
 * The replacement may be a CALLBACK (22.2.6.11 step 14.a), or any value that
 * `toStringText` can provably convert before 22.1.3.19 `GetSubstitution`
 * interprets `$&`, `` $` ``, `$'`, `$n`, `$<name>` and `$$`. The two resulting
 * carriers are real overloads of the ported `replaceByPattern`, selected by
 * C++ overload resolution; a carrier whose ToString can run unknown user code
 * remains refused.
 *
 * `replaceAll` renders a DIFFERENT runtime entry point, and that is 22.1.3.20
 * step 2: a non-global RegExp is a TypeError there, and which pattern object
 * reaches this call site is not a fact any emitter can read, so the check
 * lives in `replaceAllByPattern`.
 */
export const regexpReplaceText = (
  member: 'replace' | 'replaceAll',
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[]
): string | null => {
  const pattern = patternArgumentText(ctx, args[0])
  if (pattern === null) return null
  const replacement = args[1]
  if (args.length !== 2 || !replacement) {
    throw createCppEmitBlockedError(
      `host-invocation:String.prototype.${member}`,
      `"String.prototype.${member}" is spelled for its search value and replacement (ECMA-262 ${member === 'replace' ? '22.1.3.18' : '22.1.3.20'}); ` +
        `this call passes ${args.length}`
    )
  }
  const carrier = replacement.representation
  const substitution =
    carrier.kind === 'function-value-dispatch'
      ? operandText(ctx, replacement)
      : toStringText(operandText(ctx, replacement), carrier, ctx.classes, ctx.deriver)
  if (substitution === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(carrier)}->string`,
      `"String.prototype.${member}"'s replacement carries "${representationKey(carrier)}"; ECMA-262 ${member === 'replace' ? '22.1.3.18' : '22.1.3.20'} ` +
        'takes either a callable (invoked per match) or a value it ToStrings into a substitution template, and ToString of an arbitrary value is what ' +
        'this backend has no box for'
    )
  }
  const spelling = member === 'replace' ? 'replaceByPattern' : 'replaceAllByPattern'
  return `gea::runtime::string::${spelling}(${receiverText}, ${pattern}, ${substitution})`
}

/**
 * The one String member with a regular-expression argument that this backend
 * refuses, and the true reason.
 *
 * Read by `emit-prototype-string.ts`'s refusal table so there is one authority
 * for it.
 */
export function matchAllRefusal(): string {
  return (
    'ECMA-262 22.1.3.12 matchAll(regexp) answers a RegExpStringIterator -- a first-class iterator OBJECT, which is a value this backend does not mint ' +
    '(emit-iterator.ts lowers only the fused for-of cursor, never a standalone iterator). The pattern itself is fully native here: `for (const m of ' +
    's.matchAll(re))` needs the cursor lowering, not a regular-expression carrier. Until then, the same walk is `while ((m = re.exec(s)) !== null)` on a ' +
    'global pattern, which this backend renders'
  )
}

/**
 * `new String(x)` -- the ECMAScript String WRAPPER OBJECT (ECMA-262 22.1.5),
 * kept in this file alongside the three regular-expression carriers above
 * rather than a file of its own: all four are native-record-ref types this
 * backend intercepts EARLY, at the identical two dispatch points in
 * `emit-properties.ts` (right after `regexpMember`/`regexpStoreRefusal`),
 * for the identical architectural reason -- nothing here may fall through to
 * the generic struct-member path. Deliberately separate from
 * `emit-prototype-string.ts`, which is `String.prototype` over this
 * backend's PRIMITIVE `string` carrier, not this rarer OBJECT
 * `new String(x)` allocates -- one with identity that can carry own
 * properties no primitive can (`escapedString.isEscaped = true`, hono's
 * `utils/html.ts`, the case this carrier exists for).
 *
 * `gea::runtime::StringObject`'s ambient body (`interface String` in
 * `lib.es5.d.ts`) survives `declaredBodyOf`'s method stripping with a real
 * data member (`length`) AND a number index signature -- the same
 * "plausible-looking struct that is not the real layout" shape
 * `RegExpExecArray` warns about in `derive.ts`'s own comment. The generic
 * struct-member path would happily emit `receiver->length`, and
 * `gea::runtime::StringObject` has no such field (see its doc comment in
 * `runtime/gea_runtime.h`: `length` is ECMA-262 22.1.4's own READ-ONLY view
 * over `[[StringData]]`, not a second, driftable copy of it).
 *
 * The bigger landmine is the NUMBER index signature: `String`'s derived
 * shape lays out as `record-with-index` with a NUMBER-domain sidecar
 * (`[index: number]: string`), and `emitRecordIndexSidecarStore`/
 * `recordIndexSidecarReadText` (`emit-carrier-members.ts`) run for ANY
 * `native-record-ref` whose shape has one, over ANY constant key that does
 * not name a declared field, with no domain check ahead of the subscript
 * conversion. A STRING key like `isEscaped` reaching that path is coerced
 * with `Number('isEscaped')` (`NaN`) and throws a "does not spell a numeric
 * key" refusal unrelated to what the program wrote. So the two functions
 * below must fully own EVERY constant key on a String-object receiver, not
 * just `length`, so nothing falls through into a sidecar keyed by the wrong
 * domain -- unlike `regexpMemberText`/`regexpStoreRefusal` above, which only
 * intercept a refusal and let everything else fall through.
 *
 * A constant, non-`length` key (`isEscaped`, `callbacks`) is routed through
 * the identical `gea::nativeDynamicGet`/`nativeDynamicSet` machinery
 * `nativeSidecarGetText`/`emitNativeSidecarSet` (`emit-dynamic-properties.ts`)
 * already use for a COMPUTED key on any other native-record-ref type --
 * reusing their `boxedValueText`/`unboxedReadText` rather than duplicating
 * the box/unbox logic. Those two functions skip a constant key outright
 * (their own doc comment: "a constant key names a declared member"), true
 * for every native-record-ref type before this one and false for `String`,
 * whose whole point is accepting arbitrary, program-chosen constant keys as
 * dynamic properties.
 */

/** Whether a carrier is the String wrapper-object native type, or `null`/anything else. */
export const isStringObjectCarrier = (representation: Representation): boolean =>
  representation.kind === 'native-record-ref' && representation.native === cppStringObjectNativeType

/**
 * A `[[Get]]` off a String object, or `null` when the receiver is not one --
 * in which case `emitGet` carries on unchanged.
 *
 * `length` is a real field computed off `StringObject::value`, not stored
 * separately (see the struct's own doc comment). A computed numeric key is
 * indexed character access (ECMA-262 22.1.5.1's exotic `[[GetOwnProperty]]`),
 * a real spec'd capability this backend has not built a renderer for, and is
 * refused by name -- the same posture taken above for `RegExp.prototype
 * .compile`. Every other CONSTANT key is a dynamic own property, routed
 * through the native dynamic-property sidecar directly (see this section's
 * header comment for why it cannot defer to `nativeSidecarGetText`, which
 * only fires for a computed key).
 */
export const stringObjectMemberText = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand,
  resultRepresentation: Representation | undefined
): string | null => {
  if (!isStringObjectCarrier(receiver.representation)) return null
  const receiverText = operandText(ctx, receiver)
  // A claim deciding whether this is the `length` accessor versus a dynamic
  // own property (below) -- must not admit a render-time-minted key text.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver.representation)}:get:true`,
      `a String-object property access keyed by a "${representationKey(key.representation)}" carrier has no ToPropertyKey conversion here; a computed ` +
        'numeric key would be indexed character access (ECMA-262 22.1.5.1), which this backend does not render for the wrapper object -- ' +
        "`String.prototype` methods over the primitive `string` carrier are `emit-prototype-string.ts`'s"
    )
  }
  if (staticKey === 'length') return `static_cast<double>(${receiverText}->value.size())`
  const site = 'a "get" on a String-object own property'
  const read = `gea::nativeDynamicGet(${receiverText}, ${propertyKeyText(ctx, key, site)})`
  return unboxedReadText(resultRepresentation ?? { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, read, site)
}

/**
 * A store into a String object -- `null`/no-op when the receiver is not one,
 * in which case `emitFieldStoreLines` carries on unchanged. Unlike
 * `regexpStoreRefusal` above, this function OWNS every constant key for a
 * String-object receiver and returns `true` for all of them.
 *
 * `length` is refused: ECMA-262 22.1.4.1 makes it a read-only accessor, never
 * a data property a program can write. A computed key is refused for the
 * identical reason the GET side refuses one: indexed character mutation has
 * no renderer here. Every other constant key is an own-property write,
 * routed through `gea::nativeDynamicSet` directly.
 */
export const emitStringObjectSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  if (!isStringObjectCarrier(operation.receiver.representation)) return false
  const receiverText = operandText(ctx, operation.receiver)
  // A claim deciding whether this write targets `length` (refused, below)
  // versus a dynamic own property -- must not admit a render-time-minted key.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  if (staticKey === undefined) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(operation.receiver.representation)}:set:true`,
      `a String-object property write keyed by a "${representationKey(operation.key.representation)}" carrier has no ToPropertyKey conversion here; ` +
        'indexed character mutation (ECMA-262 22.1.5.1) is not rendered for the wrapper object'
    )
  }
  if (staticKey === 'length') {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(operation.receiver.representation)}:set:false`,
      '"length" on a String object is a read-only accessor (ECMA-262 22.1.4.1); ECMAScript itself refuses this write with no observable effect ' +
        'in sloppy mode and throws in strict mode, and this backend does not render either outcome for it'
    )
  }
  const site = 'a "set" on a String-object own property'
  lines.push(
    `gea::nativeDynamicSet(${receiverText}, ${propertyKeyText(ctx, operation.key, site)}, ${boxedValueText(ctx, operation.value, site)});`
  )
  if (operation.result) {
    // The store's own result is the receiver threaded onward, exactly as
    // `emitNativeSidecarSet` (`emit-dynamic-properties.ts`) reconciles for the
    // identical computed-key case -- a store publishes the object it wrote
    // into, not a success boolean.
    const produced = operation.result.representation
    const threaded = alignedValueText(
      ctx,
      'prototype/emit-prototype-regexp.ts:707',
      operation.receiver.representation,
      produced,
      receiverText
    )
    if (threaded === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(operation.receiver.representation)}->${representationKey(produced)}`,
        `${site} publishes a "${produced.kind}" carrier as the assignment's own value, and this backend cannot spell a String-object receiver as one`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${threaded};`)
  }
  return true
}

/**
 * The runtime text that stringifies a String-object carrier down to this
 * backend's plain `std::string`, or `null` for anything else.
 *
 * The one real datum on `gea::runtime::StringObject` -- see its doc comment
 * in `runtime/gea_runtime.h` -- so this is a field read, not a call:
 * ECMA-262 22.1.3.34/22.1.5.4 (`toString`/`valueOf`, `thisStringValue`) both
 * answer exactly `[[StringData]]` with no transformation.
 *
 * `emit-narrowing.ts` keeps a small, deliberately duplicated twin
 * (`stringObjectStringifyText`) for the one native wrapper-to-primitive route;
 * it cannot import this helper because this file already imports
 * `convertedValueText` from there. This is not a dynamic boundary coercion.
 */
export const stringObjectToStringText = (heldRepresentation: Representation, text: string): string | null =>
  isStringObjectCarrier(heldRepresentation) ? `${text}->value` : null
