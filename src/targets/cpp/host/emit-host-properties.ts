import type { DefineOwnPropertyOperation, GetOperation, IrBody, IrOperand, IrResult, SetOperation } from '../../../ir/model.js'
import { allOperationsOf } from '../../../ir/model.js'
import { operandsOfIrOperation } from '../../../ir/queries.js'
import type { DeclarationId, IrValueId } from '../../../identity/ids.js'
import { callSiteHostReadIsDeferred, hostReceiverProtocolOf } from '../../../representation/host-templates.js'
import {
  createCppEmitBlockedError,
  defineValue,
  operandText,
  type EmitContext,
  type HostMemberRead,
  type PrototypeMethodRead
} from '../emit-context.js'
import { fillHostTemplate, hostIntrinsicLengthOf, hostMemberOf, type HostSpellings } from './host-members.js'
import type { HostMethodAlias } from './host-method-aliases.js'
import { staticKeyTextOf } from '../emit-properties.js'
import { objectShapePrototypeMethods } from '../../../projection/callee.js'
import { cppStringLiteral } from '../types.js'
import { boxedValueText, propertyKeyText, unboxedReadText } from '../emit-dynamic-properties.js'
import { intrinsicMemberValueOf } from './emit-host-object.js'
import { hostPrototypeMethodSignatureText, hostPrototypeMethodValueText } from './emit-host-value.js'
import { alignedValueText } from '../emit-narrowing.js'

/** A declaration-bound host method can share a native carrier with ordinary language objects. */
export const declaredHostMethodRead = (ctx: EmitContext, operation: GetOperation): boolean => {
  const binding = operation.hostMethod
  if (!binding) return false
  // Asked, not re-derived: `hostMemberReadsOf` claims exactly the bindings
  // whose row is a method, so a binding it declined is one the host table
  // states no implementation for -- which is worth saying by name here, where
  // the protocol and member the program wrote are in hand.
  if (ctx.hostMemberReads.has(operation.result.id)) return true
  throw createCppEmitBlockedError(
    `host-invocation:${binding.protocol}.${binding.member}`,
    `the resolved host method "${binding.protocol}.${binding.member}" has no implementation`
  )
}

/**
 * A host object's data properties, in both directions.
 *
 * A host object is not a struct this compiler lays out: its members are the
 * host's own implementation, reached by a spelling the host defines and states
 * in a `HostMemberTable`. Both directions live here together, because they are
 * one question asked twice -- which table claims this member, under which key --
 * and answering it in two files is how a read and a write come to disagree
 * about what a protocol is called.
 */

/**
 * A host method with no fixed ABI (`arity: 'call-site'` -- `Array.from`,
 * `Array.isArray`), read as a bare VALUE rather than called: `describe(Array.from,
 * 'name')` (`test/runtime/static-intrinsic-reflection.runtime.js`) passes it as
 * an ordinary argument.
 *
 * ECMA-262 gives `Array.from` a real function object with its own `name`/`length`
 * data properties (10.2.4 `SetFunctionName`/`SetFunctionLength`) -- but its
 * overload set has no single physical parameter frame for THIS backend's native
 * callable convention to capture (the same "unjoinable overload set" reason
 * `emit-callable.ts`'s `emitConstruct` already names for `Date`/`RegExp`/typed
 * arrays), so it cannot be a native `CallableObject` value. This is one of the
 * four sanctioned dynamic boundaries: a genuinely dynamic JS boundary
 * (`docs/ARCHITECTURE.md`) with no native representation, not a typed value
 * boxed to dodge a native answer.
 *
 * The box is real, not a stub that happens to answer two properties: it IS a
 * `gea::Value::Tag::Function`, and `Value::ownDescriptor` (`gea_dynamic_proxy.h`)
 * already reads a Function box's reflection from `functionProperties_` -- so
 * setting `name`/`length` there, with ECMA-262's own attributes for a builtin's
 * own name/length (10.2.4: non-writable, non-enumerable, configurable), makes
 * `Object.getOwnPropertyDescriptor(Array.from, 'name'|'length')` answer through
 * the SAME runtime path an ordinary dynamic function does, with no runtime
 * change needed. The underlying callable is never invoked by anything this
 * probe's own reflection questions reach -- `describe` never calls its `obj`
 * argument -- so a captureless no-op stub is what it wraps; a program that DID
 * call it back would need a real per-member ABI this table does not have.
 */
