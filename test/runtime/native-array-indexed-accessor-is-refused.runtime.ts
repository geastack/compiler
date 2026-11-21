// `runsNoOtherCode` (ir/hoist.ts) counts a numeric-index store into a native
// `array-object` as running no program code, and a loop made only of such
// stores may read its bound once, before the loop. That is sound only while a
// native array cannot hold an indexed accessor: a setter on "0" that writes
// the bound would run on the first store, and a hoisted bound would keep the
// old count -- this program prints "turns 3" and would print "turns 6".
//
// So the definition itself has to stay refused. If native arrays ever learn
// to carry accessors, this test fails first, and the hoist has to learn to
// tell an accessor-capable array from a plain one in the same change.
// (A typed array needs no such pin: 10.4.5.3 [[DefineOwnProperty]] rejects an
// accessor descriptor on an integer index.)
let limit = 6
const arr: number[] = [0, 0, 0, 0, 0, 0]
Object.defineProperty(arr, '0', {
  set(_value: number) {
    limit = 3
  },
  get() {
    return 0
  }
})
// A function in the body is what made its loops closure-creating.
function current(): number {
  return limit
}
let turns = 0
for (let i = 0; i < limit; i++) {
  arr[i] = i
  turns++
}
console.log(`turns ${turns} ${current()}`)

//! expect-refusal: "Object.defineProperty" of a "array-object(
export {}
