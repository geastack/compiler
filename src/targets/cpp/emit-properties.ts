import type { Ownership, RecordAccessor, Representation } from '../../representation/model.js'
import { dictionaryKeyDomainOf, ownershipOf, representationKey } from '../../representation/model.js'
import { carrierDifference, shortCarrierText } from '../../representation/difference.js'
import { nativeFieldOwnerReadText } from './emit-field-owner.js'
import type { DefineOwnPropertyOperation, GetOperation, IrOperand, SetOperation } from '../../ir/model.js'
import type { FunctionId } from '../../identity/ids.js'
import {
  cppDenseFlagName,
  cppDensePointerName,
  createCppEmitBlockedError,
  defineValue,
  defineValueAlias,
  operandText,
  prototypeMethodReceiverText,
  unwrapPresentValue,
  type EmitContext,
  type ReactiveRevisionOrigin,
  isIntegerStorageValue,
  storedEnvironmentText
} from './emit-context.js'
import { declaredHostMethodRead, emitNativeHostStore, nativeHostMemberText } from './host/emit-host-properties.js'
import { hostResultText } from './host/emit-host-arity.js'
import {
  classMemberOf,
  dispatchesStatically,
  fieldDeclaringStructOf,
  lazyArrowFieldGetPlanOf,
  lazyMaterializedFieldText,
  structNameOfReceiver,
  type LazyArrowFieldPlan
} from './class-layout.js'
import {
  cppArrayExtensionStructName,
  cppBodyName,
  cppRecordAccessorEnvironmentName,
  cppRecordFieldAttributesName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppTypeOf,
  cppScalarType,
  cppStringLiteral,
  cppUndefinedIn
} from './types.js'
import { isNativeError } from './error-types.js'
import { cppVirtualMemberName, virtualDispatchKey } from './virtual-methods.js'
import { recordAccessorsOfShape, declaredFieldRepresentationOf, declaredRecordFieldOf, nativeBaseFieldOf } from './records.js'
import { nativeErrorMemberText } from './prototype/emit-prototype-error.js'
import { structuralRecordViewText } from './emit-record-view.js'
import {
  classMemberText,
  classConstructorStaticFieldStorage,
  classConstructorStaticMemberText
} from './class-properties/emit-class-properties.js'
import { alignedValueText, classFamilyLoadText, movedValueText, narrowedLoadText } from './emit-narrowing.js'
import { namespaceMemberStore } from './emit-namespaces.js'
import {
  callableSidecarGetText,
  isNativeCallableCarrier,
  dynamicGetText,
  emitDynamicSet,
  emitNativeSidecarSet,
  nativeSidecarGetText
} from './emit-dynamic-properties.js'
import { dynamicObjectPrototypeMemberRead, objectShapePrototypeMemberRead } from './host/object-protocol.js'
import {
  emitRegExpSet,
  emitStringObjectSet,
  regexpCaptureSlotStoreClaim,
  regexpMemberText,
  regexpStoreRefusal,
  stringObjectMemberText
} from './prototype/emit-prototype-regexp.js'
import { emitTaggedUnionSet, taggedUnionGetText } from './emit-union-properties.js'
import { stringAppendStatement } from './emit-tostring.js'

/**
 * The property spine: every `[[Get]]`, `[[Set]]`, and `[[DefineOwnProperty]]`
 * this backend renders, over every receiver carrier it can render one for.
 *
 * One file, because the choice of spelling is one decision: a record field, a
 * class field, a class method, and an Array element are four answers to the
 * same question, and separating them is how two of them end up disagreeing
 * about what a key means.
 */

/**
 * The ownership a field store/load may dispatch on. Anything else has no
 * member-access spelling this file knows how to pick.
 *
 * `record-with-index` reaches this only for its NAMED half -- a constant key
 * that spells one of the carrier's own `fields`, exactly the same struct
 * member a plain `record` has. Every branch that owns the carrier's OTHER
 * half (a key that names no field, constant or computed) claims the operation
 * first and returns before this generic fallback is ever asked --
 * `recordWithIndexFieldText`/`recordIndexSidecarReadText` on the read side,
 * `emitRecordIndexSidecarStore` on the store side -- so a `record-with-index`
 * that DOES reach here is always its struct half, the one thing this function
 * already knows how to spell.
 */
const recordOwnershipOf = (operand: IrOperand, contextDescription: string): Ownership => {
  const representation = operand.representation
  if (
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'native-record-ref' ||
    representation.kind === 'class-ref'
  ) {
    return representation.ownership
  }
  throw createCppEmitBlockedError(
    `property-access:${representation.kind}:field`,
    `${contextDescription} has a receiver carrier of kind "${representation.kind}"; ` +
      'this emitter only spells member access for "record", "record-with-index", "native-record-ref", and "class-ref"'
  )
}

/** The static field name a `get`/`set`/`define-own-property` key resolves to. A key with no recorded constant text is a dynamic key. */
export const staticKeyTextOf = (ctx: EmitContext, key: IrOperand, contextDescription: string): string => {
  const text = ctx.staticKeyTexts.get(key.value)
  if (text !== undefined) return text
  throw createCppEmitBlockedError(
    `runtime-helper:computation:to-property-key:${contextDescription}`,
    `${contextDescription} has a key that was not produced by a "constant" operation in this body; this emitter has no dynamic-key path`
  )
}

import { dateMemberText } from './prototype/emit-prototype-date.js'
import {
  arrayAccessText,
  presentElementText,
  keyedCollectionMemberText,
  iteratorMemberText,
  canonicalIndexLiteral,
  dictionaryPrototypeMemberRead,
  memberAccessOperator,
  promiseMemberText,
  keyedTableKeyText,
  emitRecordIndexSidecarStore,
  recordIndexSidecarReadText,
  reactiveRevisionText,
  scalarMemberText,
  stringMemberText,
  symbolMemberText,
  typedArrayAccessText
} from './emit-carrier-members.js'
import { arrayBufferAccessText, dataViewAccessText, sharedArrayBufferAccessText } from './emit-buffers.js'
import { functionSourceReadClaimOf } from './function-source-reads.js'
import { deferredCallableBuiltinReadClaimOf, recordWithIndexFieldClaimOf } from './property-read-claims.js'

/**
 * The host-member reading of a property access, or `null` when the receiver is
 * not a `native-handle`.
 *
 * A host singleton -- `Math`, `Date`, `String` -- carries no data of its own:
 * every one of its interned handles names the same host object, and the value
 * a `[[Get]]` produces depends only on the protocol and the key, never on
 * which handle instance asked. So, unlike every other branch here, the
 * materialized receiver operand is not read at all -- the qualified host
 * symbol `gea::host::<protocol>::<key>` names the member directly, the same
 * way `classMemberText` names a method without reading the instance. That
 * symbol is read out of `hostMembers`, never built from the protocol and the
 * key: the table states the spelling for every member that has one, so a
 * member no table claims is refused by name below rather than handed an
 * interpolated symbol no runtime header declares.
 *
 * A non-constant key is refused: a host object has no runtime member table
 * for this backend to dispatch a dynamic key against, only the fixed set of
 * qualified symbols `gea_runtime.h` declares.
 */
/**
 * The dictionary table behind a receiver, in both spellings a use of it needs.
 *
 * A `dictionary` carrier is a `std::map`-backed container: `member` reaches
 * its methods (`read`, `has`) through whichever accessor its ownership calls
 * for, and `subscript` is the `operator[]` form a store writes through. Both
 * are built here rather than at each use so the two cannot disagree about
 * which object is being indexed.
 *
 * A `record-with-index` deliberately answers `null`. Its index signature does
 * live in a dictionary sidecar beside the named fields, but a key that spells
 * a declared field must reach the *struct member* and not the table, and
 * deciding that needs the field list this function does not have. Answering
 * here would route `style.width` into the sidecar and silently read nothing,
 * so it stays refused by name in the caller until that decision is written.
 */
export const dictionaryTableOf = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand
): { readonly member: string; readonly subscript: string; readonly key: string } | null => {
  const representation = receiver.representation
  if (representation.kind !== 'dictionary') return null
  const receiverText = operandText(ctx, receiver)
  const indexed = representation.ownership === 'shared-refcount' ? `(*${receiverText})` : receiverText
  const keyText = keyedTableKeyText(ctx, key, dictionaryKeyDomainOf(representation.key, key.representation))
  return {
    member: `${receiverText}${memberAccessOperator(representation.ownership)}`,
    subscript: `${indexed}[${keyText}]`,
    key: keyText
  }
}

/**
 * Reading a dynamic-keyed property out of a dictionary.
 *
 * The language answers `undefined` for a key the table does not hold. Where
 * the program was compiled to say so -- `noUncheckedIndexedAccess`, which
 * types the read `V | undefined` and carries it as `optional<V>` -- this
 * renders that exactly, testing `has` and constructing the present and absent
 * cases separately. Where it was not, the checker itself asserted the value is
 * a `V` and the plan carries a bare `V`; `read` answers that, and a missing
 * key yields a value-initialized one. Rendering the optional form there would
 * not be more truthful -- it would not compile, because the carrier the rest
 * of the program agreed on has no way to hold an absence.
 */
const dictionaryReadText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const table = dictionaryTableOf(ctx, operation.receiver, operation.key)
  if (table === null) return null
  if (operation.receiver.representation.kind !== 'dictionary') return null
  const source = operation.receiver.representation.value
  const read = operation.result.representation
  const raw = `${table.member}read(${table.key})`
  if (representationKey(source) === representationKey(read)) return raw
  if (read.kind === 'optional' && representationKey(source) === representationKey(read.payload)) {
    const carrier = cppTypeOf(read)
    return `(${table.member}has(${table.key}) ? ${carrier}(${raw}) : ${carrier}())`
  }
  const converted = alignedValueText(ctx, 'emit-properties.ts:213', source, read, raw)
  if (converted !== null) return converted
  throw createCppEmitBlockedError(
    `conversion:${representationKey(source)}->${representationKey(read)}`,
    `reads a dictionary value carried as "${representationKey(source)}" into "${representationKey(read)}", and no conversion is installed`
  )
}

/**
 * The named-field half of a `record-with-index` receiver's own split layout
 * (`representation/model.ts`'s own comment states the split; `records.ts`'s
 * `renderStructDefinition` is where it becomes two struct members side by
 * side). Only a constant key that spells one of the carrier's own `fields`
 * resolves here -- exactly the same struct member the generic `record`/
 * `native-record-ref` fallback below would spell for an ordinary record, so
 * this reuses `memberAccessOperator` and `cppRecordFieldName` rather than a
 * second opinion on either.
 *
 * A constant key that names no field is not answered here: it would have to
 * route into the sidecar `gea_dynamic` member instead
 * (`emit-carrier-members.ts`'s `recordIndexSidecarReadText` renders that, for
 * the computed case `preflight/property-access.ts` actually admits; see
 * `manifest.ts`'s own comment for why a *constant* key naming no field stays
 * unclaimed rather than also routing there). `null` therefore covers two
 * different receivers with one answer -- "not a `record-with-index`" and "a
 * `record-with-index` this function does not resolve" -- which is safe only
 * because `preflight/property-access.ts`'s `recordWithIndexKeyNamesAField`
 * already refuses to certify the second case, so an uncertified program is
 * the only way emission reaches here for one, and the fallback below still
 * refuses it by name.
 */