const dynamicHostFunctionValueText = (protocol: string, member: string, arity: number | null): string => {
  const nameProperty =
    `gea::PropertyDescriptor{.hasValue = true, .hasWritable = true, .hasEnumerable = true, .hasConfigurable = true, ` +
    `.value = gea::Value::box(gea::Value::Tag::String, std::string(${cppStringLiteral(member)})), ` +
    '.writable = false, .enumerable = false, .configurable = true}'
  const lengthProperty =
    `gea::PropertyDescriptor{.hasValue = true, .hasWritable = true, .hasEnumerable = true, .hasConfigurable = true, ` +
    `.value = gea::Value::box(gea::Value::Tag::Number, static_cast<double>(${arity ?? 0})), ` +
    '.writable = false, .enumerable = false, .configurable = true}'
  return (
    '([&]() -> gea::Value { ' +
    'auto __gea_fn = gea::Value::box(gea::Value::Tag::Function, gea::CallableObject<void()>(+[](void*) {}, nullptr)); ' +
    `__gea_fn.functionProperties()->defineOwnProperty(gea::PropertyKey::string("name"), ${nameProperty}); ` +
    `__gea_fn.functionProperties()->defineOwnProperty(gea::PropertyKey::string("length"), ${lengthProperty}); ` +
    `return __gea_fn; })() /* "${protocol}.${member}" -- see dynamicHostFunctionValueText */`
  )
}

/** Asked of `representation/host-templates.ts`, which the IR's host-template routing asks too. */
const nativeHostProtocol = (receiver: IrOperand): { readonly protocol: string; readonly strict: boolean } | null =>
  hostReceiverProtocolOf(receiver.representation)

/**
 * Whether a native-handle member read is a host intrinsic's own REFLECTION
 * method (`Math.hasOwnProperty`) rather than a member of its protocol.
 *
 * Stated once; `nativeHostMemberText` and the prototype-read walk both ask it.
 * Gated on the protocol actually being classified, so an unclassified
 * native-handle protocol still falls through to the ordinary "claimed by no
 * host member table" refusal rather than silently answering here.
 */
export const deferredIntrinsicReflectionClaim = (
  hosts: HostSpellings,
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const hostProtocol = nativeHostProtocol(receiver)
  if (hostProtocol === null) return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !objectShapePrototypeMethods.has(staticKey)) return null
  if (!hosts.intrinsicMembers.has(hostProtocol.protocol)) return null
  return {
    receiverKind: 'native-handle-shape',
    member: staticKey,
    receiver: { kind: 'none' },
    receiverElement: null,
    intrinsicProtocol: hostProtocol.protocol
  }
}

