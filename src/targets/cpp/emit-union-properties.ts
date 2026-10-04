import type { Representation } from '../../representation/model.js'
import { dictionaryKeyDomainOf, representationKey } from '../../representation/model.js'
import { typedArrayUnionOnly } from '../../representation/host-templates.js'
import type { IrValueId } from '../../identity/ids.js'
import type { DefineOwnPropertyOperation, GetOperation, IrBody, IrOperand, SetOperation } from '../../ir/model.js'
import type { PrimitiveArmDomain } from '../../semantics/model/operations.js'
import { allOperationsOf } from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import {
  createCppEmitBlockedError,
  defineValueAlias,
  operandText,
  presentViewOf,
  wellKnownSymbolMemberOf,
  type EmitContext,
  type PrototypeMethodRead,
  type UnionMemberTypeofAnswer,
  type UnionMemberTypeofRead,
  type UnionMethodArm,
  type UnionMethodRead
} from './emit-context.js'
import { functionSourceReadClaimOf } from './function-source-reads.js'
import {
  literalPropertyKeyText,
  cppBodyName,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn
} from './types.js'
import { declaredFieldCreationText, declaredFieldRepresentationOf, declaredRecordFieldOf } from './records.js'
import { tracksKeyOrder } from './key-order-tracking.js'
import {
  absentCapableNumericElementText,
  keyedTableKeyText,
  memberAccessOperator,
  positionalRecordArityText
} from './emit-carrier-members.js'
import { alignedValueText, classFamilyLoadText, receiverBoundFieldText, widenedStoreText } from './emit-narrowing.js'
import { canonicalIndexLiteral, stringIndexText, isDeclaredStringPrototypeKey } from './emit-carrier-members.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import { classFamilyOverridesOf, classMemberOf } from './class-layout.js'
import { classMethodOverrideOf, classStaticMemberOf } from '../../projection/fields.js'
import { classMethodValueArmsOf, virtualDispatchKey } from '../../projection/dispatch.js'
import { cppVirtualMemberName } from './virtual-methods.js'
import { abiOfCallee } from '../../projection/callee.js'
import { recordAccessorsOfShape } from './records.js'
import { cppRecordIndexSidecarName } from './records.js'
import { hasNativeNumericIndexArms, nativeNumericIndexOf } from '../../representation/numeric-index.js'
import { binaryToStringTagText, typedArrayBufferMemberText, typedArrayPrototypeMethods } from './emit-buffers.js'
import { typeofTextFor } from './emit-typeof.js'
import { keyedCollectionPrototypeMethods, promisePrototypeMethods } from './prototype/emit-prototype-invoke.js'
import { arrayInheritedMemberRefusals, arrayMemberRefusals, arrayPrototypeMethods } from './prototype/emit-prototype-array.js'
import {
  classConstructorStaticFieldStorage,
  classConstructorStaticMemberTextFor,
  classMethodValueText,
  constructorViewFieldFor
} from './class-properties/emit-class-properties.js'
import { overriddenMethodValueText, publishedMethodCopyOf } from './class-properties/computed-method-value.js'
import { constructorValueDispatchTypedMemberText, propertyKeyText } from './emit-dynamic-properties.js'
import { toStringTextOver, type ToStringLayouts } from './emit-tostring.js'
import { recordLayoutPolicyOf } from '../../projection/fields.js'

/**
 * Whether a read off a union whose every arm is a typed array is a deferred
 * `TypedArray.prototype` method read, and which one.
 *
 * The arms differ in what they store, never in what the method means, so the
 * whole union is one receiver for the call that follows -- which is why the
 * carrier travels with the claim: the invoker dispatches the arm.
 *
 * Stated once; `taggedUnionGetText` and the prototype-read walk both ask it.
 */
export const deferredTypedArrayUnionMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'tagged-union' || !taggedUnionHasOnlyTypedArrayArms(carrier)) return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !typedArrayPrototypeMethods.has(staticKey)) return null
  return {
    receiverKind: 'typed-array-union',
    member: staticKey,
    receiver: { kind: 'operand', operand: receiver },
    receiverElement: null,
    typedArrayUnionCarrier: carrier
  }
}

/**
 * The receiver a tagged union's per-arm class-method read has to keep, or
 * `null` -- the union twin of `classMethodValueReceiverClaim`.
 *
 * A class arm materializes a method value whose physical convention leads with
 * the arm's own receiver, while the read's receiver is the whole union, so the
 * call that consumes it has to be handed that union back
 * (`EmitContext.directCallReceivers`).
 *
 * `deferredUnionMethodArms` is ASKED rather than restated: a union whose EVERY
 * arm answers this key is claimed whole, before the per-arm walk runs, and
 * only a union it declines reaches `armRuntimeFieldText`. Its text arguments
 * do not affect whether it claims, so passing empty ones asks exactly the
 * question without spelling anything.
 */
export const unionClassMethodValueReceiverClaim = (ctx: EmitContext, operation: GetOperation): IrOperand | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union') return null
  // Only a read that PUBLISHES the receiver-leading convention leaves the
  // receiver for its call to supply. Where the published callable states none,
  // each arm has already bound its own receiver into the value
  // (`receiverBoundFieldText`), and handing the union back at the call would
  // pass it as the first ARGUMENT.
  // A union whose other arms lack the member publishes the method as
  // `optional(callable)`: those arms answer `undefined`. The call behind a
  // guard (`value && value.isColor ? value.getHex() : ...`) still fills the
  // callable's receiver slot, so the claim reads the convention through that
  // absence. three.js's `ShaderMaterial.toJSON` reads `getHex` this way.
  const published = operation.result.representation
  const callable = published.kind === 'optional' && published.absence === 'undefined' ? published.payload : published
  const publishedAbi = abiOfCallee(callable)
  if (publishedAbi === null || publishedAbi.receiver === null) return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined || objectPrototypeMemberNames.has(key)) return null
  if (ctx.unionMethodReads.has(operation.result.id)) return null
  for (const leaf of unionPropertyLeaves(receiver, '')) {
    const arm = leaf.representation
    if (arm.kind !== 'class-ref') continue
    const site = classMemberOf(ctx.classes, arm.declaration, key)
    if (site === null || site.kind !== 'method' || site.method.callable === null) continue
    if (classFamilyOverridesOf(ctx.classes, arm.declaration, key).length > 0) {
      if (classMethodValueArmsOf(ctx.classes, arm.declaration, key) !== null) return operation.receiver
      continue
    }
    if (ctx.captures.of(site.method.callable).kind !== 'none' || ctx.abiOfCallable(site.method.callable) === null) continue
    return operation.receiver
  }
  return null
}

/**
 * Property access over a native tagged union dispatches on the live arm.
 * Declared fields, native indexed storage, and ordinary string properties
 * retain their carriers. Nullish indexed arms throw. Unsupported prototype
 * members and accessor dispatch remain explicit refusals.
 */

/** Receiver kinds with a declared native field layout. */
const addressableArmKind = (kind: Representation['kind']): boolean =>
  kind === 'record' || kind === 'record-with-index' || kind === 'native-record-ref' || kind === 'class-ref'

/** Native object carriers whose ordinary expando properties live in the runtime sidecar. */
const sidecarArm = (representation: Representation): boolean => {
  if (!('ownership' in representation) || representation.ownership !== 'shared-refcount') return false
  return (
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'native-record-ref' ||
    representation.kind === 'class-ref' ||
    representation.kind === 'array-object' ||
    representation.kind === 'typed-array' ||
    representation.kind === 'array-buffer' ||
    representation.kind === 'shared-array-buffer' ||
    representation.kind === 'data-view' ||
    representation.kind === 'keyed-collection'
  )
}

/**
 * ECMA-262's whole prototype member set for each keyed-collection family
 * (24.1.3, 24.2.3, 24.3.3, 24.4.3) -- every member the language defines, not
 * only the ones this backend renders, because the question asked of it is
 * "does the object answer this key from its prototype", and an unrendered
 * `forEach` is still not `undefined`.
 */
const keyedCollectionIntrinsicMembers: Readonly<Record<'map' | 'set' | 'weak-map' | 'weak-set', ReadonlySet<string>>> = {
  map: new Set(['clear', 'delete', 'entries', 'forEach', 'get', 'has', 'keys', 'set', 'size', 'values']),
  set: new Set([
    'add',
    'clear',
    'delete',
    'difference',
    'entries',
    'forEach',
    'has',
    'intersection',
    'isDisjointFrom',
    'isSubsetOf',
    'isSupersetOf',
    'keys',
    'size',
    'symmetricDifference',
    'union',
    'values'
  ]),
  'weak-map': new Set(['delete', 'get', 'has', 'set']),
  'weak-set': new Set(['add', 'delete', 'has'])
}

/**
 * Whether the arm's native object -- the arm itself, or the collection or
 * promise its class extends in place -- answers `key` from its own intrinsic
 * prototype.
 *
 * The expando sidecar (`gea::nativeDynamicGet`) reads the declared fields and
 * the identity-keyed own-property table, and nothing else: an inherited
 * `Map.prototype.entries` is in neither, so routing such a key there answers
 * `undefined` for a member the object has. mongodb's
 * `Object.fromEntries(DEFAULT_OPTIONS.entries())` in the Topology constructor
 * read `entries` off the union of `CaseInsensitiveMap`'s two layout copies that
 * way, and the call that followed adapted the `undefined` box into a callable
 * returning `gea::Iterator` -- a carrier no box can hold. Such an arm is one
 * that "does not answer this member" in the sense the union read refuses by
 * name.
 */
const nativePrototypeAnswers = (arm: Representation, key: string): boolean => {
  const native = arm.kind === 'class-ref' ? arm.nativeBase : arm
  if (native === undefined) return false
  if (native.kind === 'keyed-collection') return keyedCollectionIntrinsicMembers[native.family].has(key)
  if (native.kind === 'promise') return promisePrototypeMethods.has(key)
  return false
}

/**
 * One arm's own field access, or `null` when this arm cannot answer the key at
 * all -- either because its kind carries no declared-field table (`scalar`,
 * `string`, `array-object`, `native-handle`, ...) or because it does and the
 * key simply names none of its fields. Both are the identical fact the caller
 * needs: "this arm does not have it," which is what makes a union with even
 * one such arm a narrowing the program never stated.
 *
 * Class arms first consult their semantic member table. Their physical record
 * can contain inherited or synthetic slots with the same spelling as a method
 * or accessor; those slots must not shadow the class member during a union
 * read. Missing class members likewise proceed to the runtime-property path
 * instead of acquiring meaning from an unrelated physical slot.
 */