/**
 * `args.length` off a rest parameter.
 *
 * A rest parameter whose declared type is a tuple is carried as a POSITIONAL
 * RECORD -- `model.ts`'s `isArrayPatternCapable` names the same shape, and
 * there is deliberately no separate tuple carrier -- so its arity lives in the
 * presence bits rather than in a `length` member. Without this the read fell
 * through every native branch to the dynamic sidecar, which has no such key:
 * the program certified and then aborted at runtime in `refusePayloadMismatch`.
 * three's WebGL forwarding shims are the shape that needs it -- `texImage2D(
 * ...args )` selects its 6-argument form with `args.length === 6`.
 *
 * Synthesizing `length` for a positional record cannot capture a plain object
 * that merely has numeric keys: `({ 0: "a" }).length` is a type error, so the
 * checker refuses that read long before emission, and this branch is only ever
 * reached for a receiver whose static type declares a `length` -- a tuple.
 *
 * The count is the leading run of present slots, which is what arity means: a
 * required prefix is present by construction, and each optional slot beyond it
 * counts only when it is filled.
 */
const positionalRecordLengthText = (ctx: EmitContext, operation: GetOperation): string | null => {
  if (ctx.staticKeyTexts.get(operation.key.value) !== 'length') return null
  const representation = operation.receiver.representation
  if (representation.kind !== 'record') return null
  const fields = representation.fields
  if (fields.length === 0 || !fields.every((field, index) => field.key === String(index))) return null
  // A tuple's optional elements are its trailing ones; a record whose required
  // flags are not a prefix is not one, and its arity is not a count.
  const required = fields.findIndex((field) => !field.required)
  if (required === -1) return `${fields.length}`
  if (fields.slice(required).some((field) => field.required)) return null
  const receiverText = operandText(ctx, operation.receiver)
  const accessor = memberAccessOperator(representation.ownership)
  let text = `${required}`
  for (let index = required; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined) return null
    text = `(${receiverText}${accessor}${cppRecordFieldPresenceName(field.key)} ? ${index + 1} : ${text})`
  }
  return text
}

const recordWithIndexFieldText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): string | null => {
  const claim = recordWithIndexFieldClaimOf(ctx.staticKeyTexts, receiver, key)
  if (claim === null) return null
  // The claim already proved `receiver.representation.kind === 'record-with-index'`;
  // this cast spells that same fact rather than re-deriving it from the kind tag.
  const representation = receiver.representation as Extract<Representation, { kind: 'record-with-index' }>
  const accessor = memberAccessOperator(representation.ownership)
  return `${operandText(ctx, receiver)}${accessor}${cppRecordFieldName(claim.fieldKey)}`
}

/**
 * The accessor list behind a record-shaped receiver, read from wherever that
 * receiver's carrier actually keeps it.
 *
 * A plain `record` carries its `accessors` inline (`derive.ts`'s
 * `deriveObject`), because the whole shape was expanded right there. A
 * `native-record-ref` carries none -- it is a *reference* by shape id,
 * deliberately not expanded (`derive.ts`'s `declared`/`object-anchor` cases:
 * expanding a name whose body can refer back to itself has no finite
 * carrier). So a `native-record-ref` receiver's accessors are read back
 * through `ctx.deriver` (`records.ts`'s `recordAccessorsOfShape`) -- the
 * identical authority `declaredFieldRepresentation`, above, already reads
 * that same reference's *fields* through -- never a second, re-derived
 * opinion about what the shape's members are.
 */
const recordAccessorsFor = (ctx: EmitContext, representation: Representation): readonly RecordAccessor[] | null => {
  if (representation.kind === 'record') return representation.accessors
  if (representation.kind === 'native-record-ref') return recordAccessorsOfShape(ctx.deriver, representation.shapeId)
  return null
}

/**
 * The emitted body behind an accessor-backed *record* member, or `null` when
 * the key is an ordinary field (or the receiver carries no record accessors
 * at all).
 *
 * An object literal's `get width() { ... }` has no storage: the shape says so,
 * and `records.ts` lays out no member for it. So the read is a call, spelled
 * against the same free function every other body is emitted as, with the
 * object passed as the receiver it was compiled to take.
 */
/**
 * Whether a member read renders as a pure load -- an element, a `length`, a
 * field, a method reference -- rather than as a call into the program.
 *
 * `ir/dead-values.ts` asks this before dropping a read nothing consumes, and
 * `ir/deferral.ts` before moving one to its use. A read through a record
 * accessor (`get width() { ... }`) runs a body; a read off a host handle may
 * reach the host; a read through an `optional` receiver renders a presence
 * check first. All three keep their statement. `key` is the IR's own text for
 * a string-literal key, passed in rather than looked up: this is asked from the
 * IR passes, before an `EmitContext` for the body exists at all, so neither
 * `constantTexts` nor the settled `staticKeyTexts` is reachable from here.
 */
export const isPlainMemberRead = (ctx: EmitContext, operation: GetOperation, key: string | null): boolean => {
  const representation = operation.receiver.representation
  if (representation.kind === 'array-object' || representation.kind === 'string') return true
  if (representation.kind !== 'class-ref' && representation.kind !== 'record' && representation.kind !== 'native-record-ref') return false
  if (key === null) return false
  if (representation.kind === 'class-ref') {
    // The same inherited member lookup that renders the read decides whether
    // it calls a getter. Dropping an unused extracted value must not drop that
    // getter's observable effects.
    const member = classMemberOf(ctx.classes, representation.declaration, key)
    return member !== null && member.kind !== 'accessor'
  }
  const accessors = recordAccessorsFor(ctx, representation)
  return accessors === null || !accessors.some((entry) => entry.key === key)
}

/**
 * The environment actual a capturing accessor's body is called with, or no
 * actual at all when the body captures nothing.
 *
 * `emit-iterator.ts` asks the identical question of the identical member for a
 * `next`/`return` read it renders as one expression, so this is exported: one
 * answer for "what does this accessor's body need beyond its receiver",
 * reached from every site that calls one.
 */
export const accessorEnvironmentArguments = (
  ctx: EmitContext,
  receiver: Representation,
  key: string,
  body: FunctionId | null,
  half: 'getter' | 'setter',
  receiverText: string
): readonly string[] => {
  if (body === null || ctx.captures.of(body).kind !== 'ok') return []
  const member = `${receiverText}${ownershipOf(receiver) === 'owned' ? '.' : '->'}${cppRecordAccessorEnvironmentName(key, half)}`
  return [storedEnvironmentText(body, member)]
}

const recordAccessorBody = (ctx: EmitContext, receiver: IrOperand, key: string, half: 'getter' | 'setter'): FunctionId | null => {
  const accessors = recordAccessorsFor(ctx, receiver.representation)
  if (!accessors) return null
  const accessor = accessors.find((entry) => entry.key === key)
  if (!accessor) return null
  const body = half === 'getter' ? accessor.getter : accessor.setter
  if (!body) {
    throw createCppEmitBlockedError(
      `property-access:record:${half === 'getter' ? 'get' : 'set'}:false`,
      `accessor "${key}" declares no ${half}, so ${half === 'getter' ? 'reading' : 'writing'} it has no body to call`
    )
  }
  return body
}

/**
 * A member reached through a host NAMESPACE.
 *
 * Asked first, because the receiver of one of these is not a value: nothing
 * was materialized for `deviceInfo`, so every branch below it -- each of
 * which reads the receiver operand -- would ask for a name that was never
 * minted. What exists is a path, and this is where a path either grows a
 * segment or resolves to a spelling.
 *
 * The three answers, from the host's own tables:
 *
 * - a METHOD renders nothing here and hands the call site the spelling, the
 *   same deferral `hostMemberReads` uses -- `deviceInfo.deviceId` names no C++
 *   on its own and only `gea::host::device_info::deviceId(...)` does;
 * - a PROPERTY is already an expression -- `gea::host::Display.width` -- so it
 *   renders as the value;
 * - a longer PATH -- `navigator.bluetooth` -- renders nothing and extends the
 *   path, because the host states members under it and not for it.
 *
 * A member none of the three claims is refused by name. That is the whole
 * point of reading the host's tables rather than interpolating `path + '.' +
 * member`: an interpolated symbol compiles as plausible text and fails at
 * `ld`, which is exactly the failure this replaced.
 */
const namespaceMemberText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const path = ctx.hostNamespaceReads.get(operation.receiver.value) ?? ctx.hostNamespaceValues.get(operation.receiver.value)
  if (path === undefined) return null
  // Which of the three answers this `get` is -- a method, a longer path, or a
  // property -- was decided before this body rendered a line, by the SAME
  // fixed point that settled `path` above: a longer path is exactly the value
  // the next `get` in the chain has to find there, so the walk cannot resolve
  // one without resolving the other. Asking it, rather than re-resolving
  // `path.member` against the host tables a second time, is what keeps the one
  // fact to one authority.
  if (ctx.hostFunctionReads.has(operation.result.id)) return ''
  if (ctx.hostNamespaceReads.has(operation.result.id)) return ''
  const member = staticKeyTextOf(ctx, operation.key, `a member of the host namespace "${path}"`)
  const key = `${path}.${member}`
  const property = ctx.hosts.namespaces.properties.get(key)
  if (property !== undefined) return property
  throw createCppEmitBlockedError(
    `host-invocation:${key}`,
    `"${key}" is not a member this host states a spelling for; the namespace is reachable and this member of it is not`
  )
}

/**
 * One dense window's element, and the flag that says the pointer may be used.
 *
 * `null` unless `emitBody` admitted a window for this very access
 * (`ir/dense-loops.ts`). The general form stays in the emitted text either way:
 * the flag is loop-invariant, so the backend versions the loop on it rather
 * than testing it per element, and the slow half is what runs for an array that
 * holds a hole or an index the loop's own bound did not cover.
 */
const denseCellText = (
  ctx: EmitContext,
  operation: GetOperation | SetOperation | DefineOwnPropertyOperation
): { flag: string; text: string; pointer: string; index: string } | null => {
  const access = ctx.denseAccesses.get(operation)
  if (access === undefined) return null
  // The flag is stated as LIKELY at every site rather than left to the
  // backend's own guess. It is loop-invariant and true for every array a
  // program actually builds, but clang schedules the two halves as if either
  // could run: measured on `bench/comparison/fixtures/object_create.ts`,
  // 9.05ms without the hint and 8.49ms with it, for the same instructions in a
  // better order.
  return {
    pointer: cppDensePointerName(access.array),
    index: `static_cast<std::size_t>(${ctx.denseIndices.get(operation.key.value) ?? operandText(ctx, operation.key)})`,
    flag: `GEA_LIKELY(${cppDenseFlagName(access.flag)})`,
    text: `${cppDensePointerName(access.array)}[static_cast<std::size_t>(${ctx.denseIndices.get(operation.key.value) ?? operandText(ctx, operation.key)})]${operation.receiver.representation.kind === 'typed-array' ? '' : '.value'}`
  }
}

