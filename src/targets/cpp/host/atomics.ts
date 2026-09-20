import type { Representation, TypedArrayElementDomain } from '../../../representation/model.js'

/**
 * The complete Atomics surface the C++ backend can render. This is deliberately
 * representation-aware: the host-member table grants a syntactic member read,
 * while this authority decides whether that particular call has an emitter.
 * Preflight and emission consume this same predicate so neither can claim a
 * dynamic, non-shared, float, or unsupported wait/notify call is available.
 */
export type AtomicsCallSupport =
  | { readonly supported: true; readonly kind: 'is-lock-free'; readonly runtimeMember: null }
  | { readonly supported: true; readonly kind: 'fixed'; readonly runtimeMember: string }
  | { readonly supported: true; readonly kind: 'wait' | 'notify'; readonly runtimeMember: null }
  | { readonly supported: false; readonly reason: string }

const integerElements: ReadonlySet<TypedArrayElementDomain> = new Set(['int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32'])

const fixedMembers: ReadonlyMap<string, readonly [number, string]> = new Map([
  ['load', [2, 'load']],
  ['store', [3, 'store']],
  ['add', [3, 'add']],
  ['sub', [3, 'sub']],
  ['and', [3, 'bitAnd']],
  ['or', [3, 'bitOr']],
  ['xor', [3, 'bitXor']],
  ['exchange', [3, 'exchange']],
  ['compareExchange', [4, 'compareExchange']]
])

const isNumber = (representation: Representation | undefined): boolean =>
  representation?.kind === 'scalar' && representation.domain === 'number'

const numberedArguments = (member: string, arguments_: readonly Representation[], count: number): AtomicsCallSupport | null => {
  for (let position = 1; position < count; position += 1) {
    if (!isNumber(arguments_[position])) {
      return { supported: false, reason: `Atomics.${member} argument ${position + 1} must be a statically numeric carrier` }
    }
  }
  return null
}

export const atomicsCallSupport = (member: string, arguments_: readonly Representation[]): AtomicsCallSupport => {
  if (member === 'isLockFree') {
    if (arguments_.length !== 1) return { supported: false, reason: 'Atomics.isLockFree takes exactly one size argument' }
    return isNumber(arguments_[0])
      ? { supported: true, kind: 'is-lock-free', runtimeMember: null }
      : { supported: false, reason: 'Atomics.isLockFree argument 1 must be a statically numeric carrier' }
  }

  const view = arguments_[0]
  if (view?.kind !== 'typed-array') {
    return { supported: false, reason: `Atomics.${member} requires a concrete typed-array carrier, never an any/dynamic value` }
  }
  if (!integerElements.has(view.element)) {
    return {
      supported: false,
      reason: `Atomics.${member} requires an integer Number typed array; ${view.element} is refused (BigInt arrays have no native BigInt carrier)`
    }
  }
  if (view.buffer !== 'shared-array-buffer') {
    return {
      supported: false,
      reason: `Atomics.${member} requires a SharedArrayBuffer-backed view; this ${view.element} view is backed by ArrayBuffer`
    }
  }

  const fixed = fixedMembers.get(member)
  if (fixed) {
    if (arguments_.length !== fixed[0]) return { supported: false, reason: `Atomics.${member} takes exactly ${fixed[0]} arguments` }
    return numberedArguments(member, arguments_, fixed[0]) ?? { supported: true, kind: 'fixed', runtimeMember: fixed[1] }
  }
  if (member !== 'wait' && member !== 'notify') return { supported: false, reason: `Atomics.${member} is not implemented` }
  if (view.element !== 'int32') {
    return { supported: false, reason: `Atomics.${member} is available only for Int32Array; BigInt64Array is deliberately unsupported` }
  }
  const count = arguments_.length
  if (member === 'wait' && (count < 3 || count > 4)) return { supported: false, reason: 'Atomics.wait takes three or four arguments' }
  if (member === 'notify' && (count < 2 || count > 3)) return { supported: false, reason: 'Atomics.notify takes two or three arguments' }
  return numberedArguments(member, arguments_, count) ?? { supported: true, kind: member, runtimeMember: null }
}
