// A literal array/object pattern used directly as a for-of loop's own head
// (`for ([a, b] of pairs)`, `for ({ x, y } of points)`) is a destructuring
// ASSIGNMENT the loop drives every iteration -- there is no `=` and no
// right-hand-side expression `a`/`b`/`x`/`y` ever appear in. `value-flow.ts`'s
// write index had no case for this shape, so a bare pre-declared `var`
// written only this way found no evidence and boxed; `local-bindings.ts`'s
// `forOfPatternElementTypeAt` derives the per-position/per-key type directly
// from the loop's own iterable instead of a literal source. Left deliberately
// unannotated below -- an explicit type would answer the census on its own
// and never exercise the write-attribution fix at all.

const pairs: [number, number][] = [
  [1, 2],
  [3, 4]
]
var sum = 0
var a, b
for ([a, b] of pairs) {
  sum += a + b
}
//! expect: 10
console.log(sum)

var points = [
  { x: 1, y: 2 },
  { x: 3, y: 4 }
]
var total = 0
var x, y
for ({ x, y } of points) {
  total += x + y
}
//! expect: 10
console.log(total)

const rows: [number, [number, number]][] = [
  [1, [2, 3]],
  [4, [5, 6]]
]
var nested = 0
var p, q, r
for ([p, [q, r]] of rows) {
  nested += p + q + r
}
//! expect: 21
console.log(nested)