const armFieldSite = (
  ctx: EmitContext,
  arm: Representation,
  armExprText: string,
  key: string
): { readonly text: string; readonly representation: Representation; readonly presence: string | null } | null => {
  if (!addressableArmKind(arm.kind)) return null
  if (arm.kind === 'class-ref') {
    const member = classMemberOf(ctx.classes, arm.declaration, key)
    if (member === null || member.kind !== 'field') return null
  }
  const declared = declaredFieldRepresentationOf(ctx.deriver, arm, key, ctx.classes)
  if (declared === null) return null
  // Every addressable kind above carries `.ownership` (records.ts's own
  // `declaredFieldRepresentationOf` reads the identical three kinds), so this
  // narrowing is safe.
  const ownership = (arm as Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' | 'class-ref' }>).ownership
  const accessor = memberAccessOperator(ownership)
  const field = declaredRecordFieldOf(ctx.deriver, arm, key, ctx.classes)
  const generated = arm.kind !== 'native-record-ref' || arm.native === null
  return {
    text: `${armExprText}${accessor}${cppRecordFieldName(key)}`,
    representation: declared,
    presence: generated && field && !field.required ? `${armExprText}${accessor}${cppRecordFieldPresenceName(key)}` : null
  }
}

/**
 * Native property lookup when a union arm has no declared field at this key.
 * A genuine dynamic arm keeps its property table. Native objects retain their
 * identity and use their sidecar; string/array own properties stay native too.
 * Missing string properties can be absent, while known prototype members and
 * unsupported object arms need a real recipe and are refused rather than boxed.
 */
/**
 * What an arm that PROVABLY lacks the member answers.
 *
 * `undefined` where the read's own carrier can hold it -- which is the whole
 * answer for `(value as { label?: string }).label` off a `string` arm, and the
 * one this file already rendered. Where it cannot, the carrier is a bare one
 * the checker only reached because an `as` asserted this value is the OTHER
 * arm, so the arm renders the TypeError the language would throw at the very
 * next use of the `undefined` it would have produced. Refusing the whole
 * program instead -- which is what a `null` here does -- refuses every arm on
 * account of one the program says cannot occur.
 *
 * Reached only after the caller has discharged "the member might exist here":
 * `objectPrototypeMemberNames` and `isDeclaredStringPrototypeKey` are the
 * target's own model of what a primitive arm carries, and an arm whose member
 * set is not modelled returns `null` above rather than arriving here.
 */
const absentArmText = (published: Representation, key: string, arm: string): string => {
  const undefinedText = cppUndefinedIn(published)
  if (undefinedText !== null) return undefinedText
  return `gea::host::throwAbsentUnionMember<${cppTypeOf(published)}>(${cppStringLiteral(key)}, ${cppStringLiteral(arm)})`
}

/**
 * The runtime key a box or a sidecar arm is asked with. A field key spelling
 * a program symbol (`sym(...)`, `cppRecordFieldKeyIsSymbol`) is that symbol,
 * looked up by the marker its cell registered at creation -- the id the
 * generated field dispatchers (`records.ts`) compare against. Asked by its
 * spelling as a STRING, the box answered `undefined` for a member it held:
 * mongodb's `decrypted[kDecoratedKeys]` off the nested document
 * `decorateDecryptionResult` recursed into.
 */
/** The primitive domain an arm's value belongs to, as `PrimitiveArmDomain` names it -- `null` for an object arm. */
export const primitiveArmDomainOf = (arm: Representation): PrimitiveArmDomain | null => {
  if (arm.kind === 'string' || arm.kind === 'symbol') return arm.kind
  if (arm.kind !== 'scalar') return null
  return arm.domain === 'boolean' || arm.domain === 'bigint' ? arm.domain : 'number'
}

const unionArmPropertyKeyText = (key: string): string =>
  cppRecordFieldKeyIsSymbol(key)
    ? `gea::PropertyKey::symbol(gea::Symbol(gea::detail::declaredSymbolId<${cppStringLiteral(key)}>()))`
    : literalPropertyKeyText(key)

const armRuntimeFieldText = (
  ctx: EmitContext,
  arm: Representation,
  armExprText: string,
  key: string,
  operation: GetOperation
): string | null => {
  const published = operation.result.representation
  if (arm.kind === 'null' || arm.kind === 'undefined') {
    return `gea::host::throwGetPropertyOfNullish<${cppTypeOf(published)}>("${arm.kind}")`
  }
  if (wellKnownSymbolMemberOf(ctx, operation.key) === 'toStringTag') {
    const tag = binaryToStringTagText(arm)
    if (tag !== null) return alignedValueText(ctx, 'emit-union-properties.ts:116', { kind: 'string' }, published, tag)
  }
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const propertyKey = unionArmPropertyKeyText(key)
  if (arm.kind === 'dynamic')
    return alignedValueText(ctx, 'emit-union-properties.ts:120', arm, published, `${armExprText}.getProperty(${propertyKey})`)
  const index = canonicalIndexLiteral(key)
  if (arm.kind === 'string') {
    if (key === 'length')
      return alignedValueText(
        ctx,
        'emit-union-properties.ts:124',
        { kind: 'scalar', domain: 'number' },
        published,
        `static_cast<double>(gea::runtime::string::utf16Length(${armExprText}))`
      )
    if (index !== null) return stringIndexText(armExprText, index, operation.result, key)
    if (objectPrototypeMemberNames.has(key) || isDeclaredStringPrototypeKey(key)) return null
    return absentArmText(published, key, 'string')
  }
  if (arm.kind === 'array-object') {
    if (key === 'length')
      return alignedValueText(
        ctx,
        'emit-union-properties.ts:134',
        { kind: 'scalar', domain: 'number' },
        published,
        `${armExprText}->length()`
      )
    if (index !== null) return arrayArmReadText(armExprText, 'elementAt', index, arm.element, published)
    // An ORDINARY own property of the Array object -- a name no Array
    // inherits and its extended interface does not declare -- lives in the
    // identity-keyed expando table every native object shares, exactly as the
    // lone-array read hands it there (`arrayAccessText`). bson's size walk
    // reads `(obj as any)?.toBSON` off a `Document` whose arms include the
    // array view.
    if (
      !arrayPrototypeMethods.has(key) &&
      !arrayMemberRefusals.has(key) &&
      !arrayInheritedMemberRefusals.has(key) &&
      !objectPrototypeMemberNames.has(key) &&
      !(arm.extension?.some((field) => field.key === key) ?? false) &&
      arm.ownership === 'shared-refcount'
    )
      return alignedValueText(
        ctx,
        'emit-union-properties.ts:array-arm-own-property',
        boxed,
        published,
        `gea::nativeDynamicGet(${armExprText}, ${propertyKey})`
      )
    return null
  }
  if (arm.kind === 'typed-array') {
    if (key === 'length') {
      return alignedValueText(
        ctx,
        'emit-union-properties.ts:139',
        { kind: 'scalar', domain: 'number' },
        published,
        `${armExprText}->length()`
      )
    }
    const bufferMember = typedArrayBufferMemberText(armExprText, arm, key)
    if (bufferMember !== null) {
      const source: Representation =
        key === 'buffer' ? { kind: arm.buffer, ownership: 'shared-refcount' } : { kind: 'scalar', domain: 'number' }
      return alignedValueText(ctx, 'emit-union-properties.ts:145', source, published, bufferMember)
    }
  }
  // A block's one data property. `view.buffer` is typed `ArrayBufferLike`, so
  // `view.buffer.byteLength` reads it off an `ArrayBuffer | SharedArrayBuffer`
  // sum; the sidecar below holds no such key and would abort the read.
  if ((arm.kind === 'array-buffer' || arm.kind === 'shared-array-buffer') && key === 'byteLength') {
    return alignedValueText(
      ctx,
      'emit-union-properties.ts:block-byte-length',
      { kind: 'scalar', domain: 'number' },
      published,
      `static_cast<double>(${armExprText}->size())`
    )
  }
  if (arm.kind === 'scalar') {
    // Ordinary named properties on a primitive are read through its wrapper
    // object. This runtime has no mutable Number/Boolean prototype, so a name
    // outside Object.prototype is absent on the primitive arm. That is the
    // native answer for overload probes such as `number | Vector3` reading
    // `isVector3`: the scalar arm contributes `undefined`, while the class arm
    // contributes the declared boolean marker.
    //
    // A `dynamic` result holds that `undefined` as well as an optional does:
    // three.js's `ShaderMaterial.toJSON` reads `value.toJSON` off a uniform
    // whose arms are numbers, booleans and textures, and the member's result is
    // the open carrier because the class arms publish a method there.
    if (
      !objectPrototypeMemberNames.has(key) &&
      (published.kind === 'dynamic' || (published.kind === 'optional' && published.absence === 'undefined'))
    ) {
      return cppUndefinedIn(published)
    }
    // A canonical index on a number or boolean: no wrapper prototype holds an
    // integer key, so the language answers `undefined` -- the absence a string
    // arm's out-of-range index answers too, and spelled into a `string` result
    // exactly as that read spells it (`stringIndexText`'s `charAt`
    // convention). bson's `(name as string)[0] === '$'` over the
    // `string | number` key its array frames produce.
    if (index !== null) {
      if (published.kind === 'string') return 'std::string()'
      const absent = cppUndefinedIn(published)
      if (absent !== null) return absent
    }
  }
  if (arm.kind === 'constructor-family') {
    return classConstructorStaticMemberTextFor(ctx, arm, key, published, () => armExprText)
  }
  if (arm.kind === 'constructor-value-dispatch') return constructorValueDispatchTypedMemberText(ctx, arm, armExprText, key, published)
  if (objectPrototypeMemberNames.has(key)) return null
  // A `Record<string, any>` arm answers a named key with its own entry, or
  // `undefined` when it has none: `gea::Dictionary<gea::Value>::read`'s
  // value-initialized miss IS `undefined`. mongodb's log transform switches on
  // `logObject.name` over `LoggableEvent | Record<string, any>`.
  if (arm.kind === 'dictionary' && arm.key === 'string' && arm.value.kind === 'dynamic' && arm.ownership === 'shared-refcount')
    return alignedValueText(
      ctx,
      'emit-union-properties.ts:dictionary-arm',
      arm.value,
      published,
      `${armExprText}->read(${cppStringLiteral(key)})`
    )
  // A promise's member set is CLOSED, which is what makes absence provable
  // here rather than merely unrendered. ECMA-262 27.2.5 gives
  // `Promise.prototype` exactly `then`, `catch`, `finally` and
  // `@@toStringTag`; everything else a promise answers comes from
  // `Object.prototype`, which the line above already returned for. And this
  // runtime's `gea::Promise` is a handle to a shared promise state with
  // no dynamic-property sidecar and no way to acquire one -- unlike a class
  // instance, whose sidecar can hold a key the layout never declared -- so
  // nothing can put `callbacks` on one at runtime.
  //
  // hono's `resolveCallback` is the shape: `(str as HtmlEscapedString)
  // .callbacks` off a `string | HtmlEscapedString | Promise<string>`, where
  // the `as` names the arm the author means and the other two arms answer
  // `undefined` -- which is exactly what `!callbacks?.length` then tests. The
  // string arm already answers that way a few lines above; refusing the whole
  // union on account of the promise arm refused a read the carrier decides.
  if (arm.kind === 'promise' && !promisePrototypeMethods.has(key)) return absentArmText(published, key, 'promise')
  if (arm.kind === 'class-ref') {
    const site = classMemberOf(ctx.classes, arm.declaration, key)
    if (site !== null) {
      if (site.kind === 'unknown-class' || site.kind === 'field') return null
      // Select the method at the read, using the same allocation identity as
      // a computed class-method read. Calling later with another receiver must
      // retain this exact method, rather than redispatching through that object.
      if (classFamilyOverridesOf(ctx.classes, arm.declaration, key).length > 0) {
        if (site.kind === 'accessor') {
          const dispatch = ctx.virtualDispatch.get(virtualDispatchKey(arm.declaration, key, 'get'))
          if (dispatch === undefined) return null
          return alignedValueText(
            ctx,
            'emit-union-properties.ts:armRuntimeFieldText',
            dispatch.result,
            published,
            `${armExprText}->${cppVirtualMemberName(key, 'get')}()`
          )
        }
        if (site.kind !== 'method') return null
        // A generic method's copies share its key; each allocation's arm
        // materializes the copy this read publishes, as a lone class-ref
        // read does (`computedOverriddenMethodValueText`).
        return overriddenMethodValueText(
          ctx,
          arm,
          armExprText,
          key,
          (method) =>
            classMethodValueText(ctx, operation, key, publishedMethodCopyOf(ctx, method, key, published), published, armExprText, arm),
          published
        ).text
      }
      if (site.kind === 'accessor') {
        if (site.accessor.getter === null) return null
        const abi = ctx.abiOfCallable(site.accessor.getter)
        if (abi === null) return null
        return alignedValueText(
          ctx,
          'emit-union-properties.ts:177',
          abi.result,
          published,
          `${cppBodyName(site.accessor.getter)}(${armExprText})`
        )
      }
      const method = publishedMethodCopyOf(ctx, site.method, key, published)
      if (method.callable === null || ctx.captures.of(method.callable).kind !== 'none') return null
      const converted = classMethodValueText(ctx, operation, key, method, published, armExprText, arm).text
      // This arm materializes a class method even though the property read's
      // receiver is the whole tagged union. That receiver's SSA operand is
      // retained beside the method value so an immediate `value.method()` call
      // can narrow it back to the receiver-bearing ABI's class arm -- recorded
      // by `emit.ts`'s prepass, which asked
      // `unionClassMethodValueReceiverClaim`. A detached method crosses a
      // binding/result and therefore has a different SSA callee;
      // `emit-callable.ts` will not consult the entry for it.
      return converted
    }
    // No member anywhere on this class's chain, and the closed reflection
    // census proved no instance of it can hold the key as an own property
    // (`GetOperation.absentClassArms`): the language's answer is `undefined`.
    if (operation.absentClassArms?.includes(arm.declaration)) return absentArmText(published, key, 'class')
  }
  const accessors =
    arm.kind === 'record' ? arm.accessors : arm.kind === 'native-record-ref' ? recordAccessorsOfShape(ctx.deriver, arm.shapeId) : null
  if (accessors?.some((accessor) => accessor.key === key)) return null
  // A tuple arm's `length` is its arity, exactly as on a bare tuple receiver
  // (`emit-properties.ts`); the sidecar below holds no such key and aborts.
  // mongodb's `isPair` reads it off `ReadonlyArray<string> | readonly [string, SortDirection]`.
  const arity = arm.kind === 'record' && key === 'length' ? positionalRecordArityText(arm, () => armExprText) : null
  if (arity !== null)
    return alignedValueText(ctx, 'emit-union-properties.ts:tuple-arity', { kind: 'scalar', domain: 'number' }, published, arity)
  if (sidecarArm(arm) && !nativePrototypeAnswers(arm, key)) {
    return alignedValueText(ctx, 'emit-union-properties.ts:201', boxed, published, `gea::nativeDynamicGet(${armExprText}, ${propertyKey})`)
  }
  return null
}

/** The live arm's own value, and the discriminant that says it is live -- shared with `emit-in.ts`'s per-arm `k in u` dispatch, the one other file that needs to name an arm without owning this file's field/element machinery. */
export const armAt = (receiverText: string, index: number): string => `${receiverText}.get<${index}>()`
export const armIs = (receiverText: string, index: number): string => `${receiverText}.is<${index}>()`

export interface UnionPropertyLeaf {
  readonly representation: Representation
  readonly text: string
  readonly test: string
}

export const unionPropertyLeaves = (representation: Representation, text: string, test: string = 'true'): readonly UnionPropertyLeaf[] => {
  if (representation.kind === 'tagged-union') {
    return representation.arms.flatMap((arm, index) => {
      const nestedText = armAt(text, index)
      const nestedTest = test === 'true' ? armIs(text, index) : `${test} && ${armIs(text, index)}`
      return unionPropertyLeaves(arm.value, nestedText, nestedTest)
    })
  }
  if (representation.kind === 'optional') {
    const presentTest = test === 'true' ? `${text}.has_value()` : `${test} && ${text}.has_value()`
    const absentTest = test === 'true' ? `!${text}.has_value()` : `${test} && !${text}.has_value()`
    return [
      ...unionPropertyLeaves(representation.payload, `(*${text})`, presentTest),
      { representation: { kind: representation.absence }, text, test: absentTest }
    ]
  }
  return [{ representation, text, test }]
}

export const dispatchedLeafExpression = (leaves: readonly UnionPropertyLeaf[], expressions: readonly string[]): string | null => {
  const last = expressions[expressions.length - 1]
  if (last === undefined) return null
  let dispatched = last
  for (let index = expressions.length - 2; index >= 0; index -= 1) {
    const leaf = leaves[index]
    const expression = expressions[index]
    if (leaf === undefined || expression === undefined) return null
    dispatched = `${leaf.test} ? ${expression} : (${dispatched})`
  }
  return expressions.length > 1 ? `(${dispatched})` : dispatched
}

/** Dispatch a numeric key through each alternative's native storage. */
const nativeNumericUnionAccess = (
  ctx: EmitContext,
  operation: GetOperation | SetOperation | DefineOwnPropertyOperation
): readonly string[] | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union' || !hasNativeNumericIndexArms(receiver, ctx.deriver.derive)) return null
  // Whether the key IS a canonical-index literal is a claim, not a spelling:
  // it picks the literal-index dispatch over the runtime-key one below. Ask
  // the pre-render map so a `typeof`-fold `constantTexts` also accumulates at
  // render time can never be mistaken for an index the program actually wrote.
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  const literalIndex = staticKey === undefined ? null : canonicalIndexLiteral(staticKey)
  if (literalIndex === null && (operation.key.representation.kind !== 'scalar' || operation.key.representation.domain !== 'number'))
    return null
  const receiverText = operandText(ctx, operation.receiver)
  const key = literalIndex ?? operandText(ctx, operation.key)
  return receiver.arms.map((arm, index) => {
    if (arm.value.kind === 'null' || arm.value.kind === 'undefined') {
      const type = operation.kind === 'get' ? cppTypeOf(operation.result.representation) : 'void'
      const action = operation.kind === 'get' ? 'read' : 'set'
      const expression = `gea::host::throwGetPropertyOfNullish<${type}>("${arm.value.kind}", "${action}")`
      return operation.kind === 'get' ? expression : `${expression};`
    }
    const storage = nativeNumericIndexOf(arm.value, ctx.deriver.derive)
    if (!storage) {
      throw createCppEmitBlockedError(
        `property-access:tagged-union(numeric-index-arms):${operation.kind}:true`,
        'a numeric index alternative lost its native storage'
      )
    }
    const at = armAt(receiverText, index)
    const member =
      storage.kind === 'record-index'
        ? `${at}${memberAccessOperator(storage.ownership)}${cppRecordIndexSidecarName}.`
        : `${at}${memberAccessOperator(storage.ownership)}`
    if (operation.kind === 'get') {
      return storage.kind === 'elements'
        ? arrayArmReadText(at, 'elementAt', key, storage.value, operation.result.representation)
        : dictionaryArmReadText(member, key, storage.value, operation.result.representation)
    }
    const written = alignedValueText(
      ctx,
      'emit-union-properties.ts:280',
      operation.value.representation,
      storage.value,
      operandText(ctx, operation.value)
    )
    if (written === null) {
      throw createCppEmitBlockedError(
        `property-access:tagged-union(numeric-index-arms):${operation.kind}:true`,
        "a numeric index write has no conversion into an alternative's element"
      )
    }
    if (storage.kind === 'elements') return `${at}->setElement(${key}, ${written});`
    // An `any` Document may view another object (`gea::dictionary::aliasOf`)
    // and then owns no slot `operator[]` could hand out; `setProperty` is the
    // ordinary [[Set]] either way.
    return storage.value.kind === 'dynamic' ? `${member}setProperty(${key}, ${written});` : `${member}operator[](${key}) = ${written};`
  })
}

const nativeNumericUnionGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const arms = nativeNumericUnionAccess(ctx, operation)
  if (!arms) return null
  const receiver = operandText(ctx, operation.receiver)
  return arms.reduceRight<string>((rest, text, index) => (rest ? `(${armIs(receiver, index)} ? ${text} : ${rest})` : text), '')
}

const emitNativeNumericUnionSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const arms = nativeNumericUnionAccess(ctx, operation)
  if (!arms) return false
  const receiver = operandText(ctx, operation.receiver)
  lines.push(
    arms.map((text, index) => (index === arms.length - 1 ? `{ ${text} }` : `if (${armIs(receiver, index)}) { ${text} } else `)).join('')
  )
  if (operation.result) defineValueAlias(ctx, operation.result, receiver)
  return true
}

/**
 * Whether every arm of this union is a typed array -- the one shape for which
 * a COMPUTED key needs no reconciliation between arms.
 *
 * `TypedArray` is a union of nine views (`@types/three` states it, and so does
 * every other package that names the family), and the arms differ only in
 * element WIDTH: `canonicalMembersOf` keeps all nine because `int8` and
 * `float32` really are different carriers. But `TypedArray::elementAt`
 * returns `double` for all eight domains whatever the view holds, so a
 * per-arm dispatch of `view[ i ]` produces the identical C++ type on every
 * arm and there is nothing to widen, narrow or reconcile.
 *
 * That is exactly the reconciliation `manifest/capabilities.ts` cites as the
 * reason the flat `tagged-union:get:true` claim is withheld -- "a per-arm
 * dispatch of a runtime-only key would additionally have to reconcile
 * `array-object`/`dictionary`-shaped arms". A union with no such arm does not
 * owe that, so it is claimed under its own refined key rather than by
 * widening the general one.
 */
export const taggedUnionHasOnlyTypedArrayArms = (representation: Representation): boolean => typedArrayUnionOnly(representation)

/**
 * Reading a COMPUTED key off a tagged union whose every arm is a typed array,
 * or `null` when this is not that case.
 *
 * The same nested-ternary dispatch `taggedUnionGetText` builds for a static
 * key, over `elementAt` instead of a field name. `absentCapableNumericElement\
 * Text` is asked per arm for the same reason it is asked for a lone typed
 * array: under `noUncheckedIndexedAccess` the checker types `view[ i ]` as
 * `number | undefined`, and the bare reader aborts on an index the language
 * answers with `undefined`.
 */