/** The same, as a read: `flag ? base[i].value : <the general form>`. */
const denseElementText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const dense = denseCellText(ctx, operation)
  if (dense === null) return null
  const general =
    operation.receiver.representation.kind === 'typed-array'
      ? typedArrayAccessText(ctx, operation.receiver, operation.key, operation.result)
      : arrayAccessText(ctx, operation.receiver, operation.key, operation.result)
  if (general === null || general === '') return null
  // The window's flag is a proof of presence, so the fast half is written in
  // the result's carrier the same way the general half's guarded arm is --
  // see `presentElementText`. Without it the two arms are a bare element and
  // an `Optional<T>`, and only the converting constructor makes that a type.
  const element: Representation | null =
    operation.receiver.representation.kind === 'array-object'
      ? operation.receiver.representation.element
      : operation.receiver.representation.kind === 'typed-array'
        ? { kind: 'scalar', domain: 'number' }
        : null
  const value =
    operation.receiver.representation.kind === 'typed-array'
      ? `static_cast<double>(gea::TypedArray<${cppScalarType(operation.receiver.representation.element)}>::readInBounds(${dense.pointer}, ${dense.index}))`
      : dense.text
  const fast = element === null ? null : presentElementText(ctx, element, operation.result, value)
  return `(${dense.flag} ? ${fast ?? dense.text} : ${general})`
}

export const emitGet = (ctx: EmitContext, lines: string[], operation: GetOperation): void => {
  const ownerRead = nativeFieldOwnerReadText(ctx, operation)
  if (ownerRead !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${ownerRead};`)
    return
  }
  // `ctx.propertyReadOrigins` already names this operation for this result --
  // settled in `EmitBodyFacts` before any branch below runs.
  // ECMA-262 6.2.5.5 GetV step 2: a read through `undefined` or `null` calls
  // ToObject on the base, which throws a TypeError for both. Rendered before
  // every other branch because none of them can apply -- a nullish receiver
  // has no namespace, no accessor, no class member and no struct.
  //
  // The site that needed it is UNREACHABLE rather than a program that really
  // reads through `undefined`: a generic narrowed by `instanceof` to a class
  // its own monomorphized copy cannot be gives the narrowed binding an
  // uninhabited intersection, and `derive.ts` answers that with `never`'s
  // storage-free carrier (mongodb's `execute_operation.ts:198`, 28 copies).
  // Refusing to lower it reported an emission blocker for code that cannot
  // run; throwing is what the language says and costs the branch nothing.
  const receiverKind = operation.receiver.representation.kind
  if (receiverKind === 'undefined' || receiverKind === 'null' || receiverKind === 'void') {
    const nullishName = defineValue(ctx, operation.result)
    lines.push(
      `${nullishName} = gea::host::throwGetPropertyOfNullish<${cppTypeOf(operation.result.representation)}>("${receiverKind === 'null' ? 'null' : 'undefined'}");`
    )
    return
  }
  const namespaceMember = namespaceMemberText(ctx, operation)
  if (namespaceMember !== null) {
    // An empty rendering is a deferred method read or a longer path; both are
    // rendered whole by whatever consumes them.
    if (namespaceMember === '') return
    lines.push(`${defineValue(ctx, operation.result)} = ${namespaceMember};`)
    return
  }
  const present = unwrapPresentValue(ctx, lines, operation.receiver)
  if (present !== operation.receiver) {
    emitGet(ctx, lines, { ...operation, receiver: present })
    return
  }
  if (declaredHostMethodRead(ctx, operation)) return
  const accessorKey = ctx.staticKeyTexts.get(operation.key.value)
  const getter = accessorKey === undefined ? null : recordAccessorBody(ctx, operation.receiver, accessorKey, 'getter')
  if (getter !== null) {
    const receiverText = operandText(ctx, operation.receiver)
    const environment = accessorEnvironmentArguments(
      ctx,
      operation.receiver.representation,
      accessorKey ?? '',
      getter,
      'getter',
      receiverText
    )
    lines.push(`${defineValue(ctx, operation.result)} = ${cppBodyName(getter)}(${[...environment, receiverText].join(', ')});`)
    return
  }
  const classMember = classMemberText(ctx, operation)
  if (classMember !== null) {
    // A read that publishes no text at all is a dispatch with nothing to
    // materialise -- an abstract method's declaration. The call site renders
    // `receiver->member(args)` from `ctx.virtualCallees`, exactly as a
    // deferred `Array.prototype` read leaves its own access empty.
    if (classMember.text === '') return
    const methodName = defineValue(ctx, operation.result, classMember.spelling ?? undefined)
    lines.push(`${methodName} = ${classMember.text};`)
    return
  }
  const staticMember = classConstructorStaticMemberText(ctx, operation)
  if (staticMember !== null) {
    const methodName = defineValue(ctx, operation.result)
    lines.push(`${methodName} = ${staticMember};`)
    return
  }
  const unionMember = taggedUnionGetText(ctx, lines, operation)
  if (unionMember !== null) {
    if (unionMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${unionMember};`)
    return
  }
  const arrayAccess = denseElementText(ctx, operation) ?? arrayAccessText(ctx, operation.receiver, operation.key, operation.result)
  if (arrayAccess !== null) {
    // An empty rendering is a deferred Array.prototype method read: the
    // access itself produces no C++, and the call site renders the whole
    // fused expression -- the same convention `nativeHandleMember` uses below.
    if (arrayAccess === '') return
    const arrayName = defineValue(ctx, operation.result)
    lines.push(`${arrayName} = ${arrayAccess};`)
    return
  }
  const typedArrayAccess = typedArrayAccessText(ctx, operation.receiver, operation.key, operation.result)
  if (typedArrayAccess !== null) {
    // An empty rendering is a deferred %TypedArray%.prototype method read --
    // see the identical comment on the array-access branch above.
    if (typedArrayAccess === '') return
    const typedArrayName = defineValue(ctx, operation.result)
    lines.push(`${typedArrayName} = ${typedArrayAccess};`)
    return
  }
  // The two other members of the ECMA-262 binary family, rendered by
  // `emit-buffers.ts` alongside the typed array's own block-shaped members.
  const arrayBufferAccess = arrayBufferAccessText(ctx, operation.receiver, operation.key, operation.result.id)
  if (arrayBufferAccess !== null) {
    if (arrayBufferAccess === '') return
    const bufferName = defineValue(ctx, operation.result)
    lines.push(`${bufferName} = ${arrayBufferAccess};`)
    return
  }
  const sharedArrayBufferAccess = sharedArrayBufferAccessText(ctx, operation.receiver, operation.key)
  if (sharedArrayBufferAccess !== null) {
    const bufferName = defineValue(ctx, operation.result)
    lines.push(`${bufferName} = ${sharedArrayBufferAccess};`)
    return
  }
  const dataViewAccess = dataViewAccessText(ctx, operation.receiver, operation.key, operation.result.id)
  if (dataViewAccess !== null) {
    if (dataViewAccess === '') return
    const viewName = defineValue(ctx, operation.result)
    lines.push(`${viewName} = ${dataViewAccess};`)
    return
  }
  const stringMember = stringMemberText(ctx, operation.receiver, operation.key, operation.result)
  if (stringMember !== null) {
    const shared = ctx.sharedStringLayouts.get(operation.result.id)
    const sharedMetadata = shared === undefined ? null : `gea_shared_string_layout_${shared.ordinal}`
    if (shared?.initialize && sharedMetadata !== null) {
      ctx.declarations.push({ type: 'gea::runtime::string::Utf16Metadata', name: sharedMetadata })
      lines.push(`${sharedMetadata} = gea::runtime::string::utf16Metadata(${operandText(ctx, operation.receiver)});`)
    }
    // An empty rendering is a deferred String.prototype method read -- see
    // the identical comment on the array-access branch above.
    if (stringMember === '') {
      const read = ctx.prototypeMethodReads.get(operation.result.id)
      if (read?.member === 'charCodeAt' && ctx.hoistedResults.has(operation.result.id)) {
        // The IR proves this receiver invariant. Keep its metadata in the
        // same preheader, so each character avoids pointer-cache validation.
        const metadata = `gea_string_metadata_${ctx.stringMetadataNames.size}`
        ctx.declarations.push(
          { type: 'gea::runtime::string::Utf16Metadata', name: metadata },
          { type: 'std::size_t', name: `${metadata}_units` },
          { type: 'bool', name: `${metadata}_basic_latin` }
        )
        // Layout is immutable, while the decoder cursor is updated by reads.
        // Separate scalar locals keep cursor aliasing from hiding that invariant
        // from native loop unswitching and range analysis.
        // Each method site needs its own cursor. Sharing one between i and
        // i+offset reads would turn two forward scans into repeated rewinds.
        lines.push(
          `${metadata} = ${sharedMetadata ?? `gea::runtime::string::utf16Metadata(${prototypeMethodReceiverText(ctx, read.receiver)})`};`
        )
        lines.push(`${metadata}_units = ${metadata}.units;`)
        lines.push(`${metadata}_basic_latin = ${metadata}.basicLatin;`)
        ctx.stringMetadataNames.set(operation.result.id, metadata)
      }
      return
    }
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${sharedMetadata === null ? stringMember : `static_cast<double>(${sharedMetadata}.units)`};`)
    return
  }
  const symbolMember = symbolMemberText(ctx, operation.receiver, operation.key, operation.result)
  if (symbolMember !== null) {
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${symbolMember};`)
    return
  }
  const scalarMember = scalarMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (scalarMember !== null) {
    // An empty rendering is a deferred Number.prototype method read -- see
    // the identical comment on the array-access branch above.
    if (scalarMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${scalarMember};`)
    return
  }
  // Asked ahead of every remaining branch that could claim a `native-record-ref`
  // receiver -- the index-sidecar read below would otherwise take `m[0]` (a
  // match result's layout really does carry a number index signature) and the
  // struct-member fallthrough at the end would take `re.test` and emit
  // `re->test`, which is a clang error naming a member instead of a refusal
  // naming the method.
  const regexpMember =
    regexpMemberText(
      ctx,
      operation.receiver,
      operation.key,
      operation.result.id,
      operation.result.representation,
      (fieldName, storage, declared) => narrowedFieldReadText(ctx, operation, fieldName, storage, null, declared)
    ) ?? stringObjectMemberText(ctx, operation.receiver, operation.key, operation.result.representation)
  if (regexpMember !== null) {
    // An empty rendering is a deferred RegExp.prototype method read -- see
    // the identical comment on the array-access branch above.
    if (regexpMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${regexpMember};`)
    return
  }
  const promiseMember = promiseMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (promiseMember !== null) {
    // An empty rendering is a deferred Promise.prototype method read -- see
    // the identical comment on the array-access branch above.
    if (promiseMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${promiseMember};`)
    return
  }
  const iteratorMember = iteratorMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (iteratorMember !== null) {
    // An empty rendering is a deferred %GeneratorPrototype% method read --
    // see the identical comment on the array-access branch above.
    if (iteratorMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${iteratorMember};`)
    return
  }
  const collectionMember = keyedCollectionMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (collectionMember !== null) {
    // An empty rendering is a deferred Map/Set prototype method read -- see
    // the identical comment on the array-access branch above.
    if (collectionMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${collectionMember};`)
    return
  }
  // A Date's members are all `Date.prototype` methods, so every claimed one
  // defers and fuses with its call exactly as `substring` does off a string.
  // Asked before the `native-record-ref` field fallback at the bottom of this
  // function, which would otherwise spell `d->gea_field_getFullYear` for a
  // struct that declares no such member.
  const dateMember = dateMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (dateMember !== null) {
    // An empty rendering is a deferred Date.prototype method read -- see the
    // identical comment on the array-access branch above.
    if (dateMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${dateMember};`)
    return
  }
  // An intrinsic Error's `toString`, asked before the `native-record-ref`
  // field fallback below -- which would spell `e->gea_field_toString` for a
  // layout that declares no such member -- and before the dynamic sidecar,
  // whose Array.prototype guard used to claim the key and refuse under the
  // wrong prototype's name.
  const errorMember = nativeErrorMemberText(ctx, operation.receiver, operation.key, operation.result.id)
  if (errorMember !== null) {
    // An empty rendering is a deferred Error.prototype method read -- see the
    // identical comment on the array-access branch above.
    if (errorMember === '') return
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${errorMember};`)
    return
  }
  const nativeHostMember = nativeHostMemberText(ctx, operation.receiver, operation.key, operation.result)
  if (nativeHostMember !== null) {
    // An empty rendering is a deferred host method: the access itself produces
    // no C++, and the call site renders the host's own spelling.
    if (nativeHostMember === '') return
    if (ctx.numericCallOnly.has(operation.result.id)) {
      defineValueAlias(ctx, operation.result, nativeHostMember)
      return
    }
    const name = defineValue(ctx, operation.result)
    // The host's own carrier for the value it hands back is not always the
    // program's -- see `hostResultText`; a member declared `number[]` is a
    // `std::vector<double>` on the far side of the bridge.
    lines.push(`${name} = ${hostResultText(operation.result.representation, nativeHostMember)};`)
    return
  }
  // Before the table read, which would claim the key -- see that function.
  if (dictionaryPrototypeMemberRead(ctx, operation)) return
  // `hasOwnProperty`/`propertyIsEnumerable` off a record/class-ref/generated
  // `native-record-ref`, asked before the struct-field and sidecar fallbacks
  // below would otherwise route them into `nativeSidecarGetText`'s boxed
  // "unknown key" answer -- see `object-protocol.ts`'s own comment.
  if (objectShapePrototypeMemberRead(ctx, operation)) return
  const dictionaryRead = dictionaryReadText(ctx, operation)
  if (dictionaryRead !== null) {
    const dictionaryName = defineValue(ctx, operation.result)
    lines.push(`${dictionaryName} = ${dictionaryRead};`)
    return
  }
  const positionalRecordLength = positionalRecordLengthText(ctx, operation)
  if (positionalRecordLength !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${positionalRecordLength};`)
    return
  }
  const recordWithIndexField = recordWithIndexFieldText(ctx, operation.receiver, operation.key)
  if (recordWithIndexField !== null) {
    const name = defineValue(ctx, operation.result)
    const fieldName = staticKeyTextOf(ctx, operation.key, 'a "get" operation')
    lines.push(`${name} = ${fixedFieldReadText(ctx, operation, fieldName)};`)
    return
  }
  const recordIndexSidecarRead = recordIndexSidecarReadText(ctx, operation)
  if (recordIndexSidecarRead !== null) {
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${recordIndexSidecarRead};`)
    return
  }
  // `hasOwnProperty` off a receiver the program itself declared dynamic --
  // asked before the generic dynamic property read below, which would
  // otherwise read "hasOwnProperty" THROUGH the receiver's real
  // `[[Prototype]]` chain and find nothing there. See `object-protocol.ts`'s
  // own comment for why that chain can never answer it.
  if (dynamicObjectPrototypeMemberRead(ctx, operation)) return
  // A receiver the program itself declared `any`/`unknown` carries its
  // properties in the `gea::DynamicObject` its box owns. Asked after every
  // native branch above, because a native receiver never reaches here at all
  // and this arm must not shadow one.
  const dynamicRead = dynamicGetText(ctx, operation)
  if (dynamicRead !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${dynamicRead};`)
    return
  }
  // `add.call(x, 3, 4)` reads `Function.prototype.call` off a callable
  // value, and this read renders nothing: `ir/lower-invocation.ts`'s
  // `deferredFunctionCallCalleeOf` rewrites the CALL that follows to invoke
  // the underlying receiver directly, with this result never referenced.
  // `ir/lower.ts` still lowers every semantic operation once regardless of
  // whether anything downstream reads its result, so this GET reaches emission
  // anyway -- there is no C++ object anywhere that implements
  // `Function.prototype.call` itself for a generic struct/handle fallback
  // below to spell a member access against. Gated on the exact same receiver
  // kind and key preflight certified. A callable constructor takes this same
  // path for its [[Call]] half; neither path materializes a fake `.call` or
  // `.apply` member object.
  // Asked of the one authority rather than spelled a fifth time. This copy had
  // drifted: it omitted `function-value-family`, so a cell holding one of a
  // closed set of named functions missed the `.call`/`.apply`/`.bind` deferral
  // and fell through to the sidecar read, which renders a `callableDynamicGet`
  // for a value `projection/callee.ts` and the manifest both state renders
  // nothing.
  const callable = isNativeCallableCarrier(operation.receiver.representation.kind)
  if (callable && functionSourceReadClaimOf(ctx.staticKeyTexts, operation) === 'direct') {
    // The builtin's receiver is fixed before its arguments run, so the snapshot
    // has to be taken HERE: an argument may replace the binding or field this
    // function was read from. That position is the only thing this site still
    // owns -- the claim, the snapshot's name and the text the following call
    // reads are all settled by `function-source-reads.ts`.
    const name = ctx.functionSourceSnapshotNames.get(operation.result.id)
    if (name === undefined) {
      throw createCppEmitBlockedError('call-abi:function-source', 'a settled function-source read reached its render with no snapshot name')
    }
    ctx.declarations.push({ name, type: cppTypeOf(operation.receiver.representation) })
    lines.push(`${name} = ${operandText(ctx, operation.receiver)};`)
    return
  }
  // The identical deferral covers `.apply` (`Math.max.apply(null, [1, 5, 3])`,
  // `deferredFunctionApplyCalleeOf`) and the direct `.bind` form (lowered to
  // `bind-callable`): none of the three has a standalone native object to
  // materialize, so a `get` left unread after lowering has nothing left to
  // print. `deferredCallableBuiltinReadClaimOf` (`property-read-claims.ts`) is
  // the one function for "which of the three builtins is this, if any" --
  // this rung spells nothing but the fact that the claim matched.
  if (deferredCallableBuiltinReadClaimOf(ctx.staticKeyTexts, ctx.unreadValues, operation) !== null) {
    return
  }
  const callableRead = callableSidecarGetText(ctx, operation)
  if (callableRead !== null) {
    // An empty rendering is a deferred Object.prototype method read
    // (`callable-shape`): the call site renders it.
    if (callableRead !== '') lines.push(`${defineValue(ctx, operation.result)} = ${callableRead};`)
    return
  }
  // A statically typed receiver reached through a key only known at runtime.
  // The receiver stays native -- this is the sidecar, not a widening -- and it
  // is asked after every branch that resolves a callable's own fixed key, so a
  // Function property never falls into an unrelated native-record path.
  const sidecarRead = nativeSidecarGetText(ctx, operation)
  if (sidecarRead !== null) {
    lines.push(`${defineValue(ctx, operation.result, sidecarRead.spelling ?? undefined)} = ${sidecarRead.text};`)
    return
  }
  const fieldName = staticKeyTextOf(ctx, operation.key, 'a "get" operation')
  const name = defineValue(ctx, operation.result)
  // A qualifying arrow-function class field starts every instance empty
  // (`class-layout.ts`'s `censusLazyArrowFields`) rather than built in the
  // constructor. This `get` is the one read every consumer of such a field
  // goes through -- a call's callee is read exactly like any other value, see
  // `class-layout.ts`'s own comment -- so it is the one place that
  // materializes it.
  // An inherited field's plan is published under the DECLARING class, not
  // every receiver a subclass instance may be typed as -- see
  // `lazyArrowFieldGetPlanOf`'s own comment, and `fieldDeclaringStructOf`'s,
  // for why that lookup walks to the owner rather than the receiver's own
  // declaration.
  const lazyField = lazyArrowFieldGetPlanOf(ctx, operation)
  if (lazyField !== null) {
    // A result `emit-callable.ts`'s `emitLazyArrowFieldCall` has already
    // proved is read by nothing but its own call fusion (`class-layout.ts`'s
    // `lazyCalleeReadsOf`) needs no `CallableObject` built at all: the fusion
    // reads this copy's own `invoke` guard itself, at the point the ORIGINAL
    // source read the field -- before any argument of that call can reassign
    // it -- and either calls the census arrow's body directly or the copy's
    // own `.call()`. Materializing here would build exactly the per-call heap
    // environment this whole feature exists to avoid, for a value the fusion
    // never even looks at as a completed `CallableObject`.
    const rendering = ctx.lazyCalleeReads.has(operation.result.id)
      ? lazyFieldSnapshotReadText(ctx, operation, fieldName)
      : lazyMaterializedFieldReadText(ctx, operation, fieldName, lazyField.plan)
    lines.push(`${name} = ${rendering};`)
    return
  }
  // The property key names the field; `cppRecordFieldName` (types.ts) names
  // the C++ member, and only that function may -- `renderStructDefinition`
  // declared the member through it, so spelling the access from the raw key
  // here would be a second opinion that agrees only for keys that happen to be
  // identifiers already.
  lines.push(`${name} = ${fixedFieldReadText(ctx, operation, fieldName)};`)
}

