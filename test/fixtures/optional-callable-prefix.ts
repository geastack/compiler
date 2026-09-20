/**
 * A shorter callable returned where a LONGER one, optionally absent, is
 * expected -- three's `getSingularSetter`, whose `switch` returns
 * `setValueV1f( gl, v )` and `setValueT1( gl, v, textures )` alike and whose
 * fall-through makes the slot optional.
 *
 * Two conversions meet here: `gea::CallableObject`'s prefix-dropping
 * constructor and `gea::Optional<T>`'s converting one. C++ allows one
 * user-defined conversion per implicit sequence, so the emitted store has to
 * name the payload type explicitly; a fixture that only compiled would not
 * show that the dropped third argument is actually dropped, which is why this
 * one runs and prints.
 */
type Setter = (a: number, b: number, c: number) => void

let sum = 0

function takesTwo(a: number, b: number): void {
  sum = a + b
}

function takesThree(a: number, b: number, c: number): void {
  sum = a + b + c
}

function pick(kind: number): Setter | undefined {
  if (kind === 1) return takesTwo
  if (kind === 2) return takesThree
  return undefined
}

const short = pick(1)
if (short) short(2, 3, 4)
const shortResult = sum
const long = pick(2)
if (long) long(2, 3, 4)
console.log(`${shortResult},${sum},${pick(3) === undefined}`)