export const nativeHostMemberText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrResult | null): string | null => {
  const hostProtocol = nativeHostProtocol(receiver)
  if (hostProtocol === null) return null
  const representation = receiver.representation
  const protocol = representation.kind === 'native-handle' ? representation.protocol : hostProtocol.protocol
  // Members are keyed by the carrier when the host stated one, and by the
  // declared name when it did not (`Console`, `Storage`, `JSON` -- singletons
  // with no type of their own). This is what removes the inheritance miss this
  // function's own comment below records: `HTMLElement.getAttribute` and
  // `Element.getAttribute` are one key once both carry `NodeHandle`, so there
  // is no step for a flat lookup to fail to walk. Diagnostics below keep
  // naming `protocol`, because that is the name the program wrote.
  const memberProtocol = hostProtocol.protocol
  // A claim, not a fold: this decides whether the access is a STATIC member at
  // all (falls through to the computed-key path below when it is not), so it
  // must not see a key text `constantTexts` only holds because the render
  // minted it (e.g. a folded `typeof` result reaching here via a computed key).
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === undefined) {
    const computed =
      representation.kind === 'native-handle' ? computedNativeHandleGetText(ctx, receiver, key, result, protocol, memberProtocol) : null
    if (computed !== null) return computed
    if (!hostProtocol.strict) return null
    // No specific member name survives past this point -- the key is
    // genuinely computed -- so the subject is the receiver's own computed-get
    // capability, exactly `ir/certify.ts`'s own `property-access` spelling.
    throw createCppEmitBlockedError(
      'property-access:native-handle:get:true',
      `a "${protocol}" host handle has no runtime member table; a property access keyed by a non-constant key has no rendering`
    )
  }
  // Deferred, and NOT decided here: `hostMemberReadsOf` settled which reads
  // are deferred host members before this body rendered a line, and this asks
  // it. The tests that used to stand in this function -- is the row a method,
  // is this the call-site-arity carve-out -- moved there whole rather than
  // being repeated at both ends; what is left in this file is the two
  // SPELLINGS and the refusals that name a host table.
  if (result !== null && ctx.hostMemberReads.has(result.id)) return ''
  // `hasOwnProperty`/`propertyIsEnumerable` reached off a native-handle
  // receiver (`Math.hasOwnProperty(...)`, or `Object.prototype.hasOwnProperty
  // .call(Math, ...)` after the borrowed-call rewrite retargets its receiver
  // to `Math`) -- the identical deferred GET-then-CALL split
  // `objectShapePrototypeMemberRead` makes for a record/class-ref receiver,
  // for the identical reason: neither name is a row `hostMemberOf` could ever
  // claim (they are `Object.prototype`'s own, not `Math`'s), and answering
  // them from `Math`'s static reflection table is this file's own subject.
  // Gated on the protocol actually being classified (`intrinsicMembers.has`)
  // so an unclassified native-handle protocol still falls through to this
  // function's ordinary "claimed by no host member table" refusal below,
  // rather than this arm silently answering `false` for one whose own
  // members were never read at all.
  if (deferredIntrinsicReflectionClaim(ctx.hosts, ctx.staticKeyTexts, receiver, key) !== null) {
    if (result === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${staticKey}`,
        `"${protocol}.${staticKey}" is a host intrinsic's reflection method, and this access publishes no value for its call to consume`
      )
    }
    return ''
  }
  // A member the host states a spelling for. A data property is a value and
  // renders here; a method is not a value at all -- only its call names a host
  // symbol -- so the access records what was reached and `emitCall` renders it.
  const host = hostMemberOf(ctx.hosts.members, memberProtocol, staticKey)
  // Native records may also be compiler-owned runtime types (Date, RegExp,
  // String objects). Their dedicated emitters and sidecars remain the owner
  // when no authenticated host row claims this key. Native handles, by
  // contrast, have no other storage and retain their fail-closed behavior.
  if (host === undefined && !hostProtocol.strict) return null
  if (host === undefined && memberProtocol.endsWith('.prototype')) {
    const member = ctx.hosts.intrinsicMembers.get(memberProtocol)?.find((candidate) => candidate.name === staticKey)
    const signature = result === null ? null : hostPrototypeMethodSignatureText(result.representation)
    if (member?.kind !== 'method' || signature === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${staticKey}`,
        `"${protocol}.${staticKey}" is a prototype member this backend renders only as a reflectable method value; this read is ` +
          (member === undefined ? 'of no such member' : member.kind === 'value' ? 'of a data member' : 'not typed as a callable value')
      )
    }
    return hostPrototypeMethodValueText(
      signature,
      memberProtocol,
      staticKey,
      hostIntrinsicLengthOf(memberProtocol, staticKey, member.arity)
    )
  }
  if (host?.kind === 'property') {
    // A member the host states only a write for is refused here rather than
    // read through its store template: `(...).frame = {value}` is not an
    // expression that answers what `view.frame` is, and rendering it as one
    // would emit a write where the program asked for a read.
    if (host.emit === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${staticKey}`,
        `"${protocol}.${staticKey}" is claimed as a host property with no read spelling, so this access has nothing to render`
      )
    }
    // A class member has no receiver to render, the same fact and the same
    // reason the 'method' branch below already states: the host names the
    // class outright (`gea::host::StringConstructor::fromCharCode`, a
    // qualified static symbol with no `{receiver}` slot to fill), and a
    // template that does not name one is filled fine with `null`. Asking
    // `operandText` for the class's own value unconditionally -- this used
    // to -- refused every such property by name (`host-class-value`) even
    // though nothing here reads the receiver's text: `String.fromCharCode`
    // is a property access on the `String` class object, not on an instance.
    const receiverText = ctx.hostClassReads.has(receiver.value) ? null : operandText(ctx, receiver)
    const filled = fillHostTemplate(host.emit, receiverText, [])
    if (filled === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${staticKey}`,
        `the "${protocol}.${staticKey}" host template names a slot this access cannot fill`
      )
    }
    // The template owns its native result carrier. Inferring it from the
    // property name claimed Array.prototype's ArrayObject was a NativeHandle
    // and refused a read whose source and destination actually agree.
    if (host.resultRepresentation !== undefined && result !== null) {
      const converted = alignedValueText(ctx, 'host/emit-host-properties.ts:239', host.resultRepresentation, result.representation, filled)
      if (converted !== null) return converted
    }
    // A builtin function read as a VALUE (`const alias = Math.imul`) is a copy
    // of the host's one static `CallableObject`, and a copy mints no identity
    // (`gea_runtime.h`). Two such reads compared unequal to each other and to
    // the builtin itself. `identified()` mints on the static first, so every
    // copy shares it. A read that is only ever CALLED (`Math.pow(x)`, the
    // ordinary spelling of every builtin call) is left alone: identity is
    // observable only where the value goes somewhere other than a call, and
    // the minted identity is a `Ref` every copy would otherwise count in and
    // out of on the hot call path.
    const kind = result?.representation.kind
    const callable =
      kind === 'function-value-dispatch' ||
      kind === 'function' ||
      kind === 'function-and-constructor' ||
      kind === 'constructor-value-dispatch'
    if (callable && result !== null && !ctx.calleeOnlyValues.has(result.id)) return `${filled}.identified()`
    return filled
  }
  if (host?.kind === 'method') {
    if (result === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${staticKey}`,
        `"${protocol}.${staticKey}" is a host method, and this access publishes no value for its call to consume`
      )
    }
    // Reaching here means `hostMemberReadsOf` did NOT claim the read, and for
    // a host method row that leaves exactly one answer: a call-site-arity row
    // (`arity: 'call-site'`) read bare into a `dynamic` destination --
    // `describe(Array.from, 'name')` -- has no native callable convention to
    // fuse with, and is boxed as a function value instead (see
    // `dynamicHostFunctionValueText`'s own comment for why that is sanctioned).
    // The same row read into a NATIVE destination is deferred, and that
    // distinction is stated once, where the claim is made.
    const arity = ctx.hosts.intrinsicMembers.get(memberProtocol)?.find((candidate) => candidate.name === staticKey)?.arity ?? null
    return dynamicHostFunctionValueText(protocol, staticKey, arity)
  }
  // Nothing claims this member, and there is no spelling to invent for it.
  //
  // This used to interpolate `gea::host::<protocol>::<key>` here, for the
  // singleton members that really do have such a symbol (`Math::pow` and
  // friends). Those are `coreHostMembers` rows now, resolved by the
  // `property` branch above, because the interpolation could not tell them
  // apart from anything else: it answered for EVERY unclaimed member of EVERY
  // native-handle protocol. `Promise.resolve` and `Math.acos` are claimed
  // protocols with no such symbol; `HTMLElement.getAttribute` is a member the
  // table declares one inheritance step away, on `Element`, which
  // `hostMemberOf`'s flat `<protocol>.<member>` lookup does not walk up to.
  // All three were spelled anyway and all three failed in clang as "no member
  // named ... in namespace 'gea::host'", which names neither the access that
  // caused it nor the table that failed to claim it.
  //
  // So this refuses by name instead, at the layer that knows both. The
  // registry deciding which members have an implementation is `hostMembers`
  // itself -- the same shape `emit-host-invoke.ts` gives the call half, where
  // an unregistered protocol refuses against `hostInvocations` rather than
  // being handed a constructed symbol.
  throw createCppEmitBlockedError(
    `host-invocation:${protocol}.${staticKey}`,
    `"${protocol}.${staticKey}" is claimed by no host member table -- neither this backend's own (host-members.ts) nor any ` +
      "plugin's states a spelling for it, so there is no host symbol to name"
  )
}