/**
 * A qualifying arrow-function field's read: materialize it (call the SAME
 * initializer thunk `cppFieldInitializerStatements` would have called eagerly)
 * the first time anything reads it, then read the now-populated storage.
 *
 * The receiver is bound once, not repeated: `fixedFieldReadText`'s own comment
 * documents why an SSA operand may render as a deferred conversion expression
 * that must not be evaluated twice, and this reads it three times over (the
 * guard, the store, and the return) if it did not bind a local first.
 *
 * Reassignment needs no separate branch here: `set`/`define-own-property`
 * write the field directly, unchanged by this feature, and a reassigned
 * field's `invoke` is no longer `nullptr` -- so a later read of THIS function
 * sees the guard already false and returns whatever was stored, exactly as
 * `c.json === c.json` and a property written onto the callable both require.
 */
const lazyMaterializedFieldReadText = (ctx: EmitContext, operation: GetOperation, fieldName: string, plan: LazyArrowFieldPlan): string => {
  const accessor = memberAccessOperator(recordOwnershipOf(operation.receiver, 'a "get" operation'))
  const receiver = operandText(ctx, operation.receiver)
  return lazyMaterializedFieldText(receiver, accessor, fieldName, plan)
}

/**
 * A RAW copy of a lazy arrow field's storage -- no materialization, no guard,
 * just the `CallableObject` as it stands. Sound only where `ctx.lazyCalleeReads`
 * has already proved the copy's one reader is `emit-callable.ts`'s
 * `emitLazyArrowFieldCall`, which reads the copy's own `invoke` pointer to
 * decide how to call it: an unmaterialized copy (`invoke == nullptr`) is the
 * census arrow itself, a trivial struct copy with no allocation, and a
 * materialized one is whatever the field was reassigned to.
 */
const lazyFieldSnapshotReadText = (ctx: EmitContext, operation: GetOperation, fieldName: string): string => {
  const accessor = memberAccessOperator(recordOwnershipOf(operation.receiver, 'a "get" operation'))
  const receiver = operandText(ctx, operation.receiver)
  return `${receiver}${accessor}${cppRecordFieldName(fieldName)}`
}

