import type { Representation } from './model.js'

/**
 * The host templates whose native frame the IR states
 * (`ir/call-entry.ts`'s `hostTemplateFrameOf`), and the one authority for when
 * the printer spells a call from one of them and what each accepts.
 *
 * Every predicate here has exactly two kinds of caller: the C++ printer, which
 * routes a call to the template and renders it (`emit-host-properties.ts`'s
 * `hostMemberReadsOf`, `emit-host-invoke.ts`'s `isArrayText`,
 * `emit-host-object.ts`'s `objectMemberText`, `emit-buffers.ts`'s
 * `typedArrayCallText`), and the IR, which records the template on the call
 * (`ir/lower-invocation.ts`) and states its frame. A rule that lived on only
 * one side could drift from the other, and the frame would then describe C++
 * the printer no longer emits.
 */
export type HostTemplate = 'object-assign' | 'array-is-array' | 'typed-array-set'

/**
 * The host protocol a member read off this receiver is looked up on, or `null`.
 *
 * A non-null native name can only enter a `native-record-ref` through the
 * declaration-authenticated host-type seam. The compiler does not lay that
 * record out, so a host member table is the only authority allowed to spell
 * one of its properties.
 */
export const hostReceiverProtocolOf = (representation: Representation): { readonly protocol: string; readonly strict: boolean } | null => {
  if (representation.kind === 'native-handle') return { protocol: representation.native ?? representation.protocol, strict: true }
  if (representation.kind === 'native-record-ref' && representation.native !== null)
    return { protocol: representation.native, strict: false }
  return null
}

/**
 * Whether a host method read whose row is spelled at the call site is deferred
 * to that call. A read held `dynamic` has no native convention to fuse with and
 * is boxed as a function value instead (`dynamicHostFunctionValueText`).
 */
export const callSiteHostReadIsDeferred = (read: Representation): boolean => read.kind !== 'dynamic'

/** The template a deferred host member's call is spelled from, for the members this file names. */
export const hostMemberTemplateOf = (protocol: string, member: string): HostTemplate | null =>
  protocol === 'ArrayConstructor' && member === 'isArray'
    ? 'array-is-array'
    : protocol === 'ObjectConstructor' && member === 'assign'
      ? 'object-assign'
      : null

/** A union whose every arm is a typed array: one `%TypedArray%.prototype` receiver whose arm the invoker dispatches. */
export const typedArrayUnionOnly = (representation: Representation): boolean =>
  representation.kind === 'tagged-union' && representation.arms.every((arm) => arm.value.kind === 'typed-array')

/** The template a deferred `%TypedArray%.prototype` member's call is spelled from, for the members this file names. */
export const typedArrayMemberTemplateOf = (member: string): HostTemplate | null => (member === 'set' ? 'typed-array-set' : null)

/**
 * Which template here prints a call through `member` read off `receiver`, the
 * read itself held as `read`; `null` for every other call.
 *
 * The receiver is the read's proven-present view, as both deferral walks take
 * it: an `optional` receiver's payload.
 */
export const hostTemplateOfRead = (receiver: Representation, member: string, read: Representation): HostTemplate | null => {
  const present = receiver.kind === 'optional' ? receiver.payload : receiver
  const host = hostReceiverProtocolOf(present)
  if (host !== null) return callSiteHostReadIsDeferred(read) ? hostMemberTemplateOf(host.protocol, member) : null
  return present.kind === 'typed-array' || typedArrayUnionOnly(present) ? typedArrayMemberTemplateOf(member) : null
}

/** The kinds `Array.isArray` answers `false` for from the kind alone: each states it is not an Array exotic object. */
const notArrayKinds: ReadonlySet<Representation['kind']> = new Set<Representation['kind']>([
  'record',
  'record-with-index',
  'dictionary',
  'class-ref',
  'native-record-ref',
  'native-handle',
  'keyed-collection',
  'dense-buffer',
  'typed-array',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'promise',
  'scalar',
  'string',
  'symbol',
  'null',
  'undefined',
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch'
])

/**
 * What `Array.isArray` -- ECMA-262 23.1.2.2 -- answers for a carrier of this
 * kind from the kind alone, or `null` for a kind that states neither that it is
 * an Array nor that it cannot be one (`dynamic`, whose box carries the answer,
 * and the wrappers `optional`/`tagged-union`, answered per state and per arm).
 *
 * `false` is stated by KIND rather than as a default, so a carrier nobody has
 * thought about refuses instead of being answered wrongly. A typed array is
 * one of the `false`s on purpose: a `Uint8Array` is not an Array exotic object.
 */
export const isArrayConstantOf = (kind: Representation['kind']): boolean | null =>
  kind === 'array-object' ? true : notArrayKinds.has(kind) ? false : null

/**
 * A single `%TypedArray%.prototype.set` source: a typed array, read through its
 * own element type, or an Array of numbers, whose holes read as `undefined`
 * (ECMA-262 23.2.3.26 steps 5 and 6). `null` for anything else.
 */
export const typedArraySetSourceOf = (carrier: Representation): 'typed-array' | 'number-array' | null =>
  carrier.kind === 'typed-array'
    ? 'typed-array'
    : carrier.kind === 'array-object' && carrier.element.kind === 'scalar' && carrier.element.domain === 'number'
      ? 'number-array'
      : null

/** Whether `set` copies from this source: a single source, or a union whose every arm is one. */
export const typedArraySetSourceAccepted = (carrier: Representation): boolean =>
  typedArraySetSourceOf(carrier) !== null ||
  (carrier.kind === 'tagged-union' && carrier.arms.every((arm) => typedArraySetSourceOf(arm.value) !== null))