const taggedUnionElementText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (!taggedUnionHasOnlyTypedArrayArms(receiver) || receiver.kind !== 'tagged-union') return null
  // This function only ever handles a COMPUTED key -- a static one is the
  // general union-get's job. Asking the pre-render map keeps a render-time
  // `typeof`-fold text from being mistaken for a key the program wrote as
  // static, which would wrongly bail this computed-key path.
  if (ctx.staticKeyTexts.get(operation.key.value) !== undefined) return null
  if (operation.key.representation.kind !== 'scalar') return null
  const receiverText = operandText(ctx, operation.receiver)
  const keyText = operandText(ctx, operation.key)
  const armTexts = receiver.arms.map((_arm, index) => {
    const armText = armAt(receiverText, index)
    return absentCapableNumericElementText(armText, keyText, operation.result) ?? `${armText}->elementAt(${keyText})`
  })
  const dispatched = armTexts.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiverText, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) return null
  return armTexts.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * Writing a COMPUTED key onto a tagged union whose every arm is a typed
 * array. The statement form of `taggedUnionElementText`, dispatched the way
 * `emitTaggedUnionSet` dispatches a static key.
 *
 * `setElement` takes the `double` every view stores through, so the value is
 * converted once against the published `scalar` rather than per arm -- the
 * arms differ in what they hold, never in what they accept.
 */
const emitTaggedUnionElementSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const receiver = operation.receiver.representation
  if (!taggedUnionHasOnlyTypedArrayArms(receiver) || receiver.kind !== 'tagged-union') return false
  // Same computed-key-only claim as `taggedUnionElementText`'s mirror check --
  // the pre-render map, so a render-time-folded text cannot pass for a static
  // key here either.
  if (ctx.staticKeyTexts.get(operation.key.value) !== undefined) return false
  if (operation.key.representation.kind !== 'scalar') return false
  const receiverText = operandText(ctx, operation.receiver)
  const keyText = operandText(ctx, operation.key)
  const valueText = operandText(ctx, operation.value)
  const statements = receiver.arms.map((_arm, index) => `${armAt(receiverText, index)}->setElement(${keyText}, ${valueText});`)
  let chain = ''
  statements.forEach((statement, index) => {
    if (statements.length === 1) chain = statement
    else if (index === 0) chain = `if (${armIs(receiverText, 0)}) { ${statement} }`
    else if (index === statements.length - 1) chain += ` else { ${statement} }`
    else chain += ` else if (${armIs(receiverText, index)}) { ${statement} }`
  })
  lines.push(chain)
  if (operation.result) defineValueAlias(ctx, operation.result, receiverText)
  return true
}

/**
 * Whether every arm of a `tagged-union` receiver is a `dictionary` -- the one
 * other shape (besides "every arm a typed array") a COMPUTED key owes no
 * ARM-KIND reconciliation for. Every `dictionary` renders through the
 * identical `member.read(key)`/`member.has(key)` pair regardless of its
 * value type, so the only reconciliation left is the ordinary per-arm VALUE
 * one `taggedUnionGetText`'s static-key dispatch already performs -- here
 * done with `widenedStoreText` instead of `narrowedLoadText`, because a
 * dictionary's `value` is the concrete type actually stored and the read's
 * published carrier is typically the WIDER union of the arms' value types
 * (`Record<string, number> | Record<string, string>` reads as `number |
 * string`), which is a widen, not a narrow.
 */
export const taggedUnionHasOnlyDictionaryArms = (representation: Representation): boolean =>
  representation.kind === 'tagged-union' && representation.arms.every((arm) => arm.value.kind === 'dictionary')

/**
 * One dictionary arm's own read, reconciled to what the whole union's `get`
 * publishes.
 *
 * Mirrors `dictionaryReadText` (`emit-properties.ts`) exactly -- a bare
 * `read(key)` where the published carrier is not `optional`, and a
 * `has(key) ? V(read(key)) : V()` where it is, because the language answers
 * `undefined` for an absent key only where the program was compiled to say
 * so. The one addition is the reconciliation step: where this arm's OWN
 * value carrier differs from what the whole read publishes, `widenedStoreText`
 * wraps it into the published union's own arm the same way an ordinary store
 * would (`ofArm<index>`), and a value that cannot be so reconciled refuses by
 * name -- the identical fail-closed posture `taggedUnionGetText`'s own arm
 * loop already takes for a static key, asked here of a VALUE mismatch
 * instead of a FIELD one.
 */
const dictionaryArmReadText = (
  member: string,
  keyText: string,
  dictionaryValue: Representation,
  published: Representation,
  armFamily: string = 'dictionary-arms'
): string => {
  const rawRead = `${member}read(${keyText})`
  if (published.kind !== 'optional') {
    if (representationKey(dictionaryValue) === representationKey(published)) return rawRead
    const widened = widenedStoreText(published, dictionaryValue, rawRead)
    if (widened !== null) return widened
    throw createCppEmitBlockedError(
      `property-access:tagged-union(${armFamily}):get:true`,
      `a computed "get" on a dictionary-armed tagged union reaches an arm whose value is stored as ` +
        `"${representationKey(dictionaryValue)}" and this read publishes "${representationKey(published)}"; no widening between those is licensed`
    )
  }
  const presentText =
    representationKey(dictionaryValue) === representationKey(published.payload)
      ? rawRead
      : widenedStoreText(published.payload, dictionaryValue, rawRead)
  if (presentText === null) {
    throw createCppEmitBlockedError(
      `property-access:tagged-union(${armFamily}):get:true`,
      `a computed "get" on a dictionary-armed tagged union reaches an arm whose value is stored as ` +
        `"${representationKey(dictionaryValue)}" and this read publishes "optional(${representationKey(published.payload)})"; ` +
        'no widening between those is licensed'
    )
  }
  const carrier = cppTypeOf(published)
  return `(${member}has(${keyText}) ? ${carrier}(${presentText}) : ${carrier}())`
}

/**
 * Reading a COMPUTED key off a tagged union whose every arm is a
 * `dictionary` -- the dictionary-arms mirror of `taggedUnionElementText`
 * above, over `dictionaryArmReadText` instead of `elementAt`. This is the
 * exact shape `manifest/capabilities.ts`'s withheld `tagged-union:get:true`
 * comment names as needing "reconciliation" and declines to build blind --
 * hono's own `Record<string, string> | Record<string, string[]>` (a
 * `multiple`/single-value query-string result) and `ParamIndexMap |
 * Params` (`Record<string, number> | Record<string, string>`, a route's
 * resolved-vs-unresolved parameter table) are both this, and nothing else in
 * the corpus needed the `array-object`-armed case the withheld comment also
 * names, so that half stays unbuilt rather than guessed at.
 */
const taggedUnionDictionaryGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (!taggedUnionHasOnlyDictionaryArms(receiver) || receiver.kind !== 'tagged-union') return null
  // Computed-key-only claim, same as `taggedUnionElementText` above: the
  // pre-render map, so a render-time-folded text is never mistaken for a
  // static key and does not wrongly bail this dictionary-arms path.
  if (ctx.staticKeyTexts.get(operation.key.value) !== undefined) return null
  const receiverText = operandText(ctx, operation.receiver)
  const published = operation.result.representation
  const armTexts = receiver.arms.map((arm, index) => {
    const dictionary = arm.value
    if (dictionary.kind !== 'dictionary') {
      // Unreachable given `taggedUnionHasOnlyDictionaryArms` above; kept so
      // the map body stays narrowed to the dictionary variant without a cast.
      throw createCppEmitBlockedError(
        'property-access:tagged-union(dictionary-arms):get:true',
        'a dictionary-arms union reached a non-dictionary arm'
      )
    }
    const armText = armAt(receiverText, index)
    const member = `${armText}${memberAccessOperator(dictionary.ownership)}`
    const keyText = keyedTableKeyText(ctx, operation.key, dictionaryKeyDomainOf(dictionary.key, operation.key.representation))
    return dictionaryArmReadText(member, keyText, dictionary.value, published)
  })
  const dispatched = armTexts.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiverText, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) return null
  return armTexts.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * Whether every arm of a `tagged-union` receiver is an `array-object` -- the
 * third shape (besides "every arm a typed array" and "every arm a
 * dictionary") a COMPUTED key owes no ARM-KIND reconciliation for. Every
 * `array-object` renders through the identical `elementAt`/`hasElement` pair
 * (`emit-carrier-members.ts`'s `arrayAccessText`) regardless of what its OWN
 * element type is, so the only reconciliation left is the ordinary per-arm
 * VALUE one -- widening each arm's own element into the published union the
 * same way `dictionaryArmReadText` widens a dictionary arm's value.
 * `[T, ParamIndexMap][] | [T, Params][]` (hono's own router match result,
 * `Result<T>`'s first slot -- two element arrays differing only in their
 * element's second tuple slot) is exactly this.
 */
export const taggedUnionHasOnlyArrayObjectArms = (representation: Representation): boolean =>
  representation.kind === 'tagged-union' && representation.arms.every((arm) => arm.value.kind === 'array-object')

/**
 * The exact native-sidecar predicate preflight claims for a runtime key on a
 * tagged union.  Each admitted native arm has a stable shared identity, so
 * `nativeDynamicGet` can first consult its generated field/index dispatcher
 * and then its expando sidecar.  A by-value record cannot enter: making a
 * sidecar for it would key mutable JS state on a transient C++ copy.
 */
const nativeSidecarUnionLeaf = (representation: Representation): boolean => {
  if (representation.kind === 'dynamic' || representation.kind === 'null' || representation.kind === 'undefined') return true
  if (representation.kind === 'native-record-ref' && representation.native !== null) return false
  return (
    (representation.kind === 'record' ||
      representation.kind === 'record-with-index' ||
      representation.kind === 'native-record-ref' ||
      representation.kind === 'class-ref') &&
    representation.ownership === 'shared-refcount'
  )
}

/**
 * Dispatch a computed [[Get]] through every arm's existing ordinary-property
 * implementation.  This is not a boxed receiver path: each native arm stays
 * in its selected carrier and only the dynamic property result crosses the
 * sidecar boundary before its checked decode.
 */
const taggedUnionNativeSidecarGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  // Computed-key-only claim, same as `taggedUnionElementText` above: the
  // pre-render map, so a render-time-folded text is never mistaken for a
  // static key and does not wrongly bail this native-sidecar path.
  if (receiver.kind !== 'tagged-union' || ctx.staticKeyTexts.has(operation.key.value)) return null
  const leaves = unionPropertyLeaves(receiver, operandText(ctx, operation.receiver))
  if (!leaves.every((leaf) => nativeSidecarUnionLeaf(leaf.representation))) return null
  const site = 'a computed "get" on a native-sidecar tagged union'
  const key = propertyKeyText(ctx, operation.key, site)
  const published = operation.result.representation
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const texts = leaves.map((leaf): string => {
    if (leaf.representation.kind === 'null' || leaf.representation.kind === 'undefined') {
      return `gea::host::throwGetPropertyOfNullish<${cppTypeOf(published)}>("${leaf.representation.kind}")`
    }
    const read = leaf.representation.kind === 'dynamic' ? `${leaf.text}.getProperty(${key})` : `gea::nativeDynamicGet(${leaf.text}, ${key})`
    const decoded = alignedValueText(ctx, 'emit-union-properties.ts:541', boxed, published, read)
    if (decoded !== null) return decoded
    throw createCppEmitBlockedError(
      'property-access:tagged-union(native-sidecar-arms):get:true',
      `a computed native-sidecar read publishes "${representationKey(published)}", which has no checked dynamic decode`
    )
  })
  return dispatchedLeafExpression(leaves, texts)
}

/**
 * A computed [[Get]] over dictionaries mixed with native-sidecar arms: each
 * dictionary leaf reads its own table exactly as `taggedUnionDictionaryGetText`
 * reads one, each other leaf exactly as `taggedUnionNativeSidecarGetText`
 * reads one. Certified under `tagged-union(dictionary-or-sidecar-arms)`
 * (`ir/certify/property-access-keys.ts`'s
 * `taggedUnionArmsAreDictionariesOrNativeSidecar`, which this leaf test
 * mirrors).
 */
const taggedUnionDictionaryOrSidecarGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union' || ctx.staticKeyTexts.has(operation.key.value)) return null
  const leaves = unionPropertyLeaves(receiver, operandText(ctx, operation.receiver))
  const admitted = (leaf: Representation): boolean =>
    (leaf.kind === 'dictionary' && leaf.ownership === 'shared-refcount') || nativeSidecarUnionLeaf(leaf)
  if (!leaves.some((leaf) => leaf.representation.kind === 'dictionary') || !leaves.every((leaf) => admitted(leaf.representation)))
    return null
  const published = operation.result.representation
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const texts = leaves.map((leaf): string => {
    const value = leaf.representation
    if (value.kind === 'dictionary') {
      const member = `${leaf.text}${memberAccessOperator(value.ownership)}`
      const keyText = keyedTableKeyText(ctx, operation.key, dictionaryKeyDomainOf(value.key, operation.key.representation))
      return dictionaryArmReadText(member, keyText, value.value, published, 'dictionary-or-sidecar-arms')
    }
    if (value.kind === 'null' || value.kind === 'undefined') {
      return `gea::host::throwGetPropertyOfNullish<${cppTypeOf(published)}>("${value.kind}")`
    }
    const key = propertyKeyText(ctx, operation.key, 'a computed "get" on a dictionary-or-sidecar tagged union')
    const read = value.kind === 'dynamic' ? `${leaf.text}.getProperty(${key})` : `gea::nativeDynamicGet(${leaf.text}, ${key})`
    const decoded = alignedValueText(ctx, 'emit-union-properties.ts:dictionary-or-sidecar', boxed, published, read)
    if (decoded !== null) return decoded
    throw createCppEmitBlockedError(
      'property-access:tagged-union(dictionary-or-sidecar-arms):get:true',
      `a computed read publishes "${representationKey(published)}", which has no checked dynamic decode`
    )
  })
  return dispatchedLeafExpression(leaves, texts)
}

/**
 * One array arm's own indexed read, reconciled to what the whole union's
 * `get` publishes -- the array-arms mirror of `dictionaryArmReadText`, over
 * `elementAt`/`hasElement` (or the narrowed-integer `elementAtIndex`/
 * `hasElementAtIndex` pair) instead of `read`/`has`. `widenedStoreText`
 * performs the identical per-arm VALUE reconciliation `dictionaryArmReadText`
 * asks of a dictionary's value: wrap this arm's own element type into the
 * published union's matching arm (`ofArm<index>`), or refuse by name when no
 * arm of the published carrier matches.
 */
const arrayArmReadText = (
  armText: string,
  reader: 'elementAt' | 'elementAtIndex',
  keyText: string,
  element: Representation,
  published: Representation
): string => {
  const rawRead = `${armText}->${reader}(${keyText})`
  // `gea::Value` carries the exact `undefined` an absent Array element
  // produces. Even though the present element and published result have the
  // same carrier, the fallible runtime reader cannot produce that absence: it
  // aborts. Guard only the exact dynamic/dynamic pair, leaving typed arms on
  // their existing carrier reconciliation path.
  if (element.kind === 'dynamic' && published.kind === 'dynamic') {
    const has = reader === 'elementAtIndex' ? 'hasElementAtIndex' : 'hasElement'
    return `(${armText}->${has}(${keyText}) ? ${rawRead} : gea::Value())`
  }
  if (published.kind !== 'optional') {
    if (representationKey(element) === representationKey(published)) return rawRead
    const widened = widenedStoreText(published, element, rawRead)
    if (widened !== null) return widened
    throw createCppEmitBlockedError(
      'property-access:tagged-union(array-arms):get:true',
      `a computed "get" on an array-armed tagged union reaches an arm whose element is stored as ` +
        `"${representationKey(element)}" and this read publishes "${representationKey(published)}"; no widening between those is licensed`
    )
  }
  const presentText =
    representationKey(element) === representationKey(published.payload) ? rawRead : widenedStoreText(published.payload, element, rawRead)
  const has = reader === 'elementAtIndex' ? 'hasElementAtIndex' : 'hasElement'
  const carrier = cppTypeOf(published)
  // An arm whose element no arm of the published read holds is a tuple the
  // read indexes past: hono's router `Result` is `[[H, Params][]] |
  // [[H, ParamIndexMap][], ParamStash]`, and `result[1]` is `ParamStash |
  // undefined` only because the checker knows the first tuple's length. The
  // carrier does not, so the arm answers the absence the read publishes and
  // refuses a present element at run time (`absentTupleElement`) -- a
  // TypeError, never the element's bytes as a `ParamStash`.
  if (presentText === null) return `gea::host::absentTupleElement<${carrier}>(${armText}->${has}(${keyText}))`
  return `(${armText}->${has}(${keyText}) ? ${carrier}(${presentText}) : ${carrier}())`
}

/**
 * Reading a COMPUTED key off a tagged union whose every arm is an
 * `array-object` -- the array-arms mirror of `taggedUnionDictionaryGetText`.
 * `key.representation.kind !== 'scalar'` refuses the same `ToPropertyKey`
 * gap `arrayAccessText` itself refuses for a lone array, and the reader is
 * `elementAtIndex` wherever the integer census narrowed the key the same way
 * `arrayAccessText` picks it, so a narrowed index costs no double round trip
 * on a union receiver either.
 */
const taggedUnionArrayGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (!taggedUnionHasOnlyArrayObjectArms(receiver) || receiver.kind !== 'tagged-union') return null
  // Computed-key-only claim, same as `taggedUnionElementText` above: the
  // pre-render map, so a render-time-folded text is never mistaken for a
  // static key and does not wrongly bail this array-arms path.
  if (ctx.staticKeyTexts.get(operation.key.value) !== undefined) return null
  if (operation.key.representation.kind !== 'scalar') return null
  const receiverText = operandText(ctx, operation.receiver)
  const keyText = operandText(ctx, operation.key)
  const reader = ctx.integerValues.has(operation.key.value) ? 'elementAtIndex' : 'elementAt'
  const published = operation.result.representation
  const armTexts = receiver.arms.map((arm, index) => {
    const array = arm.value
    if (array.kind !== 'array-object') {
      // Unreachable given `taggedUnionHasOnlyArrayObjectArms` above; kept so
      // the map body stays narrowed to the array-object variant without a
      // cast.
      throw createCppEmitBlockedError('property-access:tagged-union(array-arms):get:true', 'an array-arms union reached a non-array arm')
    }
    const armText = armAt(receiverText, index)
    return arrayArmReadText(armText, reader, keyText, array.element, published)
  })
  const dispatched = armTexts.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiverText, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) return null
  return armTexts.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * A class arm that declares no member at `key` anywhere up its chain, whose
 * native base -- the collection or promise its struct derives from in place --
 * renders `key` from its intrinsic prototype. The arm is read as that base
 * through the census's own native-base view node, exactly as a lone receiver
 * of the class is (`SemanticOperand.nativeBaseView`); the call then renders
 * the base's member.
 *
 * Declined where any class below this one redeclares the key: the object may
 * be that subclass, whose own body answers instead of the native member.
 */
const nativeBaseMethodArmOf = (
  ctx: EmitContext,
  arm: Extract<Representation, { kind: 'class-ref' }>,
  key: string
): readonly UnionMethodArm[] | null => {
  const native = arm.nativeBase
  if (native === undefined) return null
  const renders =
    native.kind === 'keyed-collection'
      ? keyedCollectionPrototypeMethods(native.family).has(key)
      : native.kind === 'promise' && promisePrototypeMethods.has(key)
  if (!renders) return null
  if (classFamilyOverridesOf(ctx.classes, arm.declaration, key).length > 0) return null
  if (ctx.conversions.nativeBaseViewFor(arm, native) === null) return null
  return [{ path: [], receiverRepresentation: arm, callable: null, nativeBase: { carrier: native, member: key } }]
}

const deferredUnionMethodArmsOf = (ctx: EmitContext, representation: Representation, key: string): readonly UnionMethodArm[] | null => {
  if (representation.kind === 'tagged-union') {
    const nested: UnionMethodArm[] = []
    for (const [index, arm] of representation.arms.entries()) {
      const armArms = deferredUnionMethodArmsOf(ctx, arm.value, key)
      if (armArms === null) return null
      nested.push(...armArms.map((entry) => ({ ...entry, path: [index, ...entry.path] })))
    }
    return nested
  }
  // A primitive's `valueOf` is its own `%X%.prototype.valueOf`: the primitive.
  // No program can replace it on a primitive (the wrapper prototypes are the
  // runtime's, and a primitive has no own properties), so it is as fixed a
  // body as a class method's.
  if (key === 'valueOf' && (representation.kind === 'string' || (representation.kind === 'scalar' && representation.domain !== 'bigint')))
    return [{ path: [], receiverRepresentation: representation, callable: null }]
  // A STATIC method through one arm's class constructor -- bson's EJSON
  // `keysToCodecs[k].fromExtendedJSON(value, options)` over a table of codec
  // classes whose statics each declare their own parameters. Joining those into
  // one function value made TypeScript's union-call parameter (the
  // INTERSECTION of every arm's document type) the conversion target of the
  // argument, which no single document satisfies; calling the selected arm's
  // own body converts the argument to what that body declares.
  //
  // One class per arm, and only a method no own property of the constructor
  // can have replaced: a censused static storage or a constructor-view field
  // of this key is where such a write lands (`classConstructorStaticMemberTextFor`
  // reads those first, for the same reason).
  if (representation.kind === 'constructor-family') {
    const [member, ...others] = representation.members
    if (member === undefined || others.length !== 0) return null
    if (constructorViewFieldFor(ctx, key) !== null || classConstructorStaticFieldStorage(ctx, representation, key) !== null) return null
    const site = classStaticMemberOf(ctx.classes, member, key)
    if (site === null || site.kind !== 'method' || site.method.callable === null) return null
    if (ctx.captures.of(site.method.callable).kind !== 'none' || ctx.abiOfCallable(site.method.callable) === null) return null
    return [{ path: [], receiverRepresentation: representation, callable: site.method.callable }]
  }
  if (representation.kind === 'null' || representation.kind === 'undefined')
    return [{ path: [], receiverRepresentation: representation, callable: null, nullish: representation.kind }]
  if (representation.kind !== 'class-ref') return null
  const site = classMemberOf(ctx.classes, representation.declaration, key)
  if (site === null) return nativeBaseMethodArmOf(ctx, representation, key)
  if (site.kind !== 'method' || site.method.callable === null) return null
  // An own property written over the method (`this.match = ...`, which hono's
  // SmartRouter does to memoise its choice) shadows the prototype for every
  // later read. Calling the declared body straight from the union tag would
  // answer with the body the assignment replaced. The lone-class twins of this
  // claim already decline on the same question; this one did not, and the
  // program compiled to the wrong answer rather than refusing.
  if (classMethodOverrideOf(ctx.classes, representation.declaration, key) !== null) return null
  if (classFamilyOverridesOf(ctx.classes, representation.declaration, key).length > 0) return null
  if (ctx.captures.of(site.method.callable).kind !== 'none' || ctx.abiOfCallable(site.method.callable) === null) return null
  return [{ path: [], receiverRepresentation: representation, callable: site.method.callable }]
}