/** A presence check and its payload load must evaluate the receiver only once. */
const fixedFieldReadText = (ctx: EmitContext, operation: GetOperation, fieldName: string): string => {
  const accessor = memberAccessOperator(recordOwnershipOf(operation.receiver, 'a "get" operation'))
  const receiver = operandText(ctx, operation.receiver)
  const field = cppRecordFieldName(fieldName)
  const presence = fixedFieldPresenceText(ctx, operation.receiver, fieldName)
  if (presence !== null && cppUndefinedIn(operation.result.representation) !== null) {
    // An SSA operand may render as a deferred conversion expression. Repeating
    // it in both branches duplicates that conversion (including checked native
    // unboxing), despite the IR containing only one receiver evaluation.
    const read = narrowedFieldReadText(
      ctx,
      operation,
      fieldName,
      `gea_read_receiver${accessor}${field}`,
      `gea_read_receiver${accessor}${cppRecordFieldPresenceName(fieldName)}`
    )
    return `([&]() { const auto& gea_read_receiver = ${receiver}; return ${read}; })()`
  }
  return narrowedFieldReadText(ctx, operation, fieldName, `${receiver}${accessor}${field}`, presence)
}

/** The independent own-property bit for every fixed field on generated storage. */
const fixedFieldPresenceText = (ctx: EmitContext, receiver: IrOperand, fieldName: string): string | null => {
  const representation = receiver.representation
  if (representation.kind === 'native-record-ref' && representation.native !== null) return null
  const field = declaredRecordFieldOf(ctx.deriver, representation, fieldName, ctx.classes)
  if (!field) return null
  if (
    representation.kind !== 'record' &&
    representation.kind !== 'record-with-index' &&
    representation.kind !== 'native-record-ref' &&
    representation.kind !== 'class-ref'
  )
    return null
  return `${operandText(ctx, receiver)}${memberAccessOperator(representation.ownership)}${cppRecordFieldPresenceName(fieldName)}`
}

/**
 * A field read whose published carrier is NARROWER than the field's storage.
 *
 * `interface Cell { v: number | null }` stores `Optional<double>`, and after
 * `if (c.v !== null)` -- or after `c.v ??= 4` -- the checker types the very
 * same access `number`. Both answers are true and they are about different
 * things: one is what the struct member holds, the other is what this read
 * yields on this branch. A reinterpretation between them does not exist, so
 * emitting the bare member load produced `double = gea::Optional<double>` --
 * a certified program clang rejects. It is the two-carrier narrowed read,
 * on a record FIELD rather than on a cell.
 *
 * The conversion itself is not spelled here: `narrowedLoadText`
 * (emit-narrowing.ts) is the one authority on what a read of a wider carrier
 * at a narrower one looks like -- a dereference for an optional the branch
 * proved present, an arm load for a tagged union, and the combination for
 * both. It is the same function a narrowed CELL read goes through, which is
 * the point: a field and a cell disagreeing about what narrowing means is how
 * the original defect got in. A disagreement it declines to convert is a
 * defect upstream, not a spelling this may invent, so that refuses by name.
 */
const narrowedFieldReadText = (
  ctx: EmitContext,
  operation: GetOperation,
  fieldName: string,
  storage: string,
  presence: string | null = null,
  /**
   * The member's physical carrier, supplied by a caller that HAS it where the
   * lookup below cannot. A compiler-owned native layout
   * (`ExecResult`/`MatchResult`) never gets a sealed record layout, so
   * `declaredFieldRepresentation` answers null for its members and this
   * function would hand back the bare load -- correct until the read is
   * narrowed, and a type error the moment it is. The caller that knows the
   * struct says so instead of this function guessing.
   */
  declaredStorage: Representation | null = null
): string => {
  const declared = declaredStorage ?? declaredFieldRepresentation(ctx, operation.receiver, fieldName)
  if (declared === null) return storage
  const published = operation.result.representation
  const present = (() => {
    if (representationKey(declared) === representationKey(published)) return storage
    const classFamily = classFamilyLoadText(ctx, declared, published, storage)
    if (classFamily !== null) return classFamily
    const narrowed = narrowedLoadText(declared, published, storage)
    if (narrowed !== null) return narrowed
    return alignedValueText(ctx, 'emit-properties.ts:864', declared, published, storage)
  })()
  if (present !== null) {
    const absent = presence === null ? null : cppUndefinedIn(published)
    return absent === null ? present : `(${presence} ? ${present} : ${absent})`
  }
  // Asked second, and only once narrowing has declined: a read whose published
  // carrier is not NARROWER than the storage but merely a different spelling of
  // it is a CONVERSION, and `convertedValueText` is this backend's one authority
  // on those. A binding write already asks both -- `emit-bindings.ts` calls
  // exactly this function for the store direction -- and a field read asking
  // only one of the two is how a field holding `(c: Context) => Response` came
  // to refuse against a read publishing `(c: Context) => Response |
  // Promise<Response>`: an implicit converting constructor `gea::CallableObject`
  // declares, licensed for a cell and refused for a struct member, over the
  // identical pair of carriers.
  //
  // Still fail-closed: `convertedValueText` answers `null` for a pair it has no
  // recipe for, and that is the refusal below rather than a bare member load.
  throw createCppEmitBlockedError(
    `conversion:${representationKey(declared)}->${representationKey(published)}`,
    `field "${fieldName}" is stored as "${representationKey(declared)}" and this read publishes ` +
      `"${representationKey(published)}"; no narrowing between those is licensed; ` +
      carrierDifference(declared, published)
  )
}

/**
 * Whether a `define-own-property`'s own descriptor is the one every branch
 * below already assumes -- a fresh, ordinary, writable/enumerable/
 * configurable data property, ECMA-262 10.1.9.2 step 1.d.iii's default. A
 * plain `set` carries no descriptor at all and always passes.
 *
 * `set` and `define-own-property` share every field-storing branch below,
 * which is only sound because none of the C++ this file writes into --  a
 * struct member, a dictionary entry, a dynamic object's own table -- can
 * express anything BUT the default triple: a struct member has no
 * enumerability flag, a `gea::Dictionary` entry has no writability flag.
 * Collapsing a NON-default descriptor into the same store anyway would
 * silently drop the very thing the program asked for -- installing a
 * `configurable: false` field is not "install the field," it is a different,
 * unrenderable operation -- so a defined property whose attributes are not
 * this exact triple refuses by name here, once, rather than every branch
 * below independently forgetting to ask.
 */
const isDefaultDataDescriptor = (operation: SetOperation | DefineOwnPropertyOperation): boolean =>
  operation.kind !== 'define-own-property' ||
  (operation.attributes.writable && operation.attributes.enumerable && operation.attributes.configurable)

/**
 * The emitted setter for an accessor-backed class member, or `null` when the
 * key is an ordinary field (or the receiver is not a class instance at all).
 *
 * A member that the layout says is an accessor and whose setter is absent is
 * refused rather than written as a field: `get`-only means the language itself
 * has nowhere to put the value, and a struct member with that name does not
 * exist to write into either.
 */
const classAccessorSetter = (ctx: EmitContext, receiver: IrOperand, key: string): FunctionId | null => {
  const representation = receiver.representation
  if (representation.kind !== 'class-ref') return null
  // [[Set]] resolves the same inherited member as [[Get]]. Looking only at
  // this class's own accessors mistakes a base setter for instance storage.
  const site = classMemberOf(ctx.classes, representation.declaration, key)
  if (site?.kind !== 'accessor') return null
  const accessor = site.accessor
  if (!accessor.setter) {
    throw createCppEmitBlockedError(
      'property-access:class-ref:set:false',
      `accessor "${key}" of class ${representation.declaration} declares only a getter, so writing it has no body to call`
    )
  }
  return accessor.setter
}

/**
 * The representation a receiver's own declared shape says one field holds.
 *
 * A thin `IrOperand`-shaped wrapper over `records.ts`'s
 * `declaredFieldRepresentationOf` -- the one authority both this file's field
 * STORE and `emit-allocation.ts`'s field INITIALIZER ask, so the two never
 * independently drift on what a field's declared carrier is. See that
 * function's own comment (and citations.md finding 1) for why a second table
 * here would be the wrong shape for this question.
 */
const declaredFieldRepresentation = (ctx: EmitContext, receiver: IrOperand, fieldName: string): Representation | null =>
  declaredFieldRepresentationOf(ctx.deriver, receiver.representation, fieldName, ctx.classes)

/**
 * What a reactive RECORD-field read obliges a consumer to do.
 *
 * The record half of `reactiveClassFieldClaim`, kept beside the record layout
 * for the same reason that one is kept beside the class layout: a class
 * resolves the DECLARING class along its inheritance chain first, a record has
 * no chain, so this is the whole of it. Both are asked by the one walk that
 * settles the channel before the body renders.
 *
 * A class-ref receiver is excluded rather than merely losing a race: the class
 * layout is the authority for a class's fields, and `celled` is derived from
 * what JSX binds, which is a different question with a different answer.
 */
export const reactiveRecordFieldClaim = (ctx: EmitContext, operation: GetOperation): ReactiveRevisionOrigin | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind === 'class-ref') return null
  const struct = structNameOfReceiver(receiver)
  if (struct === null) return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return null
  if (ctx.hosts.reactive.celled.get(struct)?.has(key) !== true) return null
  return { struct, key, receiver: operation.receiver }
}

/**
 * A store, plus the revision tick a store into reactive array state owes.
 *
 * Wrapped rather than pushed inside `emitFieldStoreLines`, which returns from a
 * dozen places: a tick that some branches emit and others forget is a list that
 * re-renders for some writes and not others, which is worse than one that never
 * re-renders because the failure depends on which member you wrote.
 */
