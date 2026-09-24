//! expect-refusal: a spread of a runtime-length array that fills named formals must be the last argument
//! expect-refusal: a spread argument whose source has a native iteration cursor can only be range-copied into a rest parameter
//! expect-refusal: a typed-array spread whose values reach a rest parameter needs a range copy out of a typed array
//
// The two spreads into NAMED formals that stay refused by name. A written
// argument after a runtime-length array lands at a position only the array's
// length knows, so `f(...xs, 9)` has no positional reading. A Set, a Map, a
// string or a generator has no index reads that equal its iteration (a string
// iterates code points, a generator runs user code per step), so a spread of
// one into named formals still needs the iteration itself. A typed array fills
// named formals by index, but the values past them would have to be copied out
// of the typed array into the rest Array, which the rest pack cannot do yet.

function f(a?: number, b?: number, c?: number): string {
  return `${a}:${b}:${c}`
}
const xs: number[] = [1, 2]
const set = new Set<number>([1, 2])
console.log(f(...xs, 9))
console.log(f(...set))
function h(head?: number | string, ...tail: number[]): string {
  return `${head}|${tail.join(',')}`
}
console.log(h(...new Uint8Array([1, 2, 3])))
