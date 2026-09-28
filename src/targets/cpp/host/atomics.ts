import { representationKey, type RecordField, type Representation, type TypedArrayElementDomain } from '../../../representation/model.js'

/**
 * The complete Atomics surface the C++ backend can render. This is deliberately
 * representation-aware: the host-member table grants a syntactic member read,
 * while this authority decides whether that particular call has an emitter.
 * Preflight and emission consume this same predicate so neither can claim a
 * float or unsupported wait/notify call is available; the shared-buffer
 * requirements of `wait` and `notify` are the runtime's, checked as ECMA-262 states.
 *
 * A dynamic view is the one case ECMA-262 already decides at runtime:
 * ValidateIntegerTypedArray inspects the operand, and the box's payload type
 * names the view's element exactly (`gea::runtime::atomics::overIntegerView`).
 * A dynamic index or value is ToNumber'd at runtime, as ToIndex and
 * ToIntegerOrInfinity begin.
 */
export type AtomicsView = 'typed' | 'optional' | 'dynamic'

export type AtomicsCallSupport =
  | { readonly supported: true; readonly kind: 'is-lock-free'; readonly runtimeMember: null }
  | { readonly supported: true; readonly kind: 'fixed'; readonly runtimeMember: string; readonly view: AtomicsView }
  | { readonly supported: true; readonly kind: 'wait' | 'wait-async' | 'notify'; readonly runtimeMember: null; readonly view: AtomicsView }
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
    if (!isNumber(arguments_[position]) && arguments_[position]?.kind !== 'dynamic') {
      return { supported: false, reason: `Atomics.${member} argument ${position + 1} must be a numeric or dynamic carrier` }
    }
  }
  return null
}

/**
 * What the native operation hands back -- a Number from every integer view
 * (no BigInt view has a native carrier), the `wait` outcome string, the
 * `isLockFree` boolean -- must be what the call's result holds, or a box of
 * it. A result the checker typed `bigint` is an overload chosen blind, and
 * converting the Number into it would change `typeof` and every comparison.
 */
const resultRefusal = (member: string, produced: Representation['kind'], result: Representation | null): AtomicsCallSupport | null => {
  if (result === null || result.kind === 'dynamic' || result.kind === 'undefined') return null
  if (result.kind === produced && (result.kind !== 'scalar' || result.domain === (member === 'isLockFree' ? 'boolean' : 'number')))
    return null
  return {
    supported: false,
    reason: `Atomics.${member} produces a ${member === 'wait' ? 'string' : member === 'isLockFree' ? 'boolean' : 'Number'}, not ${result.kind === 'scalar' ? result.domain : result.kind}`
  }
}

/** One arm of `waitAsync`'s typed result: the union index and the record it holds. */
export interface WaitAsyncArm {
  readonly index: number
  readonly record: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
}

/**
 * `waitAsync`'s result as lib.es2024.sharedmemory states it --
 * `{ async: false; value: "not-equal" | "timed-out" } | { async: true; value:
 * Promise<"ok" | "timed-out"> }` -- laid out as a union of two shared records:
 * the arm whose `value` is a string (the outcome it did not wait for) and the
 * arm whose `value` is a promise of one. `null` for any other layout, which a
 * box holds instead.
 */
export const waitAsyncResultArmsOf = (
  result: Representation | null,
  fieldOf: (record: Representation, name: string) => RecordField | null
): { readonly immediate: WaitAsyncArm; readonly pending: WaitAsyncArm } | null => {
  if (result?.kind !== 'tagged-union' || result.arms.length !== 2) return null
  const arms = result.arms.map((arm, index) => {
    const record = arm.value
    if (
      (record.kind !== 'record' && !(record.kind === 'native-record-ref' && record.native === null)) ||
      record.ownership !== 'shared-refcount'
    )
      return null
    const flag = fieldOf(record, 'async')
    const value = fieldOf(record, 'value')
    if (!flag?.required || flag.value.kind !== 'scalar' || flag.value.domain !== 'boolean' || !value?.required) return null
    const shape =
      value.value.kind === 'string' ? 'immediate' : value.value.kind === 'promise' && value.value.value.kind === 'string' ? 'pending' : null
    return shape === null ? null : { shape, arm: { index, record } }
  })
  const immediate = arms.find((arm) => arm?.shape === 'immediate')?.arm
  const pending = arms.find((arm) => arm?.shape === 'pending')?.arm
  return immediate && pending ? { immediate, pending } : null
}

