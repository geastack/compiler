import type { HostMember, HostMemberTable } from './host-members.js'
import { errorConstructorNames } from '../error-types.js'
import { hostInvocations, hostMemberRenderers } from './emit-host-invoke.js'
import { cppKeyedCollectionConstructorProtocols } from '../emit-callable.js'
import { cppBinaryBufferFamilyConstructorProtocols } from '../emit-buffers.js'

/**
 * The host protocols this backend has a real runtime half for, keyed
 * `${protocol}@${version}` exactly as `preflight/run.ts`'s
 * `buildNativeBoundaryObligation` censuses them and `ir/certify.ts`'s
 * `nativeBoundaryDemand` demands them.
 *
 * COMPUTED, not hand-listed (its own row
 * for this table: "hand-written `nativeProtocols`" is one of the things that
 * table names as work still owed). A hand list drifts from the emitter the
 * moment either changes: a row claimed before the emitter renders it turns a
 * certification pass into a print-time refusal, and a row the emitter renders
 * but the list omits refuses a program this backend could actually compile.
 * `cppNativeProtocolsOf` below reads the same tables the emitter itself
 * consults to decide whether it CAN render a protocol, so a row here is
 * proof, not a claim.
 *
 * Scoped to this backend's OWN, plugin-independent surface -- `Math`, `Date`,
 * `JSON`, the seven error constructors, and the rest of ECMA-262's ambient
 * globals this compiler implements itself. An installed host's OWN protocols
 * (`document`, AppKit's views, ...) are never claimed here: `compiler.ts`
 * unions `plugin.capabilities.nativeProtocols` into the compiled manifest
 * separately, so a plugin table folded into this derivation would double-claim
 * nothing new but a plugin's PROTOCOL COLLIDING with a name a future core table
 * happens to add would be undetectable drift between two authorities over one
 * name -- the exact failure mode this whole derivation exists to remove.
 */

/** The protocol half of a `HostMemberTable` key (`Protocol.member`) -- the same split `hostMemberOf` builds the key from, run in reverse. */
const protocolPrefixOf = (key: string): string => {
  const dot = key.indexOf('.')
  return dot < 0 ? key : key.slice(0, dot)
}

/**
 * The protocol a `property` row's own EMITTED TEXT names, when that text is a
 * `gea::NativeHandle<gea_native_protocol_<Name>_prototype_v1>{}` literal --
 * the "constructor's `prototype` slot read as a value" shape `DateConstructor
 * .prototype`, `StringConstructor.prototype`, `NumberConstructor.prototype`,
 * `RegExpConstructor.prototype`, `BooleanConstructor.prototype` and
 * `ObjectConstructor.prototype` all share (`host-members.ts`).
 *
 * Those six rows are filed under THEIR OWN constructor's protocol
 * (`protocolPrefixOf` already adds `DateConstructor@1` for the first one), but
 * the VALUE they hand back is a handle of a DIFFERENT, namespace-shaped
 * protocol (`Date.prototype@1`) that reflection (`hostPrototypeMethodValueText`,
 * `emit-host-value.ts`) answers over -- so the key's own protocol prefix
 * cannot name it; only the text the row renders can, and this is the honest
 * way to read that: from the same emitted string `gea_runtime.h`'s matching
 * `struct gea_native_protocol_<Name>_prototype_v1 {};` tag was named for,
 * never re-typed as a sixth list.
 *
 * Scanned by hand rather than matched with a `RegExp`, which is forbidden
 * under this directory (`scripts/architecture.mjs`): the shape is fixed and
 * exact -- one literal prefix, one literal suffix -- so a plain substring
 * search finds it without inviting the ambiguity a general pattern would.
 */
const embeddedPrototypeProtocolOf = (emit: string): string | null => {
  const prefix = 'gea_native_protocol_'
  const suffix = '_prototype_v1'
  const nameStart = emit.indexOf(prefix)
  if (nameStart < 0) return null
  const start = nameStart + prefix.length
  const end = emit.indexOf(suffix, start)
  if (end < 0) return null
  return `${emit.slice(start, end)}.prototype`
}

/**
 * Protocol claims this pass could not find a table for anywhere in
 * `src/targets/cpp` -- not `coreHostMembers`, not `hostInvocations` or
 * `hostMemberRenderers`, not the keyed-collection or binary-buffer family's
 * own exported name tables, not the six embedded `.prototype` tags. Kept
 * rather than dropped: dropping one narrows what this backend admits, and
 * neither claim below has been proven WRONG, only unproven -- see each row's
 * own comment for exactly what was searched and why it came up empty.
 *
 * "Hand-claimed" on purpose, in the singular this file now avoids everywhere
 * else: this is the honest residue the single-census invariants
 * expects a computed table to still have, not a second copy of the table this
 * module replaces.
 */