export const emitFieldStore = (
  ctx: EmitContext,
  lines: string[],
  operation: SetOperation | DefineOwnPropertyOperation,
  label: string
): void => {
  emitFieldStoreLines(ctx, lines, operation, label)
  // REPLACING a revision-backed field, before the store-INTO-it rule below.
  // `this.pageAnchors = builder.anchors` is the largest change such a field can
  // undergo -- every element at once -- and it was the one change nothing
  // ticked: the revision cell is only reached through `reactiveOrigins`, which
  // is carried by a value read OUT of the array, and a whole-field assignment
  // reads nothing out of it. So the e-reader published a finished fourteen-
  // hundred page pagination over the one-page preview the reader had entered
  // on, and every slot bound to `pageAnchors__rev` kept rendering the preview.
  //
  // Asked of `revisions` -- the struct renderer's own record of which fields
  // GOT a revision cell -- so this cannot tick a companion that was never
  // rendered, and asked of the DECLARING struct for the reason the skip below
  // states.
  const storedKey = ctx.staticKeyTexts.get(operation.key.value)
  const storedStruct = storedKey === undefined ? null : fieldDeclaringStructOf(ctx.classes, operation.receiver.representation, storedKey)
  if (storedStruct !== null && storedKey !== undefined && ctx.hosts.reactive.revisions.get(storedStruct)?.has(storedKey) === true) {
    lines.push(`${reactiveRevisionText(ctx, { struct: storedStruct, key: storedKey, receiver: operation.receiver })}.notify();`)
  }
  // The receiver is either the array itself (`this.cells.length = 0`, an
  // element store) or something read out of it; both carry the same origin,
  // which is the point of carrying it on the value.
  const origin = ctx.reactiveOrigins.get(operation.receiver.value)
  if (origin === undefined) return
  // ...unless the member being written is itself a cell. `cell.filled = 1`
  // writes a `Signal<double>`, whose `operator=` notifies exactly the props
  // that read it -- one row's, not the whole list's. Ticking the array's
  // revision as well would rebuild every row of the list for a change that
  // touched one field of one element: the same answer, arrived at by throwing
  // the list away and building it again.
  //
  // What still ticks the revision is what the element cells genuinely cannot
  // see: `push`, `length = 0`, `cells[i] = other` -- changes to which elements
  // the list HAS, rather than to what one of them holds.
  const key = ctx.staticKeyTexts.get(operation.key.value)
  // Asked of `fieldDeclaringStructOf`, not of the receiver's own class:
  // `celled` is keyed by the struct that DECLARES the field, so an inherited
  // celled field reached through a subclass-typed receiver used to find
  // nothing here, fail this skip, and tick the whole array's revision for a
  // write one element's own cell had already notified -- rebuilding every row
  // of the list to deliver a change that touched one field of one element.
  const struct = key === undefined ? null : fieldDeclaringStructOf(ctx.classes, operation.receiver.representation, key)
  if (struct !== null && key !== undefined && ctx.hosts.reactive.celled.get(struct)?.has(key) === true) return
  // ...nor when NOTHING RENDERS the member. A revision tick exists to tell the
  // list its rows are stale; a member no row reads cannot have made one stale.
  // `syncCells()` writing `cell.piece = -1` -- a field the board never displays
  // -- was rebuilding all 200 rows every time a piece moved.
  //
  // Only for a RECORD receiver. A class field's reactivity is stated by the
  // plugin (`ReactiveCellPlan.fields`), and this map is not that authority;
  // an element record's is derived from what JSX binds, which is exactly this.
  const receiverKind = operation.receiver.representation.kind
  if (
    struct !== null &&
    key !== undefined &&
    (receiverKind === 'record' || receiverKind === 'native-record-ref') &&
    ctx.hosts.reactive.boundRecordFields.get(struct)?.has(key) !== true
  ) {
    return
  }
  lines.push(`${reactiveRevisionText(ctx, origin)}.notify();`)
}

/**
 * `this[key] = value` where the key's type is a CLOSED set of string literals,
 * each naming a declared field.
 *
 * The receiver keeps its native C++ type here, so the store below would
 * otherwise reach the runtime field dispatcher
 * (`emitNativeSidecarSet` -> `gea_writeOwnField`), which goes through
 * `gea::Value` and therefore refuses at RUN TIME, by name, for any field whose
 * carrier has no tag: `refuseUnaddressableField`. A callable field is exactly
 * that -- which is what left `overloaded-callable-fields.ts` aborting with
 * "a declared field whose carrier this runtime cannot box or unbox" on a write
 * that was statically closed all along.
 *
 * The dispatch is rendered by RE-ENTERING this function once per key, with a
 * context in which that key is the operation's static key text. Nothing here
 * decides how a field is stored, converted, presence-flagged, setter-dispatched
 * or reactively ticked -- the constant-key renderer decides all of it, exactly
 * as it does for a source-literal store, and this is only the switch that
 * chooses which of its answers runs. Re-implementing the tail instead would be
 * a second authority on member storage, differing from the first the day one
 * of them learns something.
 *
 * The arms carry `result: null` so the receiver alias is defined ONCE, after
 * the dispatch: `defineValueAlias` forbids a second definition of one SSA
 * value, and every arm would otherwise publish the same one.
 */
const emitTypedComputedWrite = (ctx: EmitContext, lines: string[], operation: SetOperation, label: string): boolean => {
  const recipe = operation.typedComputedWrite
  if (recipe === undefined) return false
  const receiver = operation.receiver.representation
  if (recipe.receiver !== representationKey(receiver) || recipe.keys.length === 0) {
    throw createCppEmitBlockedError(
      `property-access:${receiver.kind}:set:typed-computed-write`,
      'the sealed computed-write recipe does not match the store receiver'
    )
  }
  // An SSA id is not an identifier (`ssa|body|fn|decl|...`); the ordinal alone
  // distinguishes one closed dispatch from another nested inside it.
  const keyName = `gea_computed_key_${[...operation.key.value].reduce((hash, character) => (hash * 33 + character.charCodeAt(0)) >>> 0, 5381).toString(36)}`
  const body: string[] = [`const std::string& ${keyName} = ${operandText(ctx, operation.key)};`]
  for (const key of recipe.keys) {
    const armContext: EmitContext = { ...ctx, staticKeyTexts: new Map(ctx.staticKeyTexts).set(operation.key.value, key) }
    const arm: string[] = []
    const { typedComputedWrite: _sealed, ...constantKeyStore } = operation
    emitFieldStoreLines(armContext, arm, { ...constantKeyStore, result: null }, label)
    body.push(`if (${keyName} == ${cppStringLiteral(key)}) {`, ...arm.map((line) => `  ${line}`), '}')
  }
  lines.push('{', ...body.map((line) => `  ${line}`), '}')
  // The store's result is the receiver threaded onward, the same fact every
  // branch of the constant-key renderer publishes -- see its own tail.
  if (operation.result) defineValueAlias(ctx, operation.result, operandText(ctx, operation.receiver))
  return true
}