/**
 * Whether a member read through a tagged union is a deferred method read whose
 * every arm names a concrete body, and which bodies those are.
 *
 * The read itself has no single callable ABI -- each arm keeps its own
 * receiver and covariant result -- so the following call dispatches by union
 * tag. What travels is the arm PATH and the body, never a spelled receiver:
 * `emit-callable.ts` folds `armAt`/`armIs` down the path from the union's own
 * operand at the call, which is the first point where that operand has a name.
 *
 * Stated once; `taggedUnionGetText` and the prepass walk both ask it.
 */
/**
 * `x.toString()` where `x` is a tagged union -- hono's own `input =
 * input.toString()` over `string | URL`.
 *
 * This is the EXPLICIT spelling of the operation `${x}` already renders for
 * the same carrier, so it is answered by the same table (`toStringTextOver`),
 * which descends per arm: a string arm is itself (22.1.3.29 returns the
 * primitive), a class arm with its own `toString` calls that method, a class
 * without one is the "[object Object]" tag. Routing it through the per-arm
 * FIELD walk instead is what refused it -- there is no field named "toString"
 * on a string.
 *
 * Fail-closed in two ways, both because `x.toString()` is NOT ToString(x):
 *
 *  - a nullish arm answers `null`/`undefined` to ToString and throws a
 *    TypeError to `.toString()`, so any arm that can be absent declines the
 *    whole claim rather than printing the text "null";
 *  - `explicit` stays false, which is what keeps a symbol arm refusing:
 *    `String(sym)` is legal and `sym.toString()`'s own 20.4.3.3 is not the
 *    same function this table would render for it.
 *
 * A union `toStringTextOver` cannot render at all declines here too, so the
 * arm that has no ToString keeps its own named refusal from the field walk.
 */
export const deferredUnionToStringClaim = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): PrototypeMethodRead | null => {
  const carrier = receiver.representation
  if (carrier.kind !== 'tagged-union') return null
  if (ctx.staticKeyTexts.get(key.value) !== 'toString') return null
  for (const arm of carrier.arms) {
    if (arm.value.kind === 'null' || arm.value.kind === 'undefined' || arm.value.kind === 'optional') return null
  }
  if (toStringTextOver('gea_receiver', carrier, toStringLayoutsOf(ctx)) === null) return null
  return { receiverKind: 'union-to-string', member: 'toString', receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

/**
 * The ToString table for a union's `toString`, able to call an overridden
 * method through its family's virtual member: the claim and the call text ask
 * the same one, so they cannot disagree. `String(x)` asks it too
 * (`renderToString`), since 7.1.1.1 looks the method up on the allocated
 * object whichever spelling reached the ToString.
 */
export const toStringLayoutsOf = (ctx: EmitContext): ToStringLayouts => ({
  ...recordLayoutPolicyOf(ctx.deriver, ctx.classes),
  virtualMethodCallFor: (declaration, key) => {
    const abi = ctx.virtualDispatch.get(virtualDispatchKey(declaration, key, 'call'))
    // ToPrimitive calls it with no arguments (7.1.1.1 step 5.b.i), so every
    // declared parameter must be able to hold the `undefined` it binds.
    const takesUndefined = (value: Representation): boolean =>
      value.kind === 'undefined' || value.kind === 'dynamic' || (value.kind === 'optional' && value.absence === 'undefined')
    if (abi === undefined || abi.restFrom !== null || !abi.parameters.every((parameter) => takesUndefined(parameter.value))) return null
    const absent = abi.parameters.map((parameter) => `${cppTypeOf(parameter.value)}{}`).join(', ')
    return { call: (receiver) => `${receiver}->${cppVirtualMemberName(key)}(${absent})`, result: abi.result }
  }
})

/** The call half of `deferredUnionToStringClaim`, fused with the read above. */
export const unionToStringCallText = (ctx: EmitContext, carrier: Representation, receiverText: string): string => {
  const text = toStringTextOver(receiverText, carrier, toStringLayoutsOf(ctx))
  if (text === null) {
    throw createCppEmitBlockedError(
      'property-access:tagged-union:get:false',
      `a union "toString" was claimed for "${representationKey(carrier)}" and its ToString table then declined it`
    )
  }
  return text
}

export const deferredUnionMethodClaim = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): UnionMethodRead | null => {
  if (receiver.representation.kind !== 'tagged-union') return null
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) return null
  const arms = deferredUnionMethodArmsOf(ctx, receiver.representation, staticKey)
  // All-primitive unions are the prototype-read walk's (`mixedUnionClaimOf`);
  // this claim is for unions with at least one class body to call.
  if (arms === null || arms.every((arm) => arm.callable === null && arm.nativeBase === undefined)) return null
  // A nullish arm joins the claim only beside a native-base arm. Every other
  // union with one keeps the per-arm value walk it always had (a class method
  // value per arm, `throwGetPropertyOfNullish` for the absent one); a native
  // base's member has no value recipe there, so without the claim it refused.
  if (arms.some((arm) => arm.nullish !== undefined) && !arms.some((arm) => arm.nativeBase !== undefined)) return null
  return { receiver, arms }
}

/**
 * Reading a STATIC key off a tagged-union receiver, or `null` when this is not
 * that case (a different receiver kind, or a computed key this file declines).
 *
 * Every arm is resolved and, where its declared field carrier differs from
 * what this GET publishes, reconciled through `convertedValueText` -- the
 * general reconciliation `emit-bindings.ts`'s own store and `emit-return.ts`'s
 * own ABI result already ask, needed here in both directions an arm can
 * disagree with the union's own published read: narrower (an arm's field is
 * one union the published read narrows further) and wider (an arm's field is
 * a plain value the published read still states as the whole tuple-union,
 * `request.ts`'s own `Result<T>`). An arm that resolves to nothing, or whose
 * field cannot be reconciled to the published carrier by any means including
 * a dynamic boundary (`armDynamicFieldText`), refuses the WHOLE union by
 * name: a dispatch that silently dropped one arm's read would be a wrong
 * answer for
 * every value that happened to be that arm, which is worse than refusing to
 * compile.
 */
export const taggedUnionGetText = (ctx: EmitContext, lines: string[], operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union') return null
  const numeric = nativeNumericUnionGetText(ctx, operation)
  if (numeric !== null) return numeric
  const element = taggedUnionElementText(ctx, operation)
  if (element !== null) return element
  const arrayElement = taggedUnionArrayGetText(ctx, operation)
  if (arrayElement !== null) return arrayElement
  const dictionaryElement = taggedUnionDictionaryGetText(ctx, operation)
  if (dictionaryElement !== null) return dictionaryElement
  const nativeSidecar = taggedUnionNativeSidecarGetText(ctx, operation)
  if (nativeSidecar !== null) return nativeSidecar
  const dictionaryOrSidecar = taggedUnionDictionaryOrSidecarGetText(ctx, operation)
  if (dictionaryOrSidecar !== null) return dictionaryOrSidecar
  // The STATIC-key dispatch below decides which per-arm field/method site
  // answers this read; that decision must come from the pre-render map, never
  // from `constantTexts`'s render-time `typeof`-fold accretion, or a computed
  // key the earlier computed-key claims above correctly declined would be
  // treated as naming a field here instead.
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return null
  const receiverText = operandText(ctx, operation.receiver)
  const published = operation.result.representation
  // `String | Function` is one value with two exact `toString` algorithms:
  // String.prototype.toString returns the primitive itself, while
  // Function.prototype.toString returns the callable's registered source.
  // A `Function` arm is deliberately carried as `dynamic(untyped-callable)`
  // because it promises callability without stating an ABI. Its Value retains
  // the call table selected before payload erasure, and that table now exposes
  // the same CallableObject source fact the statically typed path reads.
  //
  // Snapshot the union at the GET, before call arguments can mutate the cell
  // it came from. The following CALL consumes the ready string expression via
  // `functionSourceReads`, exactly as a lone callable's deferred read does.
  if (functionSourceReadClaimOf(ctx.staticKeyTexts, operation) === 'union') {
    // The snapshot has to be taken HERE, before a call argument can replace the
    // cell the union was read from; that position is all this site still owns.
    // The claim, the name and the per-arm dispatch the following call consumes
    // are settled by `function-source-reads.ts`.
    const name = ctx.functionSourceSnapshotNames.get(operation.result.id)
    if (name === undefined) {
      throw createCppEmitBlockedError('call-abi:function-source', 'a settled function-source read reached its render with no snapshot name')
    }
    ctx.declarations.push({ name, type: cppTypeOf(receiver) })
    lines.push(`${name} = ${receiverText};`)
    return ''
  }
  if (deferredTypedArrayUnionMethodClaim(ctx.staticKeyTexts, operation.receiver, operation.key) !== null) {
    // Recorded by the prototype-read walk, which asked the same claim.
    return ''
  }
  if (ctx.unionMethodReads.has(operation.result.id)) {
    // Recorded by the prototype-read walk's sibling, which asked the same claim.
    return ''
  }
  if (deferredUnionToStringClaim(ctx, operation.receiver, operation.key) !== null) {
    // Recorded by the prototype-read walk, which asked the same claim.
    return ''
  }
  // A read nothing but `typeof` consumes, off arms that disagree about the
  // member: the question has a per-arm answer and the value has none, so the
  // `typeof` renders the dispatch and this renders nothing at all. Settled by
  // `unionMemberTypeofReadsOf`, which is where the conditions live.
  if (ctx.unionMemberTypeofReads.has(operation.result.id)) return ''
  if (ctx.prototypeMethodReads.get(operation.result.id)?.receiverKind === 'mixed-union') {
    // A heterogeneous union whose arms disagree about this member: the walk
    // recorded one answer PER ARM (`mixedUnionClaimOf`), and the call fusion
    // spells the dispatch. Asked of the recorded fact rather than re-derived,
    // because the claim is per-arm and re-deriving it here would be the second
    // authority the single-census refactor exists to remove.
    return ''
  }
  const leaves = unionPropertyLeaves(receiver, receiverText)
  const armTexts = leaves.map((leaf) => {
    const site = armFieldSite(ctx, leaf.representation, leaf.text, key)
    if (site === null) {
      const native = armRuntimeFieldText(ctx, leaf.representation, leaf.text, key, operation)
      if (native !== null) return native
      // No native recipe is not proof of absence: a prototype or accessor
      // may answer this key. Keep that case visible instead of inventing an
      // undefined result or boxing the typed receiver.
      throw createCppEmitBlockedError(
        'property-access:tagged-union:get:false',
        `a "get" of "${key}" on the tagged union "${representationKey(receiver)}" reaches an arm carried as "${representationKey(leaf.representation)}" with no native property recipe ` +
          `producing "${representationKey(published)}"; boxing a typed receiver is not a property implementation`
      )
    }
    if (representationKey(site.representation) === representationKey(published)) return site.text
    // `convertedValueText`, not `narrowedLoadText` alone: this arm's field can
    // need to WIDEN into what the whole union's `get` publishes just as often
    // as it needs to narrow out of one -- hono's own `Result<T>` (`request.ts`'s
    // `#matchResult[0]`) is a tuple union whose "0" field is a plain
    // `array-object` on one arm and the census still publishes the READ as the
    // two-arm union, because the other tuple arm's own "0" differs. That is a
    // widen (`widenedStoreText`'s job), and `narrowedLoadText` alone only ever
    // reads FROM a union, never INTO one (its own `inner.kind !== 'tagged-union'
    // -> null` at the top) -- `convertedValueText` is the superset that tries
    // both, plus the optional-payload wrap (`this.#matchResult[1]`, present-or-
    // absent), before it is asked to fail closed.
    const converted =
      classFamilyLoadText(ctx, site.representation, published, site.text) ??
      // A `this`-typed function stored in one arm's field, read through a
      // member the union's own declaration states as a method -- hono's
      // `RegExpRouter.match` against `Router<T>.match`. The receiver the
      // language binds is the object this read went through, and it is in
      // hand here.
      receiverBoundFieldText(
        ctx,
        site.representation,
        published,
        site.text,
        operation.receiver.representation,
        operandText(ctx, operation.receiver)
      ) ??
      alignedValueText(ctx, 'emit-union-properties.ts:788', site.representation, published, site.text)
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      'property-access:tagged-union:get:false',
      `a "get" of "${key}" on a tagged union reaches an arm whose field is stored as "${representationKey(site.representation)}" and this ` +
        `read publishes "${representationKey(published)}"; no conversion between those is licensed`
    )
  })
  // Built right-to-left with `reduceRight` rather than by indexing the array,
  // so the accumulator and the arm text are always the `string` the map above
  // produced -- never `string | undefined` from a bounds check TypeScript
  // cannot itself prove.
  const dispatched = dispatchedLeafExpression(leaves, armTexts)
  // A tagged union always has at least two arms (`representation/model.ts`),
  // so this is unreachable in practice; it is here only so the function's own
  // type stays honest about an empty map rather than asserting one away.
  if (dispatched === null) return null
  return dispatched
}

