// @ts-nocheck
//! expect: pop true
//! expect: shift true
//! expect: push true
//! expect: unshift true
//! expect: sanity 4 1,2,3,4 4 1,2,3 1 2,3 3 0,2,3 0 0 0 0

/**
 * `Array.prototype.pop/shift/push/unshift`, called with the fewest arguments
 * that make them a no-op (an empty receiver for `pop`/`shift`, zero arguments
 * for `push`/`unshift`), still run the spec's `Set(O, "length", len, true)`
 * step -- a no-op value-wise, but `Set` with `Throw` true still raises
 * `TypeError` when the receiver is frozen. Each of the four native
 * implementations in `gea_runtime.h` used to return before that check ran on
 * exactly this no-op path (`pop`/`shift`'s early-empty return skipped
 * `requireMutable()` entirely; `push`'s fold expression over zero arguments
 * called `receiver->push(...)`, where the check lives, zero times). test262
 * carries this exact shape once per method:
 * `built-ins/Array/prototype/{pop,shift,push,unshift}/set-length-zero-array-is-frozen.js`.
 *
 * `unshift()` with zero arguments additionally failed to COMPILE at all,
 * independent of frozen state: its local `Cell incoming[]` array, built from
 * the argument pack, is a zero-length C array at zero arguments, which is not
 * a valid type (`std::begin`/`std::end` have no overtake for one).
 */

function throwsTypeError(label: string, run: () => void) {
  try {
    run()
    console.log(label, false)
  } catch (e) {
    console.log(label, e instanceof TypeError)
  }
}

throwsTypeError('pop', () => {
  const a: number[] = []
  Object.freeze(a)
  a.pop()
})

throwsTypeError('shift', () => {
  const a: number[] = []
  Object.freeze(a)
  a.shift()
})

throwsTypeError('push', () => {
  const a: number[] = []
  Object.freeze(a)
  a.push()
})

throwsTypeError('unshift', () => {
  const a: number[] = []
  Object.freeze(a)
  a.unshift()
})

// The ordinary (non-frozen) behaviour of all four must be unaffected --
// including the zero-argument `push()`/`unshift()` shapes that used to
// misbehave (a compile error for `unshift()`, an unchecked skip for `push()`).
const a = [1, 2, 3]
const pushed = a.push(4)
const afterPush = a.join(',')
const popped = a.pop()
const afterPop = a.join(',')
const shifted = a.shift()
const afterShift = a.join(',')
const unshifted = a.unshift(0)
const afterUnshift = a.join(',')
const b: number[] = []
const unshiftedEmpty = b.unshift()
const lengthAfterUnshiftEmpty = b.length
const pushedEmpty = b.push()
const lengthAfterPushEmpty = b.length
console.log(
  'sanity',
  pushed,
  afterPush,
  popped,
  afterPop,
  shifted,
  afterShift,
  unshifted,
  afterUnshift,
  unshiftedEmpty,
  lengthAfterUnshiftEmpty,
  pushedEmpty,
  lengthAfterPushEmpty
)