const emitFieldStoreLines = (
  ctx: EmitContext,
  lines: string[],
  operation: SetOperation | DefineOwnPropertyOperation,
  label: string
): void => {
  // The write counterpart of `emitGet`'s checked unwrap. TypeScript accepts
  // `a!.b = x`, but its erased assertion does not prove runtime presence.
  // Every branch below requires the payload carrier; the shared helper checks
  // absence before exposing it to either a read or a write.
  const present = unwrapPresentValue(ctx, lines, operation.receiver)
  if (present !== operation.receiver) {
    emitFieldStoreLines(ctx, lines, { ...operation, receiver: present }, label)
    return
  }
  if (!isDefaultDataDescriptor(operation)) {
    // Generated indexed records carry descriptor bits for both fixed slots
    // and each sidecar entry. Their fixed-first dispatcher can therefore
    // preserve a computed key collision exactly; the other storage families
    // below still have no place to retain non-default attributes.
    if (emitRecordIndexSidecarStore(ctx, lines, operation)) return
    // A dictionary is the second carrier that can. `gea::Dictionary` keeps the
    // three attributes for the keys that deviate from the ordinary ones, so a
    // non-default descriptor aimed at one is renderable and falls through to
    // the dictionary branch below rather than refusing here -- the same escape
    // the indexed record takes one line up, for the same reason.
    if (operation.receiver.representation.kind !== 'dictionary') {
      const attrs = (operation as DefineOwnPropertyOperation).attributes
      throw createCppEmitBlockedError(
        `property-access:${operation.receiver.representation.kind}:define-own-property:${String(ctx.staticKeyTexts.get(operation.key.value) === undefined)}`,
        `a "${label}" states a non-default descriptor (writable=${attrs.writable}, enumerable=${attrs.enumerable}, configurable=${attrs.configurable}); ` +
          'every store this backend renders installs the default writable/enumerable/configurable data property, and no C++ storage it writes into can ' +
          'express anything else, so a descriptor this compiler cannot honor is refused rather than silently applied as if it were the default'
      )
    }
  }
  // `ClassName.KEY = value` on the class value itself -- three.js's own
  // spelling for a class static (`Object3D.DEFAULT_UP = new Vector3(0,1,0)`),
  // which the language admits as an ordinary property store and no `static`
  // member declares. The storage is the whole-program census's own global
  // (`class-layout.ts`), emitted before any body runs, and the census refused
  // outright any key two writes carried differently -- so a key that resolves
  // here is one whose carrier every write already agreed on, and nothing at
  // this site reconciles one. A key it declines falls through to the same
  // refusal it reached before.
  const staticFieldKey = ctx.staticKeyTexts.get(operation.key.value)
  const staticField =
    staticFieldKey === undefined ? null : classConstructorStaticFieldStorage(ctx, operation.receiver.representation, staticFieldKey)
  if (staticField !== null) {
    const rawStaticValue = operandText(ctx, operation.value)
    const converted = alignedValueText(
      ctx,
      'emit-properties.ts:1079',
      operation.value.representation,
      staticField.representation,
      rawStaticValue
    )
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(operation.value.representation)}->${representationKey(staticField.representation)}`,
        `static field "${staticFieldKey}" is stored as "${representationKey(staticField.representation)}" and this write carries ` +
          `"${representationKey(operation.value.representation)}"; no conversion is installed between them`
      )
    }
    lines.push(`${staticField.name} = ${movedValueText(ctx, operation.value, staticField.representation, converted)};`)
    // A store's result is the receiver threaded onward, exactly as the record
    // branch below explains -- here that receiver is the class value itself.
    if (operation.result) defineValueAlias(ctx, operation.result, operandText(ctx, operation.receiver))
    return
  }
  if (namespaceMemberStore(ctx, lines, operation)) return
  if (emitTaggedUnionSet(ctx, lines, operation)) return
  if (operation.receiver.representation.kind === 'array-object') {
    const arrayReceiver = operandText(ctx, operation.receiver)
    // A store's result threads the receiver onward the same way the
    // record/class branch below does -- see that branch's own comment for why
    // it is the object and not a success boolean.
    const finishArrayStore = (): void => {
      if (!operation.result) return
      // The result IS the receiver -- the same object, not a copy of it -- so
      // it names the receiver's own storage rather than taking one. Copying it
      // out cost an atomic increment and a matching decrement per store, for a
      // value an object literal's own thread usually never reads.
      defineValueAlias(ctx, operation.result, arrayReceiver)
    }
    const key = ctx.staticKeyTexts.get(operation.key.value)
    if (key === 'length') {
      // `arr.length = n` is the Array exotic object's own truncate/extend
      // rule, not a field write: `setLength` in the runtime header is where
      // that rule lives, so nothing here decides truncation-vs-extension.
      lines.push(`${arrayReceiver}->setLength(${operandText(ctx, operation.value)});`)
      finishArrayStore()
      return
    }
    // A field the array's extended interface declares (`array-object.extension`,
    // `array.hasTrailingComma = ...` on a `MutableNodeArray<T>`): stored into
    // the extension sidecar, allocated by this first write
    // (`extensionFieldsMut`) -- the read side (`arrayAccessText`) never
    // allocates, so a never-written array stays a plain array.
    const extensionField = key === undefined ? undefined : operation.receiver.representation.extension?.find((field) => field.key === key)
    if (extensionField !== undefined && operation.receiver.representation.extension) {
      const struct = cppArrayExtensionStructName(operation.receiver.representation.extension)
      const stored = alignedValueText(
        ctx,
        'emit-properties.ts:1125',
        operation.value.representation,
        extensionField.value,
        operandText(ctx, operation.value)
      )
      if (stored === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(operation.value.representation)}->${representationKey(extensionField.value)}`,
          `cannot convert "${representationKey(operation.value.representation)}" into the array's own field "${key}" ` +
            `("${representationKey(extensionField.value)}")`
        )
      }
      const fields = `${arrayReceiver}->template extensionFieldsMut<${struct}>()`
      lines.push(`${fields}.${cppRecordFieldName(extensionField.key)} = ${stored};`)
      if (!extensionField.required) lines.push(`${fields}.${cppRecordFieldPresenceName(extensionField.key)} = true;`)
      finishArrayStore()
      return
    }
    // A STATIC key that names neither `length` nor a declared extension field
    // is either a canonical index or an ORDINARY property of the Array
    // object (`dynamicStrings.extra = true` off a `TemplateStringsArray` cast
    // to `any` -- the physical carrier is still the array, so the write
    // reaches here, but "extra" is nobody's element). That question --
    // "does this key even name an element" -- has to be answered BEFORE the
    // value is aligned to the element's type: aligning first meant a boolean
    // written to an ordinary property of a string array refused as
    // "cannot convert an Array element from scalar(boolean) to string", which
    // is a true fact about a conversion nobody asked for, not the real
    // refusal -- there is no property table for an Array's ordinary
    // properties, and that is the message this should have raised.
    if (key !== undefined) {
      const index = canonicalIndexLiteral(key)
      if (index === null) {
        throw createCppEmitBlockedError(
          `property-access:array-object:${operation.kind}:false`,
          `writing the Array property "${key}" is an ordinary property of the Array object, and no property table is installed for one`
        )
      }
      const rawStored = operandText(ctx, operation.value)
      const storedValue = alignedValueText(
        ctx,
        'emit-properties.ts:1140',
        operation.value.representation,
        operation.receiver.representation.element,
        rawStored
      )
      if (storedValue === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(operation.value.representation)}->${representationKey(operation.receiver.representation.element)}`,
          `cannot convert an Array element from "${representationKey(operation.value.representation)}" to ` +
            `"${representationKey(operation.receiver.representation.element)}"`
        )
      }
      lines.push(`${arrayReceiver}->setElement(${index}, ${storedValue});`)
      finishArrayStore()
      return
    }
    const rawStored = operandText(ctx, operation.value)
    const storedValue = alignedValueText(
      ctx,
      'emit-properties.ts:1140',
      operation.value.representation,
      operation.receiver.representation.element,
      rawStored
    )
    if (storedValue === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(operation.value.representation)}->${representationKey(operation.receiver.representation.element)}`,
        `cannot convert an Array element from "${representationKey(operation.value.representation)}" to ` +
          `"${representationKey(operation.receiver.representation.element)}"`
      )
    }
    // The store half of the string-keyed element access `emit-carrier-members.ts`
    // renders for a read: one CanonicalNumericIndexString conversion in front
    // of the ordinary `setElement`. No dense window is consulted -- a window is
    // admitted for a loop-bounded numeric index (`ir/dense-loops.ts`), and a
    // `for`-`in` key is not one.
    if (operation.key.representation.kind === 'string') {
      lines.push(`${arrayReceiver}->setElement(gea::detail::arrayIndexFromKeyText(${operandText(ctx, operation.key)}), ${storedValue});`)
      finishArrayStore()
      return
    }
    if (operation.key.representation.kind !== 'scalar') {
      throw createCppEmitBlockedError(
        `property-access:array-object:${operation.kind}:true`,
        `an Array element store keyed by a "${operation.key.representation.kind}" carrier needs a ToPropertyKey conversion, which is not installed`
      )
    }
    const writer = isIntegerStorageValue(ctx, operation.key.value) ? 'setElementAtIndex' : 'setElement'
    // Each operand is rendered ONCE and named twice: a deferred operand's text
    // is an expression this emitter built, and asking for it again is a second
    // rendering of the same operation, not a second read of a name.
    const stored = storedValue
    const dense = denseCellText(ctx, operation)
    const at = operandText(ctx, operation.key)
    const general = `${arrayReceiver}->${writer}(${at}, ${stored});`
    // The general arm takes the stored value by REFERENCE, and an arm that
    // never runs still costs that: a value whose address is taken anywhere in
    // the loop cannot be kept in registers, so the record this iteration just
    // built is written to a stack slot and read back before every dense store.
    // Copying into the arm's own local is the whole cure -- `object_create`
    // 8.2ms to 4.5ms against 3.8ms for the hand-written baseline, from one
    // `auto` -- and it costs the cold path a copy it was already paying for.
    // The name is block-scoped, so every arm may reuse it.
    const cold = `{ auto gea_cold = ${stored}; ${arrayReceiver}->${writer}(${at}, gea_cold); }`
    // The window's flag already says the array is writable -- `emit-arrays.ts`'s
    // `emitDenseSetup` folds `nativeOwnFieldsWritable` into it for every array
    // a window stores into -- so the store asks one loop-invariant local and
    // nothing else, which is what lets the backend unswitch and vectorize it.
    lines.push(dense === null ? general : `if (${dense.flag}) ${dense.text} = ${stored}; else ${cold}`)
    finishArrayStore()
    return
  }
  if (operation.receiver.representation.kind === 'typed-array') {
    const typedArrayReceiver = operandText(ctx, operation.receiver)
    // A store's result threads the receiver onward, for the same reason the
    // Array branch above does.
    const finishTypedArrayStore = (): void => {
      if (!operation.result) return
      defineValueAlias(ctx, operation.result, typedArrayReceiver)
    }
    const key = ctx.staticKeyTexts.get(operation.key.value)
    if (key === 'length') {
      // `Uint8Array.prototype.length` is a getter with no setter (ECMA-262
      // 23.2.7.2 defines no `[[Set]]` for it either), so the checker refuses
      // `buf.length = n` as a write to a readonly property before this
      // emitter is ever asked to render one -- there is no truncate/extend
      // rule to write here, unlike an Array's `length`.
      throw createCppEmitBlockedError(
        `property-access:typed-array:${operation.kind}:false`,
        'writing "length" on a typed array has no meaning; ECMA-262 defines no setter for it and the checker refuses the assignment first'
      )
    }
    if (key !== undefined) {
      const index = canonicalIndexLiteral(key)
      if (index === null) {
        throw createCppEmitBlockedError(
          `property-access:typed-array:${operation.kind}:false`,
          `writing the typed array property "${key}" is an ordinary property, and typed arrays have no ordinary-property table`
        )
      }
      lines.push(`${typedArrayReceiver}->setElement(${index}, ${operandText(ctx, operation.value)});`)
      finishTypedArrayStore()
      return
    }
    if (operation.key.representation.kind !== 'scalar') {
      throw createCppEmitBlockedError(
        `property-access:typed-array:${operation.kind}:true`,
        `a typed array element store keyed by a "${operation.key.representation.kind}" carrier needs a ToPropertyKey conversion, which is not installed`
      )
    }
    const dense = denseCellText(ctx, operation)
    const value = operandText(ctx, operation.value)
    const general = `${typedArrayReceiver}->setElement(${operandText(ctx, operation.key)}, ${value});`
    lines.push(
      dense === null
        ? general
        : `if (${dense.flag}) gea::TypedArray<${cppScalarType(operation.receiver.representation.element)}>::writeInBounds(${dense.pointer}, ${dense.index}, ${value}); else ${general}`
    )
    finishTypedArrayStore()
    return
  }
  const dictionaryTarget = dictionaryTableOf(ctx, operation.receiver, operation.key)
  if (dictionaryTarget !== null && operation.receiver.representation.kind === 'dictionary') {
    // `setProperty` and not `operator[]`: 10.1.9 refuses a store to a
    // non-writable property, and a dictionary can hold one since
    // `Object.defineProperty` on it began retaining attributes. `operator[]`
    // remains the unconditional insert-or-find every internal rewrite uses --
    // inserting a missing key is exactly the store rule for a key nothing has
    // restricted -- but a program's own assignment has to be able to fail.
    // `SetOperation.strict` has carried the consequence of that failure since
    // the IR was written; this carrier is the last one with a failure to
    // report it for.
    //
    // The value is reconciled against the table's *declared* value carrier for
    // the same reason a struct member is below: a `{ [key: string]: string |
    // number | boolean }` table holds one joined carrier, and a literal `true`
    // written into it is a `bool` that only becomes that carrier through the
    // union's own arm constructor. Without this the store spells `table[k] =
    // true` against a `TaggedUnion` and no overload accepts it.
    const dictionaryValueText = operandText(ctx, operation.value)
    const widened =
      alignedValueText(
        ctx,
        'emit-properties.ts:1253',
        operation.value.representation,
        operation.receiver.representation.value,
        dictionaryValueText
      ) ?? dictionaryValueText
    if (operation.kind === 'define-own-property') {
      // `[[DefineOwnProperty]]`, which states all three attributes outright
      // and throws on 10.1.6.3's refusal whatever the surrounding strictness
      // -- `Object.defineProperty` is not an assignment and has no sloppy
      // discard. The three are bare booleans rather than `std::optional`
      // because this operation always states them; the optional overload is
      // for a descriptor object, which may not.
      const attrs = operation.attributes
      const stated = `${attrs.writable}, ${attrs.enumerable}, ${attrs.configurable}`
      lines.push(
        `if (!${dictionaryTarget.member}definePropertyFrom(${dictionaryTarget.key}, ${widened}, ${stated})) ` +
          'gea::host::throwRuntimeError("TypeError", "Cannot redefine property");'
      )
    } else {
      const refused = `!${dictionaryTarget.member}setProperty(${dictionaryTarget.key}, ${widened})`
      lines.push(
        operation.strict
          ? `if (${refused}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");`
          : `(void)(${refused});`
      )
    }
    if (operation.result) {
      // Threaded onward as the receiver, for the reason the struct-member
      // branch below states: a store has no failure to report, and what a
      // consumer reads next is the object itself.
      defineValueAlias(ctx, operation.result, operandText(ctx, operation.receiver))
    }
    return
  }
  if (emitNativeHostStore(ctx, lines, operation, label)) return
  // Every store into a regular-expression carrier except `lastIndex`, which
  // returns and falls through to the ordinary struct-member write below
  // because on this carrier it IS one. Placed here rather than at the end so
  // the dynamic and sidecar paths cannot claim the receiver first.
  // A capture-slot store, which is an ELEMENT store on the Array the match
  // result is -- see `regexpCaptureSlotStoreClaim`. Rendered here, beside the
  // other regexp store paths, so the refusal below cannot claim it first.
  const captureSlot = regexpCaptureSlotStoreClaim(ctx, operation)
  if (captureSlot !== null && operation.kind === 'set') {
    const receiverText = operandText(ctx, operation.receiver)
    const stored = alignedValueText(
      ctx,
      'emit-properties.ts:capture-slot',
      operation.value.representation,
      { kind: 'string' },
      operandText(ctx, operation.value)
    )
    if (stored === null) {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(operation.receiver.representation)}:set:true`,
        `a capture slot holds a string (ECMA-262 22.2.7.2 puts a string or \`undefined\` in every slot, and the declared element of both result ` +
          `interfaces is \`string\`), and this store's "${representationKey(operation.value.representation)}" carrier has no conversion into one`
      )
    }
    lines.push(`${receiverText}->setCapture(${captureSlot.slotText}, ${stored});`)
    // Threaded onward as the receiver, exactly as the Array and dictionary
    // stores above do: a store has no failure to report and what a consumer
    // reads next is the object itself.
    if (operation.result) defineValueAlias(ctx, operation.result, receiverText)
    return
  }
  if (emitRegExpSet(ctx, lines, operation)) return
  regexpStoreRefusal(ctx, operation.receiver, operation.key)
  if (emitStringObjectSet(ctx, lines, operation)) return
  // The dynamic receiver's own property table. `define-own-property` reaches
  // it too and is rendered as the ordinary `[[Set]]` the descriptor-free case
  // reduces to: this operation's `attributes` are the default writable/
  // enumerable/configurable triple a fresh assignment creates, which is
  // exactly what `DynamicObject::set` installs.
  // Before the dynamic routes: a closed literal key set is a compile-time
  // dispatch over declared fields, and reaches carriers the runtime field
  // dispatcher below cannot address at all.
  if (operation.kind === 'set' && emitTypedComputedWrite(ctx, lines, operation, label)) return
  if (emitDynamicSet(ctx, lines, operation)) return
  // A CONSTANT key that names no declared field of a receiver whose shape
  // carries an index signature -- the store counterpart of the
  // `recordIndexSidecarReadText` branch in `emitGet` above, and rendered
  // beside it rather than here so one module owns both directions.
  if (emitRecordIndexSidecarStore(ctx, lines, operation)) return
  // The same sidecar as the read above, for a write: the declared member is
  // written IN PLACE through the struct's own field dispatcher, so a native
  // read of that member sees it, and only a key the struct does not declare
  // reaches the side table.
  if (emitNativeSidecarSet(ctx, lines, operation)) return
  const ownership = recordOwnershipOf(operation.receiver, `a "${label}" operation`)
  const accessor = memberAccessOperator(ownership)
  const receiverText = operandText(ctx, operation.receiver)
  const fieldName = staticKeyTextOf(ctx, operation.key, `a "${label}" operation`)
  const rawValueText = operandText(ctx, operation.value)
  // A field whose declared representation is `dynamic` (a program-declared
  // `any`, the one case this widens today) needs its concrete value boxed on
  // the way in -- the same "held vs written" reconciliation
  // `emit-bindings.ts` already applies to a binding cell, applied here to a
  // struct member instead. See citations.md finding 1.
  // Accessors have no field storage. Reconcile their argument against the
  // emitted setter parameter instead, including setters inherited from a base.
  const setter = classAccessorSetter(ctx, operation.receiver, fieldName) ?? recordAccessorBody(ctx, operation.receiver, fieldName, 'setter')
  const setterParameter = setter === null ? null : ctx.abiOfCallable(setter)?.parameters[0]?.value
  if (setter !== null && !setterParameter) {
    throw createCppEmitBlockedError(`call-abi:accessor-setter:${fieldName}`, `setter "${fieldName}" has no emitted parameter convention`)
  }
  const held = setterParameter ?? declaredFieldRepresentation(ctx, operation.receiver, fieldName)
  // `convertedValueText` returns the text UNCHANGED when the carriers already
  // agree, where the `widenedStoreText` this replaced returned `null`. That
  // difference is load-bearing exactly here, because the `??` below reads
  // `null` as "nothing to reconcile, so this store may MOVE": taking the
  // unchanged text as a conversion silently dropped `std::move` from every
  // identity member store -- 39 programs' emitted C++, with the line count
  // unchanged so no column moved and nothing else would have caught it.
  // Folding it back to `null` restores the move and keeps the real
  // conversions, which is the whole point of the change.
  // The structural interface view, asked only where the ordinary conversion
  // has refused -- the same order `emit-callable.ts`'s argument path uses, and
  // for the same reason: the view does not preserve identity, so a pair with a
  // real conversion must never reach it. hono's `this.router = new
  // PatternRouter()` stores a class instance into a field declared as the
  // `Router` interface, which is a rebuild and not a cast.
  const reconciled =
    held === null
      ? null
      : (alignedValueText(ctx, 'emit-properties.ts:1324', operation.value.representation, held, rawValueText) ??
        structuralRecordViewText(ctx, operation.value.representation, held, rawValueText))
  // FAIL CLOSED, the same rule `emit-bindings.ts`'s `emitBindingWrite` already
  // enforces for an identifier cell: a `held` carrier actually present with
  // `reconciled === null` means no recipe exists for this pair, not that none
  // was needed -- `held === null` (no record layout, or a key this program
  // never declares) is the only legitimate reason to fall through unconverted.
  //
  // This was gated on `setter !== null` alone until this fix, which reads as
  // "an accessor's argument must convert, but a PLAIN FIELD'S needn't" -- a
  // distinction the language does not draw. A `null`-declared JS record field
  // (`const state = { rectAreaLTC1: null }`, three's `WebGLLights.js`) later
  // stored from an optional class-ref falls through this exact gap: preflight
  // reports the store clean, a certificate mints, and the raw unconverted
  // `gea::Optional<gea::Ref<T>>` expression lands in a `std::nullptr_t` field
  // -- caught only by clang, and only because `std::nullptr_t` happens to
  // declare no such assignment operator. A plain field's own unconvertible
  // store is a refusal exactly as much as an accessor's is.
  if (held !== null && reconciled === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.value.representation)}->${representationKey(held)}`,
      setter !== null
        ? `setter "${fieldName}" has no conversion from its argument to its emitted parameter`
        : `writes "${fieldName}" as a ${shortCarrierText(operation.value.representation)} into a field held as ` +
            `${shortCarrierText(held)}, and no conversion is installed between them; ${carrierDifference(operation.value.representation, held)}`
    )
  }
  const widenedText = reconciled === rawValueText ? null : reconciled
  // A member store is the same handover a call argument is: what the value
  // held is now the member's, and nothing reads the value again. The
  // constructor of a refcounted class is where this pays -- `this.left =
  // left` on a parameter the frame is about to drop.
  const valueText = widenedText ?? movedValueText(ctx, operation.value, held, rawValueText)
  // An accessor-backed member is written by *calling* its setter. The receiver
  // is still threaded onward below, because what a store publishes is the
  // object written into and not whatever the setter body happens to return.
  // An overridden setter dispatches through the object for the same reason an
  // overridden getter does: `rule.weight = v` on a receiver typed as the base
  // must reach the subclass's own setter, and binding the base's body would
  // write the wrong one with nothing to show for it at compile time.
  const setterDispatch =
    setter === null || operation.receiver.representation.kind !== 'class-ref'
      ? undefined
      : ctx.virtualDispatch.get(virtualDispatchKey(operation.receiver.representation.declaration, fieldName, 'set'))
  if (setter !== null && setterDispatch !== undefined && !dispatchesStatically(ctx, operation.receiver)) {
    lines.push(`${receiverText}->${cppVirtualMemberName(fieldName, 'set')}(${valueText});`)
  } else if (setter !== null) {
    const environment = accessorEnvironmentArguments(ctx, operation.receiver.representation, fieldName, setter, 'setter', receiverText)
    lines.push(`${cppBodyName(setter)}(${[...environment, receiverText, valueText].join(', ')});`)
  } else if (isNativeError(operation.receiver.representation) && fieldName === 'cause') {
    lines.push(`${receiverText}->setCause(${valueText});`)
  }
  // `fieldName` stays the property key everywhere above: the three lookups
  // that consumed it match against `RecordField.key`. Only the text emitted
  // here is a C++ member, and that spelling has exactly one authority.
  else {
    const target = `${receiverText}${accessor}${cppRecordFieldName(fieldName)}`
    const append = held?.kind === 'string' ? propertyAppendLines(ctx, operation, fieldName, target) : null
    const field = declaredRecordFieldOf(ctx.deriver, operation.receiver.representation, fieldName, ctx.classes)
    const stores = append === null ? [`${target} = ${valueText};`] : [...append]
    // A member the NATIVE base owns (`name` on `gea::runtime::Error`) has the
    // one member and nothing beside it: no presence bit, no attribute triple,
    // and no way to be absent or read-only. Emitting the generated-struct
    // recipe for it named members no struct in the program declares.
    if (nativeBaseFieldOf(ctx.deriver, operation.receiver.representation, fieldName, ctx.classes)) {
      lines.push(stores.join(' '))
      if (operation.result) defineValueAlias(ctx, operation.result, receiverText)
      return
    }
    // A required field the program can never delete is present for the
    // object's whole life (`ctx.fixedFieldStateConstant`), so there is no bit
    // to re-set -- `records.ts` declared it `static` on the same fact.
    if (field && !(field.required && ctx.fixedFieldStateConstant))
      stores.push(`${receiverText}${accessor}${cppRecordFieldPresenceName(fieldName)} = true;`)
    const fieldWritable = `${receiverText}${accessor}${cppRecordFieldAttributesName(fieldName)}.writable`
    const present = field === undefined ? 'true' : `${receiverText}${accessor}${cppRecordFieldPresenceName(fieldName)}`
    // With nothing in the unit able to freeze an object or redefine a field
    // (`ctx.nativeIntegrityRestricted`), the attribute bit is its default and
    // the object is extensible, so the guard is `true` and the store is the
    // store. See `ir/integrity-restrictions.ts` for what that buys a loop.
    const writable = !ctx.nativeIntegrityRestricted
      ? 'true'
      : ownership === 'shared-refcount'
        ? `(${present} ? (${fieldWritable} && gea::nativeOwnFieldsWritable(${receiverText})) : gea::nativeIsExtensible(${receiverText}))`
        : fieldWritable
    const store = stores.join(' ')
    if (writable === 'true') lines.push(store)
    else if (operation.kind === 'set' && operation.strict) {
      lines.push(`if (!${writable}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property"); else { ${store} }`)
    } else lines.push(`if (${writable}) { ${store} }`)
  }
  if (!operation.result) return
  // A store's result is the receiver threaded onward, not the success boolean
  // the internal method nominally returns: a native field store has no failure
  // to report, and the value a consumer goes on to read is the object itself.
  // It therefore NAMES the receiver rather than copying it: three field stores
  // building one object literal were three refcount pairs on a value the
  // literal's own thread was the only reader of.
  defineValueAlias(ctx, operation.result, receiverText)
}