/**
 * A write to a data property of a host object.
 *
 * The mirror of `nativeHandleMemberText`'s read, and keyed the same way: by the
 * carrier the host stated, falling back to the declared protocol name for a
 * singleton that has no type of its own. A host object is not a struct this
 * compiler lays out, so a write is the host's own spelling with `{value}`
 * filled in -- never a `->` member assignment into a layout that does not
 * exist.
 *
 * Every failure is refused by name, and none of them is answered by inventing
 * a spelling. A member no table claims, a member claimed read-only, a
 * non-constant key: each is a boundary this compiler was told nothing about,
 * and a guess there writes to a symbol the host never declared.
 */
export const emitNativeHostStore = (
  ctx: EmitContext,
  lines: string[],
  operation: SetOperation | DefineOwnPropertyOperation,
  label: string
): boolean => {
  const representation = operation.receiver.representation
  const hostProtocol = nativeHostProtocol(operation.receiver)
  if (hostProtocol === null) return false
  const protocol = representation.kind === 'native-handle' ? representation.protocol : hostProtocol.protocol
  const memberProtocol = hostProtocol.protocol
  const receiverText = ctx.hostClassReads.has(operation.receiver.value) ? null : operandText(ctx, operation.receiver)
  // A claim, not a fold: this decides whether the store is a STATIC member at
  // all (falls through to the computed-key store below when it is not), so it
  // must not see a key text `constantTexts` only holds because the render
  // minted it (e.g. a folded `typeof` result reaching here via a computed key).
  if (!ctx.staticKeyTexts.has(operation.key.value)) {
    if (representation.kind === 'native-handle' && emitComputedNativeHandleStore(ctx, lines, operation, label, receiverText)) return true
    if (!hostProtocol.strict) return false
  }
  const staticKey = staticKeyTextOf(ctx, operation.key, `a "${label}" operation on a "${protocol}" host handle`)
  const host = hostMemberOf(ctx.hosts.members, memberProtocol, staticKey)
  if (host === undefined && !hostProtocol.strict) return false
  if (host?.kind !== 'property' || host.store === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}.${staticKey}.write`,
      `writing "${protocol}.${staticKey}" is claimed by no host member table as a settable property, so there is no host symbol to assign through`
    )
  }
  const filled = fillHostTemplate(host.store, receiverText, [], null, operandText(ctx, operation.value))
  if (filled === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}.${staticKey}.write`,
      `the "${protocol}.${staticKey}" host store template names a slot this write cannot fill`
    )
  }
  lines.push(`${filled};`)
  // Threaded onward as the receiver, for the reason every other store branch
  // states: a store has no failure to report, and what a consumer reads next
  // is the object written into.
  if (operation.result) {
    // A store threads its receiver onward. When that receiver IS the host
    // object there is no value to name, and the result's own identity is
    // already stated by `emit-bindings.ts`'s `hostClassReadsOf`.
    if (!ctx.hostClassReads.has(operation.receiver.value)) lines.push(`${defineValue(ctx, operation.result)} = ${receiverText};`)
  }
  return true
}

