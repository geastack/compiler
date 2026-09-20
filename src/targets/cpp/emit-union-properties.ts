import type { Representation } from '../../representation/model.js'
import { dictionaryKeyDomainOf, representationKey } from '../../representation/model.js'
import { typedArrayUnionOnly } from '../../representation/host-templates.js'
import type { IrValueId } from '../../identity/ids.js'
import type { DefineOwnPropertyOperation, GetOperation, IrBody, IrOperand, SetOperation } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import {
  createCppEmitBlockedError,
  defineValueAlias,
  operandText,
  wellKnownSymbolMemberOf,
  type EmitContext,
  type PrototypeMethodRead,
  type UnionMemberTypeofAnswer,
  type UnionMemberTypeofRead,
  type UnionMethodArm,
  type UnionMethodRead
} from './emit-context.js'
import { functionSourceReadClaimOf } from './function-source-reads.js'
import { cppBodyName, cppRecordFieldName, cppRecordFieldPresenceName, cppStringLiteral, cppTypeOf, cppUndefinedIn } from './types.js'
import { declaredFieldRepresentationOf, declaredRecordFieldOf } from './records.js'
import { absentCapableNumericElementText, keyedTableKeyText, memberAccessOperator } from './emit-carrier-members.js'
import { alignedValueText, classFamilyLoadText, receiverBoundFieldText, widenedStoreText } from './emit-narrowing.js'
import { canonicalIndexLiteral, stringIndexText, isDeclaredStringPrototypeKey } from './emit-carrier-members.js'
import { objectPrototypeMemberNames } from '../../representation/record-fields.js'
import { classFamilyOverridesOf, classMemberOf } from './class-layout.js'
import { classMethodOverrideOf } from '../../projection/fields.js'
import { classMethodValueArmsOf, virtualDispatchKey } from '../../projection/dispatch.js'
import { cppVirtualMemberName } from './virtual-methods.js'
import { abiOfCallee } from '../../projection/callee.js'
import { recordAccessorsOfShape } from './records.js'
import { cppRecordIndexSidecarName } from './records.js'
import { hasNativeNumericIndexArms, nativeNumericIndexOf } from '../../representation/numeric-index.js'
import { binaryToStringTagText, typedArrayBufferMemberText, typedArrayPrototypeMethods } from './emit-buffers.js'
import { typeofTextFor } from './emit-typeof.js'
import { promisePrototypeMethods } from './prototype/emit-prototype-invoke.js'
import { classConstructorStaticMemberTextFor, classMethodValueText } from './class-properties/emit-class-properties.js'
import { overriddenMethodValueText } from './class-properties/computed-method-value.js'
import { propertyKeyText } from './emit-dynamic-properties.js'
import { toStringTextOver } from './emit-tostring.js'
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
  const publishedAbi = abiOfCallee(operation.result.representation)
  if (publishedAbi === null || publishedAbi.receiver === null) return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined || objectPrototypeMemberNames.has(key)) return null
  if (deferredUnionMethodClaim(ctx, operation.receiver, operation.key) !== null) return null
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
  const propertyKey = `gea::PropertyKey::string(${cppStringLiteral(key)})`
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
    return index === null ? null : arrayArmReadText(armExprText, 'elementAt', index, arm.element, published)
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
  if (arm.kind === 'scalar') {
    // Ordinary named properties on a primitive are read through its wrapper
    // object. This runtime has no mutable Number/Boolean prototype, so a name
    // outside Object.prototype is absent on the primitive arm. That is the
    // native answer for overload probes such as `number | Vector3` reading
    // `isVector3`: the scalar arm contributes `undefined`, while the class arm
    // contributes the declared boolean marker.
    if (!objectPrototypeMemberNames.has(key) && published.kind === 'optional' && published.absence === 'undefined') {
      return cppUndefinedIn(published)
    }
  }
  if (arm.kind === 'constructor-family') {
    return classConstructorStaticMemberTextFor(ctx, arm, key, published, () => armExprText)
  }
  if (objectPrototypeMemberNames.has(key)) return null
  // A promise's member set is CLOSED, which is what makes absence provable
  // here rather than merely unrendered. ECMA-262 27.2.5 gives
  // `Promise.prototype` exactly `then`, `catch`, `finally` and
  // `@@toStringTag`; everything else a promise answers comes from
  // `Object.prototype`, which the line above already returned for. And this
  // runtime's `gea::Promise` is a `shared_ptr` to a settled-value state with
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
        return overriddenMethodValueText(ctx, arm, armExprText, key, (method) =>
          classMethodValueText(ctx, operation, key, method, published, armExprText, arm)
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
      if (site.method.callable === null || ctx.captures.of(site.method.callable).kind !== 'none') return null
      const converted = classMethodValueText(ctx, operation, key, site.method, published, armExprText, arm).text
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
  if (sidecarArm(arm)) {
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
    return storage.kind === 'elements' ? `${at}->setElement(${key}, ${written});` : `${member}operator[](${key}) = ${written};`
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
const dictionaryArmReadText = (member: string, keyText: string, dictionaryValue: Representation, published: Representation): string => {
  const rawRead = `${member}read(${keyText})`
  if (published.kind !== 'optional') {
    if (representationKey(dictionaryValue) === representationKey(published)) return rawRead
    const widened = widenedStoreText(published, dictionaryValue, rawRead)
    if (widened !== null) return widened
    throw createCppEmitBlockedError(
      'property-access:tagged-union(dictionary-arms):get:true',
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
      'property-access:tagged-union(dictionary-arms):get:true',
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
  if (presentText === null) {
    throw createCppEmitBlockedError(
      'property-access:tagged-union(array-arms):get:true',
      `a computed "get" on an array-armed tagged union reaches an arm whose element is stored as ` +
        `"${representationKey(element)}" and this read publishes "optional(${representationKey(published.payload)})"; ` +
        'no widening between those is licensed'
    )
  }
  const has = reader === 'elementAtIndex' ? 'hasElementAtIndex' : 'hasElement'
  const carrier = cppTypeOf(published)
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
  if (representation.kind !== 'class-ref') return null
  const site = classMemberOf(ctx.classes, representation.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
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
  const layouts = recordLayoutPolicyOf(ctx.deriver, ctx.classes)
  if (toStringTextOver('gea_receiver', carrier, layouts) === null) return null
  return { receiverKind: 'union-to-string', member: 'toString', receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

/** The call half of `deferredUnionToStringClaim`, fused with the read above. */
export const unionToStringCallText = (ctx: EmitContext, carrier: Representation, receiverText: string): string => {
  const text = toStringTextOver(receiverText, carrier, recordLayoutPolicyOf(ctx.deriver, ctx.classes))
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
  return arms === null ? null : { receiver, arms }
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
  if (deferredUnionMethodClaim(ctx, operation.receiver, operation.key) !== null) {
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
        `a "get" of "${key}" on a tagged union reaches an arm carried as "${representationKey(leaf.representation)}" with no native property recipe ` +
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
    const writes = `${site.text} = ${converted};${site.presence === null ? '' : ` ${site.presence} = true;`}`
    const ownership = addressableArmKind(leaf.representation.kind)
      ? (leaf.representation as Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' | 'class-ref' }>)
          .ownership
      : 'owned'
    return ownership === 'shared-refcount' && ctx.nativeIntegrityRestricted
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
  const propertyKey = `gea::PropertyKey::string(${cppStringLiteral(key)})`
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
const sidecarStoredValueText = (operation: SetOperation | DefineOwnPropertyOperation, valueText: string): string | null =>
  widenedStoreText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, operation.value.representation, valueText)

/**
 * A computed [[Set]] through every arm's own ordinary-property store -- the
 * store twin of `taggedUnionNativeSidecarGetText`, over the same admitted
 * leaves. `nativeDynamicSet` writes a declared field when the key names one
 * and the arm's identity-keyed expando otherwise, which is the same split the
 * static-key fallback in `unionLeafSetText` already relies on. Only the value
 * crosses into the sidecar's boxed carrier; each arm stays native.
 */
const emitTaggedUnionNativeSidecarSet = (ctx: EmitContext, lines: string[], operation: SetOperation): boolean => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'tagged-union') return false
  const receiverText = operandText(ctx, operation.receiver)
  const leaves = unionPropertyLeaves(receiver, receiverText)
  if (!leaves.every((leaf) => nativeSidecarUnionLeaf(leaf.representation))) return false
  const key = propertyKeyText(ctx, operation.key, 'a computed "set" on a native-sidecar tagged union')
  const value = sidecarStoredValueText(operation, operandText(ctx, operation.value))
  if (value === null) {
    throw createCppEmitBlockedError(
      'property-access:tagged-union(native-sidecar-arms):set:true',
      `a computed native-sidecar store carries "${representationKey(operation.value.representation)}", which has no boxed store`
    )
  }
  const statements = leaves.map((leaf) => {
    if (leaf.representation.kind === 'null' || leaf.representation.kind === 'undefined') {
      return `gea::host::throwGetPropertyOfNullish<void>("${leaf.representation.kind}", "set");`
    }
    return leaf.representation.kind === 'dynamic'
      ? `${leaf.text}.setProperty(${key}, ${value});`
      : `gea::nativeDynamicSet(${leaf.text}, ${key}, ${value});`
  })
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
    if (member === null) return sidecarArm(arm) ? { answer: { kind: 'expando' }, deferred: false } : null
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
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      const claim = deferredUnionMethodClaim(ctx, operation.receiver, operation.key)
      if (claim !== null) reads.set(operation.result.id, claim)
    }
  }
  return reads
}