export const atomicsCallSupport = (
  member: string,
  arguments_: readonly Representation[],
  result: Representation | null,
  fieldOf: (record: Representation, name: string) => RecordField | null
): AtomicsCallSupport => {
  const support = argumentSupport(member, arguments_)
  if (!support.supported) return support
  // `waitAsync`'s result is an ordinary object of two properties: a box, the
  // typed union of its two shapes, or a result nothing reads.
  if (member === 'waitAsync')
    return result === null || result.kind === 'dynamic' || result.kind === 'undefined' || waitAsyncResultArmsOf(result, fieldOf) !== null
      ? support
      : {
          supported: false,
          reason: `Atomics.waitAsync produces a { async, value } object, which ${representationKey(result)} does not lay out`
        }
  return resultRefusal(member, member === 'wait' ? 'string' : 'scalar', result) ?? support
}

const argumentSupport = (member: string, arguments_: readonly Representation[]): AtomicsCallSupport => {
  if (member === 'isLockFree') {
    if (arguments_.length !== 1) return { supported: false, reason: 'Atomics.isLockFree takes exactly one size argument' }
    return isNumber(arguments_[0])
      ? { supported: true, kind: 'is-lock-free', runtimeMember: null }
      : { supported: false, reason: 'Atomics.isLockFree argument 1 must be a statically numeric carrier' }
  }

  const held = arguments_[0]
  const fixed = fixedMembers.get(member)
  if (!fixed && member !== 'wait' && member !== 'waitAsync' && member !== 'notify')
    return { supported: false, reason: `Atomics.${member} is not implemented` }
  if (held?.kind === 'dynamic') return arityAndArguments(member, arguments_, 'dynamic')
  // A possibly-absent view is the view once present: ValidateIntegerTypedArray
  // throws a TypeError for `undefined` before the operation reads anything.
  const view = held?.kind === 'optional' ? held.payload : held
  if (view?.kind !== 'typed-array') {
    return { supported: false, reason: `Atomics.${member} requires a typed-array or dynamic carrier` }
  }
  if (!integerElements.has(view.element)) {
    return {
      supported: false,
      reason: `Atomics.${member} requires an integer Number typed array; ${view.element} is refused (BigInt arrays have no native BigInt carrier)`
    }
  }

  if (!fixed && view.element !== 'int32') {
    return { supported: false, reason: `Atomics.${member} is available only for Int32Array; BigInt64Array is deliberately unsupported` }
  }
  return arityAndArguments(member, arguments_, held?.kind === 'optional' ? 'optional' : 'typed')
}

const arityAndArguments = (member: string, arguments_: readonly Representation[], view: AtomicsView): AtomicsCallSupport => {
  const fixed = fixedMembers.get(member)
  if (fixed) {
    if (arguments_.length !== fixed[0]) return { supported: false, reason: `Atomics.${member} takes exactly ${fixed[0]} arguments` }
    return numberedArguments(member, arguments_, fixed[0]) ?? { supported: true, kind: 'fixed', runtimeMember: fixed[1], view }
  }
  const count = arguments_.length
  if ((member === 'wait' || member === 'waitAsync') && (count < 3 || count > 4))
    return { supported: false, reason: `Atomics.${member} takes three or four arguments` }
  if (member === 'notify' && (count < 2 || count > 3)) return { supported: false, reason: 'Atomics.notify takes two or three arguments' }
  const kind = member === 'wait' ? 'wait' : member === 'waitAsync' ? 'wait-async' : 'notify'
  return numberedArguments(member, arguments_, count) ?? { supported: true, kind, runtimeMember: null, view }
}