/**
 * A COMPUTED key on a namespace-shaped native-handle (`Math`, and any other
 * classified intrinsic with no host C++ type of its own): `obj[name]` where
 * `name` is a runtime string or symbol.
 *
 * A host singleton has no runtime member table, so the dispatch is the static
 * one this compiler already owns -- the protocol's classified member list
 * (`intrinsicMembers`), each member's value spelled by
 * `intrinsicMemberValueOf` -- rendered as a name comparison chain. The result
 * is a `gea::Value` by construction and that is not the forbidden shortcut:
 * the checker itself types `Math[k]` with a runtime `k` as `any` (the union
 * of a number constant and forty function objects is a value whose static
 * type genuinely depends on the key), and only a `dynamic` destination is
 * rendered here; any other published carrier is refused by name.
 *
 * In front of the static chain sits `gea::detail::hostIntrinsicSidecar`, the
 * one per-protocol table a program can CHANGE at runtime -- the dynamic-
 * property sidecar every native type gets rather than a box (see
 * `gea::runtime::regex::Pattern`'s). A computed write to a writable member or
 * a fresh key lands there and shadows the static answer; a computed delete of
 * a configurable member marks it removed; a non-writable member ignores the
 * store and a non-configurable one refuses the delete, exactly as ECMA-262's
 * ordinary [[Set]]/[[Delete]] answer for the attributes the member has. What
 * the sidecar does NOT reach is a CONSTANT-key read (`Math.pow`), which
 * renders the host symbol directly: a program that writes `Math['pow'] = f`
 * through a runtime key and then calls `Math.pow` by name still calls the
 * host's. test262's `verifyProperty` restores what it writes and reads back
 * through the same computed path, so the two never disagree there.
 */
