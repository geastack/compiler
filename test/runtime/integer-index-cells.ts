//! expect: picked=30
//! expect: summed=60
//! emitted-has: elementAtIndex(
//! emitted-lacks: ->elementAt(
// An array indexed by a `long long` -- a narrowed loop counter, a narrowed
// formal, a cell stepped from one -- reads through `elementAtIndex`, never
// through `elementAt(double)` and a round trip through floating point
// (`emit-context.ts`'s `isIntegerStorageValue`).
const pick = (values: number[], at: number): number => {
  let index = at
  index = index + 1
  return values[index] ?? 0
}
const sum = (values: number[]): number => {
  let total = 0
  for (let i = 0; i < values.length; i++) total += values[i] ?? 0
  return total
}
const values = [10, 20, 30]
console.log(`picked=${pick(values, 1)}`)
console.log(`summed=${sum(values)}`)
