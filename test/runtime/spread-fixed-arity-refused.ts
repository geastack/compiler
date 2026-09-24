//! expect-refusal: a spread of a runtime-length array that fills named formals must be the last argument
//! expect-refusal: a spread argument whose source has a native iteration cursor can only be range-copied into a rest parameter
//
// The two spreads into NAMED formals that stay refused by name. A written
// argument after a runtime-length array lands at a position only the array's
// length knows, so `f(...xs, 9)` has no positional reading. A Set, a Map, a
// string or a generator has no index reads that equal its iteration (a string
// iterates code points, a generator runs user code per step), so a spread of
// one into named formals still needs the iteration itself.

function f(a?: number, b?: number, c?: number): string {
  return `${a}:${b}:${c}`
}
const xs: number[] = [1, 2]
const set = new Set<number>([1, 2])
// @ts-expect-error TS2556: the checker also refuses a spread that is not a tuple here.
console.log(f(...xs, 9))
// @ts-expect-error TS2556, as above.
console.log(f(...set))