const namespaceIntrinsicMembersOf = (ctx: EmitContext, receiver: IrOperand) => {
  if (receiver.representation.kind !== 'native-handle' || receiver.representation.native !== null) return null
  return ctx.hosts.intrinsicMembers.get(receiver.representation.protocol) ?? null
}

const computedNativeHandleGetText = (
  ctx: EmitContext,
  receiver: IrOperand,
  key: IrOperand,
  result: IrResult | null,
  protocol: string,
  memberProtocol: string
): string | null => {
  const members = namespaceIntrinsicMembersOf(ctx, receiver)
  if (members === null) return null
  const site = `a computed "get" on a "${protocol}" host handle`
  if (result === null) {
    // Same subject as `nativeHostMemberText`'s own computed-key refusal above:
    // a computed `[[Get]]` on a native-handle receiver, keyed generically
    // rather than by member -- no member name survives a genuinely computed key.
    throw createCppEmitBlockedError('property-access:native-handle:get:true', `${site} publishes no value for its consumer to read`)
  }
  const arms = members
    .map(
      (member) =>
        `if (__gea_name == ${cppStringLiteral(member.name)}) return ${intrinsicMemberValueOf(ctx, memberProtocol, member, site).value};`
    )
    .join(' ')
  const read =
    `([&]() -> gea::Value { const gea::PropertyKey __gea_key = ${propertyKeyText(ctx, key, site)}; ` +
    `auto& __gea_side = gea::detail::hostIntrinsicSidecar(${cppStringLiteral(memberProtocol)}); ` +
    `if (__gea_side.hasOverride(__gea_key)) return __gea_side.get(__gea_key); if (__gea_side.isRemoved(__gea_key)) return gea::Value{}; ` +
    `if (!__gea_key.isSymbol()) { const std::string& __gea_name = __gea_key.text(); ${arms} } return gea::Value{}; })()`
  return unboxedReadText(result.representation, read, site)
}