const unionLeafSetText = (
  ctx: EmitContext,
  operation: SetOperation | DefineOwnPropertyOperation,
  leaf: UnionPropertyLeaf,
  key: string,
  rawValueText: string
): string => {
  if (leaf.representation.kind === 'null' || leaf.representation.kind === 'undefined') {
    return `gea::host::throwGetPropertyOfNullish<void>("${leaf.representation.kind}", "set");`
  }
  const site = armFieldSite(ctx, leaf.representation, leaf.text, key)
  if (site !== null) {
    const converted = alignedValueText(
      ctx,
      'emit-union-properties.ts:820',
      operation.value.representation,
      site.representation,
      rawValueText
    )
    if (converted === null) {
      throw createCppEmitBlockedError(
        `property-access:tagged-union:${operation.kind}:false`,
        `a "${operation.kind}" of "${key}" carries "${representationKey(operation.value.representation)}" into a field stored as ` +
          `"${representationKey(site.representation)}", and no conversion is installed`
      )
    }
    // A record arm's declared field created here is created after every key
    // that arm already holds (`declaredFieldCreationText`).
    const created =
      site.presence !== null && tracksKeyOrder(ctx, leaf.representation) ? `${declaredFieldCreationText(leaf.text, key)} ` : ''
    const writes = `${created}${site.text} = ${converted};${site.presence === null ? '' : ` ${site.presence} = true;`}`
    const ownership = addressableArmKind(leaf.representation.kind)
      ? (leaf.representation as Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' | 'class-ref' }>)
          .ownership
      : 'owned'
    return ownership === 'shared-refcount' && ctx.nativeIntegrityRestricted.restricts(leaf.representation)
      ? `if (gea::nativeOwnFieldsWritable(${leaf.text})) { ${writes} }`
      : writes
  }
  if (leaf.representation.kind === 'class-ref') {
    const member = classMemberOf(ctx.classes, leaf.representation.declaration, key)
    if (member?.kind === 'accessor' && member.accessor.setter !== null) {
      if (classFamilyOverridesOf(ctx.classes, leaf.representation.declaration, key).length > 0) {
        throw createCppEmitBlockedError(
          `property-access:tagged-union:${operation.kind}:false`,
          `a "${operation.kind}" of accessor "${key}" through class ${leaf.representation.declaration} needs virtual setter dispatch`
        )
      }
      const abi = ctx.abiOfCallable(member.accessor.setter)
      const parameter = abi?.parameters[0]?.value
      if (abi === null || parameter === undefined) {
        throw createCppEmitBlockedError(
          `property-access:tagged-union:${operation.kind}:false`,
          `setter "${key}" publishes no one-parameter callable convention`
        )
      }
      const converted = alignedValueText(ctx, 'emit-union-properties.ts:849', operation.value.representation, parameter, rawValueText)
      if (converted === null) {
        throw createCppEmitBlockedError(
          `property-access:tagged-union:${operation.kind}:false`,
          `setter "${key}" expects "${representationKey(parameter)}", while this write carries "${representationKey(operation.value.representation)}"`
        )
      }
      return `${cppBodyName(member.accessor.setter)}(${leaf.text}, ${converted});`
    }
  }
  // A string-keyed table arm (mongodb's `hello: Document` handed a `Document`
  // by one caller and a declared `any` by another, then `hello.isWritablePrimary
  // = ...`) stores into its own live table, exactly as a lone dictionary's
  // `set` does in `emit-properties.ts`: the value reconciled to THIS table's
  // declared value carrier, through `setProperty` so a non-writable entry
  // still refuses. No tag changes -- the write lands in whichever table the
  // union already holds.
  if (leaf.representation.kind === 'dictionary' && leaf.representation.key === 'string' && operation.kind === 'set') {
    const stored = alignedValueText(
      ctx,
      'emit-union-properties.ts:dictionary-set',
      operation.value.representation,
      leaf.representation.value,
      rawValueText
    )
    if (stored === null) {
      throw createCppEmitBlockedError(
        'property-access:tagged-union:set:false',
        `a "set" of "${key}" carries "${representationKey(operation.value.representation)}" into a table arm whose values are stored as ` +
          `"${representationKey(leaf.representation.value)}", and no conversion is installed`
      )
    }
    const refused = `!${leaf.text}${memberAccessOperator(leaf.representation.ownership)}setProperty(${cppStringLiteral(key)}, ${stored})`
    return operation.strict
      ? `if (${refused}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");`
      : `(void)(${refused});`
  }
  // A primitive arm whose chain the semantic proof found without this key
  // (`SetOperation.primitiveArmsLackKey`): no setter can run, so the store
  // answers false -- three's `result.outputNode = null` over a `string | Node`
  // build result. Only a listed domain answers this way; any other primitive
  // arm still refuses below, since a missing recipe proves nothing.
  const domain = primitiveArmDomainOf(leaf.representation)
  if (operation.kind === 'set' && domain !== null && (operation.primitiveArmsLackKey?.includes(domain) ?? false)) {
    return operation.strict
      ? `gea::host::throwRuntimeError("TypeError", ${cppStringLiteral(`Cannot create property '${key}' on ${domain}`)});`
      : `(void)0;`
  }
  const propertyKey = unionArmPropertyKeyText(key)
  const boxedValue = sidecarStoredValueText(operation, rawValueText)
  if (leaf.representation.kind === 'dynamic' && boxedValue !== null) {
    return `${leaf.text}.setProperty(${propertyKey}, ${boxedValue});`
  }
  if (sidecarArm(leaf.representation) && boxedValue !== null) {
    return `gea::nativeDynamicSet(${leaf.text}, ${propertyKey}, ${boxedValue});`
  }
  throw createCppEmitBlockedError(
    `property-access:tagged-union:${operation.kind}:false`,
    `a "${operation.kind}" of "${key}" on a tagged union reaches an arm carried as "${representationKey(leaf.representation)}", which declares ` +
      `no writable field or setter "${key}"; not every arm of this union answers this member`
  )
}

/** The written value in the boxed carrier an arm's expando sidecar holds, or `null` when it has no boxed store. */
const sidecarStoredValueText = (operation: SetOperation | DefineOwnPropertyOperation, valueText: string): string | null => {
  const boxed: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  // `widenedStoreText` answers `null` for a value ALREADY in the held carrier
  // -- no widening to do -- which is not the same null as "cannot be stored":
  // a declared-`any` value written through a union's dynamic arm is the box
  // itself.
  if (representationKey(operation.value.representation) === representationKey(boxed)) return valueText
  return widenedStoreText(boxed, operation.value.representation, valueText)
}

/**
 * A computed [[Set]] through every arm's own ordinary-property store -- the
 * store twin of `taggedUnionNativeSidecarGetText`, over the same admitted
 * leaves. `nativeDynamicSet` writes a declared field when the key names one
 * and the arm's identity-keyed expando otherwise, which is the same split the
 * static-key fallback in `unionLeafSetText` already relies on. Only the value
 * crosses into the sidecar's boxed carrier; each arm stays native.
 */
/** A store arm with no sidecar: a shared keyed table, or a primitive whose [[Set]] creates nothing. */
const storeLeafOutsideSidecar = (representation: Representation): boolean =>
  (representation.kind === 'dictionary' && representation.ownership === 'shared-refcount') ||
  representation.kind === 'string' ||
  (representation.kind === 'scalar' && representation.domain !== 'bigint')

const emitTaggedUnionNativeSidecarSet = (ctx: EmitContext, lines: string[], operation: SetOperation): boolean => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union') return false
  const receiverText = operandText(ctx, operation.receiver)
  const leaves = unionPropertyLeaves(receiver, receiverText)
  if (!leaves.every((leaf) => nativeSidecarUnionLeaf(leaf.representation) || storeLeafOutsideSidecar(leaf.representation))) return false
  const key = (): string => propertyKeyText(ctx, operation.key, 'a computed "set" on a native-sidecar tagged union')
  const valueText = operandText(ctx, operation.value)
  // A dictionary arm is its own keyed table (the expando is for a struct's
  // UNdeclared keys), and a primitive arm is 10.1.9's [[Set]] on a primitive
  // base: no own property to create, so strict code throws and sloppy code
  // discards. mongodb's `normalizeHintField` stores into
  // `let finalHint = undefined` narrowed only to `string | Document` inside
  // its `forEach` callback.
  const leafStore = (leaf: UnionPropertyLeaf): string | null => {
    const arm = leaf.representation
    if (arm.kind === 'dictionary') {
      const keyText = keyedTableKeyText(ctx, operation.key, dictionaryKeyDomainOf(arm.key, operation.key.representation))
      const stored = alignedValueText(
        ctx,
        'emit-union-properties.ts:dictionary-arm-set',
        operation.value.representation,
        arm.value,
        valueText
      )
      if (stored === null) return null
      const refused = `!${leaf.text}${memberAccessOperator(arm.ownership)}setProperty(${keyText}, ${stored})`
      return operation.strict
        ? `if (${refused}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");`
        : `(void)(${refused});`
    }
    return operation.strict ? `gea::host::throwRuntimeError("TypeError", "Cannot create property on a primitive value");` : `(void)0;`
  }
  const sidecarValue = (): string => {
    const value = sidecarStoredValueText(operation, valueText)
    if (value === null) {
      throw createCppEmitBlockedError(
        'property-access:tagged-union(native-sidecar-arms):set:true',
        `a computed native-sidecar store carries "${representationKey(operation.value.representation)}", which has no boxed store`
      )
    }
    return value
  }
  const statements: string[] = []
  for (const leaf of leaves) {
    if (leaf.representation.kind === 'null' || leaf.representation.kind === 'undefined') {
      statements.push(`gea::host::throwGetPropertyOfNullish<void>("${leaf.representation.kind}", "set");`)
      continue
    }
    if (storeLeafOutsideSidecar(leaf.representation)) {
      const stored = leafStore(leaf)
      if (stored === null)
        throw createCppEmitBlockedError(
          'property-access:tagged-union(native-sidecar-arms):set:true',
          `a computed store carries "${representationKey(operation.value.representation)}" into a "${representationKey(leaf.representation)}" arm with no conversion`
        )
      statements.push(stored)
      continue
    }
    statements.push(
      leaf.representation.kind === 'dynamic'
        ? `${leaf.text}.setProperty(${key()}, ${sidecarValue()});`
        : `gea::nativeDynamicSet(${leaf.text}, ${key()}, ${sidecarValue()});`
    )
  }
  let chain = ''
  statements.forEach((statement, index) => {
    if (statements.length === 1) chain = statement
    else if (index === 0) chain = `if (${leaves[0]?.test ?? 'false'}) { ${statement} }`
    else if (index === statements.length - 1) chain += ` else { ${statement} }`
    else chain += ` else if (${leaves[index]?.test ?? 'false'}) { ${statement} }`
  })
  lines.push(chain)
  if (operation.result) defineValueAlias(ctx, operation.result, receiverText)
  return true
}