/**
 * A native field's own string update reuses either the field buffer when its
 * old-value read is deferred, or a materialized old-value snapshot when
 * ownership liveness proves that snapshot dies at the addition. The latter
 * preserves reads across intervening calls and moves the grown snapshot home.
 * Accessors keep their calls.
 */
const propertyAppendLines = (
  ctx: EmitContext,
  operation: SetOperation | DefineOwnPropertyOperation,
  field: string,
  target: string
): readonly string[] | null => {
  if (operation.kind !== 'set') return null
  const addition = ctx.computeOrigins.get(operation.value.value)
  if (!addition || addition.form !== 'binary' || addition.operator !== '+' || addition.result.representation.kind !== 'string') return null
  const [left, ...suffix] = addition.operands
  if (addition.operands.length < 2 || left?.representation.kind !== 'string') return null
  if (suffix.some((operand) => operand.representation.kind !== 'string')) return null
  if (!ctx.deferredTexts.has(addition.result.id)) return null
  const read = ctx.propertyReadOrigins.get(left.value)
  if (!read || ctx.staticKeyTexts.get(read.key.value) !== field || !isPlainMemberRead(ctx, read, field)) return null
  const sameReceiver =
    read.receiver.value === operation.receiver.value ||
    (ctx.receiverValues.has(read.receiver.value) && ctx.receiverValues.has(operation.receiver.value))
  if (!sameReceiver) return null
  // Withheld or aliased to the field itself: see `compoundAppendLines`
  // (emit-bindings.ts) for why both forms read the storage in place.
  if (ctx.deferredTexts.has(left.value) || ctx.valueNames.get(left.value) === target) return [stringAppendStatement(ctx, target, suffix)]
  if (!ctx.ownedValues.has(left.value) || !ctx.ownedDyingValues.has(left.value)) return null
  const snapshot = operandText(ctx, left)
  return [stringAppendStatement(ctx, snapshot, suffix), `${target} = std::move(${snapshot});`]
}