const emitComputedNativeHandleStore = (
  ctx: EmitContext,
  lines: string[],
  operation: SetOperation | DefineOwnPropertyOperation,
  label: string,
  receiverText: string | null
): boolean => {
  const members = namespaceIntrinsicMembersOf(ctx, operation.receiver)
  if (members === null || operation.receiver.representation.kind !== 'native-handle') return false
  const { protocol } = operation.receiver.representation
  const site = `a computed "${label}" on a "${protocol}" host handle`
  // A non-writable member ignores the write (10.1.9.2 step 2.a, sloppy mode's
  // silent half); a writable one keeps its attributes through the override
  // (`setMember`); a key the table lacks becomes an ordinary property.
  const arms = members
    .map((member) => {
      const fixed = intrinsicMemberValueOf(ctx, protocol, member, site)
      const store = fixed.writable
        ? `__gea_side.setMember(__gea_key, __gea_written, true, ${String(fixed.enumerable)}, ${String(fixed.configurable)});`
        : ''
      return `if (__gea_name == ${cppStringLiteral(member.name)}) { ${store} return; }`
    })
    .join(' ')
  lines.push(
    `{ const gea::PropertyKey __gea_key = ${propertyKeyText(ctx, operation.key, site)}; ` +
      `auto& __gea_side = gea::detail::hostIntrinsicSidecar(${cppStringLiteral(protocol)}); ` +
      `const gea::Value __gea_written = ${boxedValueText(ctx, operation.value, site)}; ` +
      `[&]() { if (!__gea_key.isSymbol()) { const std::string& __gea_name = __gea_key.text(); ${arms} } __gea_side.set(__gea_key, __gea_written); }(); }`
  )
  if (operation.result) {
    // A store threads its receiver onward. When that receiver IS the host
    // object there is no value to name, and the result's own identity is
    // already stated by `emit-bindings.ts`'s `hostClassReadsOf`.
    if (!ctx.hostClassReads.has(operation.receiver.value)) lines.push(`${defineValue(ctx, operation.result)} = ${receiverText};`)
  }
  return true
}

/**
 * Every deferred host member read of one body, decided from settled facts
 * alone -- the census half of `nativeHostMemberText` and `declaredHostMethodRead`.
 *
 * This is the same question those two answer while they render, asked of the
 * IR before anything renders: which `get` publishes a value that is a host
 * METHOD reached but not materialised. Every input is settled -- the receiver's
 * carrier, the key's constant text, the unioned `HostSpellings`, and
 * `hostClassReads` -- so nothing here waits on a line being printed.
 *
 * This is the ONLY place the question is answered. `nativeHostMemberText` and
 * `declaredHostMethodRead` do not re-test it -- they ask this map and then
 * spell whichever answer it gave, which is what keeps one fact to one
 * authority rather than two implementations that happen to agree. The
 * call-site-arity carve-out is stated here for the same reason: it is part of
 * "is this read deferred", not part of how either answer is printed.
 *
 * What this does NOT reproduce is `emitGet`'s branch LADDER -- whether some
 * resolver AHEAD of `nativeHostMemberText` claims the same `get` first. That
 * was checked rather than assumed, once, during the move: the walk ran beside
 * the render-time map it replaced across both emitted sets (154 corpus + 281
 * runtime), and no read the printer recorded was missing or different, with
 * every one of the 1027 extras the `<value>:present` twin below. That was
 * migration evidence, not a standing guarantee -- the guarantee is that
 * nothing else decides any more.
 *
 * The one place the census must anticipate the ladder is the optional
 * receiver: `emitGet` unwraps `a?.b` and re-enters with the proven-present
 * view, so a read off an `optional` carrier records the `<value>:present`
 * operand `unwrapPresentValue` mints, not the optional itself. The twin is
 * stated unconditionally for the same reason `hostClassReadsOf` states its
 * own: if a value IS a deferred host member then so is the value proven
 * present, and the twin is not an SSA value any walk could otherwise observe.
 */