/**
 * Writing a STATIC key onto a tagged-union receiver -- `set` and
 * `define-own-property` alike, for the identical reason
 * `emit-properties.ts`'s `emitFieldStoreLines` treats the two as one write:
 * a definition with no descriptor this backend cannot spell already refused
 * upstream (`ir/lower-property.ts`), and a default data descriptor IS an
 * ordinary assignment.
 *
 * The dispatch is a real `if`/`else if`/`else` over the union's own arms
 * rather than one expression, because a store is a statement: every arm but
 * the last is tested, and the last is unconditional, which is sound only
 * because the union's own tag is guaranteed to be one of them.
 */
export const emitTaggedUnionSet = (ctx: EmitContext, lines: string[], operation: SetOperation | DefineOwnPropertyOperation): boolean => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union') return false
  if (emitNativeNumericUnionSet(ctx, lines, operation)) return true
  if (emitTaggedUnionElementSet(ctx, lines, operation)) return true
  // Same STATIC-key claim as `taggedUnionGetText` above: the pre-render map,
  // never `constantTexts`'s render-time accretion, decides which arm's field
  // or setter this write targets.
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return operation.kind === 'set' && emitTaggedUnionNativeSidecarSet(ctx, lines, operation)
  const receiverText = operandText(ctx, operation.receiver)
  const rawValueText = operandText(ctx, operation.value)
  const leaves = unionPropertyLeaves(receiver, receiverText)
  const statements = leaves.map((leaf) => unionLeafSetText(ctx, operation, leaf, key, rawValueText))
  // Built by walking the array with `forEach` rather than indexing it, for
  // the identical `noUncheckedIndexedAccess` reason `taggedUnionGetText`
  // avoids indexing above: `stmt` and `index` come straight from the
  // callback, never through a bounds check TypeScript cannot verify.
  let chain = ''
  statements.forEach((stmt, index) => {
    if (statements.length === 1) {
      chain = stmt
    } else if (index === 0) {
      chain = `if (${leaves[0]?.test ?? 'false'}) { ${stmt} }`
    } else if (index === statements.length - 1) {
      chain += ` else { ${stmt} }`
    } else {
      chain += ` else if (${leaves[index]?.test ?? 'false'}) { ${stmt} }`
    }
  })
  lines.push(chain)
  // The store's own result is the receiver threaded onward, exactly as the
  // ordinary record field store publishes the object it wrote into
  // (`emit-properties.ts`'s `emitFieldStoreLines`), not the success boolean
  // the internal method nominally returns.
  if (operation.result) defineValueAlias(ctx, operation.result, receiverText)
  return true
}

/**
 * Every deferred tagged-union method read in one body, settled before the body
 * renders a line. Composes; decides nothing -- `deferredUnionMethodClaim` is
 * the one statement of what such a read is, and this is its other caller.
 */
/**
 * What `typeof` answers for ONE arm's view of a member, or `null` where this
 * file cannot answer it exactly.
 *
 * Every arm answers from a table this backend already owns, never from the
 * absence of a renderer -- the same discipline `armHasNoCallableMember`
 * states, for the same reason: "the language answers undefined here" and "this
 * member is not implemented yet" are different facts, and guessing between
 * them is a narrowing that silently takes the wrong branch.
 *
 * - a declared field on the arm: what its own carrier is;
 * - a class member: a method is `"function"`, an accessor is whatever its
 *   getter returns;
 * - a class that declares NO such member: the expando read, for the reason
 *   `UnionMemberTypeofAnswer` states;
 * - a promise: `Promise.prototype`'s member set is closed (ECMA-262 27.2.5)
 *   and `gea::Promise` has no dynamic-property sidecar, so a member of it is
 *   `"function"` and anything else is `"undefined"`;
 * - a string: `String.prototype`'s member set is the modelled one, so the same
 *   split, with `length` the one member that is a number.
 *
 * `deferred` marks the arms whose member is a PROTOTYPE METHOD -- the ones
 * with no function object to hand over, which is the only reason the whole
 * claim exists. `unionMemberTypeofReadsOf` requires one.
 */
const armMemberTypeofAnswer = (
  ctx: EmitContext,
  arm: Representation,
  key: string
): { readonly answer: UnionMemberTypeofAnswer; readonly deferred: boolean } | null => {
  const settled = (answer: string, deferred = false) => ({ answer: { kind: 'constant' as const, answer }, deferred })
  const site = armFieldSite(ctx, arm, '', key)
  if (site !== null) {
    const answer = typeofTextFor(site.representation)
    return answer === null ? null : settled(answer)
  }
  if (arm.kind === 'class-ref') {
    const member = classMemberOf(ctx.classes, arm.declaration, key)
    if (member === null)
      return sidecarArm(arm) && !nativePrototypeAnswers(arm, key) ? { answer: { kind: 'expando' }, deferred: false } : null
    if (member.kind === 'method') return settled('function')
    if (member.kind !== 'accessor' || member.accessor.getter === null) return null
    const abi = ctx.abiOfCallable(member.accessor.getter)
    if (abi === null) return null
    const answer = typeofTextFor(abi.result)
    return answer === null ? null : settled(answer)
  }
  if (arm.kind === 'promise') return promisePrototypeMethods.has(key) ? settled('function', true) : settled('undefined')
  if (arm.kind === 'string') {
    if (key === 'length') return settled('number')
    if (canonicalIndexLiteral(key) !== null) return null
    return isDeclaredStringPrototypeKey(key) ? settled('function', true) : settled('undefined')
  }
  return null
}

/**
 * Member reads whose ONLY consumer is `typeof`, off a union whose arms
 * disagree about the member -- see `EmitContext.unionMemberTypeofReads`.
 *
 * Three conditions keep this from taking over reads the ordinary path already
 * renders, and all three are about not moving output that was already right:
 *
 * - at least one arm's member must be a PROTOTYPE METHOD. Those are the only
 *   members this backend can call but never hand over as a value, so they are
 *   the only reason a read like this has nothing to produce. Every other union
 *   either renders the member or refuses for a reason of its own.
 * - at least one arm must have no declared field site, which is the arm that
 *   disagrees.
 * - `Object.prototype`'s own names are excluded: they are on every arm, so
 *   they are never the disagreement.
 */
export const unionMemberTypeofReadsOf = (ctx: EmitContext, body: IrBody): ReadonlyMap<IrValueId, UnionMemberTypeofRead> => {
  const claimed = new Map<IrValueId, UnionMemberTypeofRead>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      const receiver = operation.receiver.representation
      if (receiver.kind !== 'tagged-union') continue
      const key = ctx.staticKeyTexts.get(operation.key.value)
      if (key === undefined || objectPrototypeMemberNames.has(key)) continue
      const leaves = unionPropertyLeaves(receiver, '')
      const resolved = leaves.map((leaf) => armMemberTypeofAnswer(ctx, leaf.representation, key))
      if (!resolved.every((entry): entry is NonNullable<typeof entry> => entry !== null)) continue
      if (!resolved.some((entry) => entry.deferred)) continue
      if (leaves.every((leaf) => armFieldSite(ctx, leaf.representation, '', key) !== null)) continue
      claimed.set(operation.result.id, { receiver: operation.receiver, member: key, answers: resolved.map((entry) => entry.answer) })
    }
  }
  if (claimed.size === 0) return claimed
  // A claimed read renders NOTHING, so anything but a `typeof` reading it
  // would name a value that was never defined. The scan is over every operand
  // in the body rather than over the claims themselves, because a value's
  // consumers are not reachable from its producer.
  const otherwiseConsumed = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'compute' && operation.form === 'typeof') continue
      for (const operand of operandsOfIrOperation(operation)) otherwiseConsumed.add(operand.value)
    }
  for (const value of claimed.keys()) if (otherwiseConsumed.has(value)) claimed.delete(value)
  return claimed
}

export const unionMethodReadsOf = (ctx: EmitContext, body: IrBody): ReadonlyMap<IrValueId, UnionMethodRead> => {
  const reads = new Map<IrValueId, UnionMethodRead>()
  // A claimed read renders nothing and its CALL renders the dispatch, so a
  // read anything else consumes -- `union.m.bind(union)`, hono's
  // `router.match.bind(router)` -- keeps the per-arm value walk instead of
  // naming a value that was never defined.
  const otherwiseConsumed = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block))
      for (const operand of operandsOfIrOperation(operation)) {
        if (
          operation.kind === 'call' &&
          operand.value === operation.callee.value &&
          operation.receiver?.value !== operand.value &&
          !operation.arguments.some((argument) => argument.value === operand.value)
        )
          continue
        otherwiseConsumed.add(operand.value)
      }
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get' || otherwiseConsumed.has(operation.result.id)) continue
      // `emitGet` reads an optional receiver through its present view and asks
      // the claim there (three's NodeMaterial `alphaTestNode.add(...)` on a
      // `let` first written `null`). Asking on the optional here instead
      // recorded nothing, so the read rendered as a deferred dispatch and the
      // call found no dispatch to render: a read of a value never defined.
      const claim = deferredUnionMethodClaim(ctx, presentViewOf(operation.receiver), operation.key)
      if (claim !== null) reads.set(operation.result.id, claim)
    }
  }
  return reads
}
