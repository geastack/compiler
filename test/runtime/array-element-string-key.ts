// `for (const i in array)` binds a STRING key, and hono's RegExp router
// indexes straight back with it: `handlerMap[i] = handlerData[indexReplacementMap[i]]`
// over a SPARSE replacement map, which is exactly why the loop is a `for`-`in`
// and not a counted one. Both directions needed a CanonicalNumericIndexString
// conversion in front of the ordinary element access; neither had one.
//! expect: 2:30
//! expect: 5:90
//! expect: sum 120
const sparse: number[] = []
sparse[2] = 30
sparse[5] = 90

const copied: number[] = []
let sum = 0
for (const key in sparse) {
  copied[key] = sparse[key]!
  console.log(`${key}:${sparse[key]!}`)
  sum += copied[key]!
}
console.log(`sum ${sum}`)