export const hostMemberReadsOf = (
  body: IrBody,
  hosts: HostSpellings,
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  hostClassReads: ReadonlyMap<IrValueId, unknown>,
  hostMethodAliases: ReadonlyMap<DeclarationId, HostMethodAlias>
): ReadonlyMap<IrValueId, HostMemberRead> => {
  const reads = new Map<IrValueId, HostMemberRead>()
  // A direct numeric host call consumes the spelling, not a callable value.
  // Defer its property read only when every use has that same property: a
  // first-class alias, reflected value, receiver or argument still materializes.
  const numericRestCallees = new Set<IrValueId>()
  const materializedUses = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'call' && operation.numericRestHostCall !== undefined) {
        numericRestCallees.add(operation.callee.value)
        if (operation.receiver) materializedUses.add(operation.receiver.value)
        for (const argument of operation.arguments) materializedUses.add(argument.value)
      } else {
        for (const operand of operandsOfIrOperation(operation)) materializedUses.add(operand.value)
      }
    }
  }
  for (const region of body.iteratorCloseRegions ?? []) materializedUses.add(region.iterator.value)
  for (const value of materializedUses) numericRestCallees.delete(value)
  const presentView = (receiver: IrOperand): IrOperand =>
    receiver.representation.kind === 'optional'
      ? { value: `${receiver.value}:present` as IrValueId, representation: receiver.representation.payload }
      : receiver
  const receiverOf = (receiver: IrOperand): IrOperand | null => (hostClassReads.has(receiver.value) ? null : presentView(receiver))
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'get') {
        const binding = operation.hostMethod
        if (binding !== undefined) {
          if (hostMemberOf(hosts.members, binding.protocol, binding.member)?.kind === 'method')
            reads.set(operation.result.id, { ...binding, receiver: receiverOf(operation.receiver) })
          continue
        }
        const receiver = presentView(operation.receiver)
        const hostProtocol = nativeHostProtocol(receiver)
        if (hostProtocol === null) continue
        const staticKey = staticKeyTexts.get(operation.key.value)
        if (staticKey === undefined) continue
        const memberProtocol = hostProtocol.protocol
        // `Math.hasOwnProperty` and friends are `Object.prototype`'s own, not
        // this protocol's, and `nativeHostMemberText` hands them to the
        // prototype channel before ever asking `hostMemberOf`.
        if (objectShapePrototypeMethods.has(staticKey) && hosts.intrinsicMembers.has(memberProtocol)) continue
        const host = hostMemberOf(hosts.members, memberProtocol, staticKey)
        const numericRest = host?.kind === 'property' && host.numericRestCall !== undefined && numericRestCallees.has(operation.result.id)
        if (host?.kind !== 'method' && !numericRest) continue
        // The one host method that is NOT deferred: a call-site-arity row read
        // bare into a `dynamic` destination has no native callable convention
        // to fuse with, and is boxed as a function value instead
        // (`dynamicHostFunctionValueText`). Declining it here is what lets the
        // printer ask this census which of the two spellings to render rather
        // than repeat the test.
        if (!callSiteHostReadIsDeferred(operation.result.representation) && host?.kind === 'method' && host.arity === 'call-site') continue
        reads.set(operation.result.id, {
          protocol: memberProtocol,
          member: staticKey,
          receiver: receiverOf(operation.receiver)
        })
      } else if (operation.kind === 'binding-read') {
        // A cell that holds one host method forever is read as that member.
        const alias = hostMethodAliases.get(operation.declaration)
        if (alias !== undefined) reads.set(operation.result.id, { ...alias, receiver: null })
      } else if (operation.kind === 'convert') {
        // Optional chaining narrows and widens the callee between its read,
        // its presence test and its call; the deferred invocation travels
        // through every one of those SSA views.
        const inherited = reads.get(operation.source.value)
        if (inherited !== undefined) reads.set(operation.result.id, inherited)
      }
    }
  }
  // The proven-present view of a deferred read is the same deferred read.
  for (const [value, read] of [...reads]) reads.set(`${value}:present` as IrValueId, read)
  return reads
}