export const handClaimedProtocols: ReadonlySet<string> = new Set<string>([
  // ECMA-262 23.2.5.1's ninth and tenth TypedArray constructors. They never
  // reach a `typed-array` result: `TypedArrayElementDomain`
  // (representation/model.ts) has no `bigint64`/`biguint64` domain -- a
  // 64-bit integer element read through this backend's `double`-based
  // `elementAt`/`setElement` would silently lose precision above 2^53, which
  // is exactly what these two typed arrays exist to prevent -- so `derive.ts`
  // gives an instance of either no typed-array carrier at all, and
  // `emit-callable.ts`'s `emitConstruct` never special-cases one:
  // construction falls through to the generic `!callee.construct` refusal,
  // which is the correct, honest answer.
  //
  // The claim exists only so a program that merely NAMES the global
  // (`typeof BigInt64Array !== "undefined"`, which lib.d.ts declares
  // unconditionally and every test262 typed-array harness file pastes into
  // every test) binds without a native-boundary refusal for a value nothing
  // ever calls through. No table in this directory states that, because no
  // renderer answers for it -- the claim is exactly as wide as "the value
  // exists" and no wider.
  'BigInt64ArrayConstructor@1',
  'BigUint64ArrayConstructor@1',
  // Bare `Uint8Array`, distinct from the already-derived
  // `Uint8ArrayConstructor@1`: that one is the AMBIENT VALUE's protocol (the
  // checker's own `Uint8ArrayConstructor` type, bound wherever the global
  // `Uint8Array` is read and constructed through), and it is fully derived
  // above from `coreHostMembers`'s `Uint8ArrayConstructor.from` row. This is
  // the INSTANCE interface's own name instead, and the instance interfaces
  // (`Int8Array` .. `Float64Array`) derive a `typed-array` PHYSICAL carrier
  // directly (`typedArrayInstanceDomains`, `semantics/host-protocols.ts`) --
  // which needs no native-boundary claim at all, since `typed-array` is not a
  // `native-handle`. That makes a bare `Uint8Array@1` doubly unexplained: no
  // table in this directory names it, and the ordinary route that would need
  // it does not go through `native-handle` in the first place. Kept exactly
  // as the pre-derivation hand list had it, as a claim this pass could not
  // justify but also could not disprove -- and `native-boundary` is a `.has()`
  // gate, so an unreached claim costs nothing and an under-claimed one would
  // refuse a program that used to certify.
  'Uint8Array@1'
])

/**
 * Every native-boundary protocol this backend's OWN tables back with a real
 * renderer, `${protocol}@1` -- every row here is version 1, the only version
 * any `HostProtocolBinding` this compiler produces ever states
 * (`semantics/host-protocols.ts`).
 *
 * Five sources, each a table the emitter genuinely dispatches through:
 *
 * 1. `members` (`coreHostMembers`, passed in): every key's own protocol
 *    prefix. This is the bulk of the set -- `Math`, `Atomics`, `Console`,
 *    `Storage`, `JSON`, the constructors with real member templates, and the
 *    nine TypedArray constructors' `.from` rows.
 * 2. The same table's `property` rows whose emitted text is itself a
 *    DIFFERENT protocol's `NativeHandle` literal -- the six
 *    `X.prototype@1` sidecars `embeddedPrototypeProtocolOf` reads.
 * 3. `hostInvocations`/`hostMemberRenderers` (`emit-host-invoke.ts`): these
 *    ARE the emitter's own dispatch tables for a handle invoked directly or a
 *    member spelled at the call site, so their keys are protocols with code
 *    behind them by construction.
 * 4. `errorConstructorNames` (`error-types.ts`): the seven NativeError
 *    protocols `renderErrorCreate` reads the intrinsic's runtime name from.
 * 5. The keyed-collection and binary-buffer family's own exported name
 *    tables (`emit-callable.ts`, `emit-buffers.ts`): both dispatch
 *    structurally, off the CONSTRUCT RESULT's carrier kind rather than the
 *    callee's protocol name, so there is no table row for either family to
 *    scan -- only the renderer's own documented name list, exported for
 *    exactly this reading.
 *
 * Plus `handClaimedProtocols`, the honest residue above.
 */
export const cppNativeProtocolsOf = (members: HostMemberTable): ReadonlySet<string> => {
  const names = new Set<string>()
  const rememberPrototypeSidecar = (member: HostMember): void => {
    if (member.kind !== 'property' || member.emit === null) return
    const embedded = embeddedPrototypeProtocolOf(member.emit)
    if (embedded !== null) names.add(embedded)
  }
  for (const [key, member] of members) {
    names.add(protocolPrefixOf(key))
    rememberPrototypeSidecar(member)
  }
  for (const protocol of hostInvocations.keys()) names.add(protocol)
  for (const protocol of hostMemberRenderers.keys()) names.add(protocol)
  for (const protocol of errorConstructorNames.keys()) names.add(protocol)
  for (const protocol of cppKeyedCollectionConstructorProtocols) names.add(protocol)
  for (const protocol of cppBinaryBufferFamilyConstructorProtocols) names.add(protocol)

  const versioned = new Set<string>()
  for (const name of names) versioned.add(`${name}@1`)
  for (const claim of handClaimedProtocols) versioned.add(claim)
  return versioned
}
