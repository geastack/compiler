//! expect: false 2 1 1 0
// A `[]` that no one else holds is a fresh array in JS, even when it is typed
// `never[]` and converted to `E[]`: each `() => []` call yields its own. Only a
// shared `never[]` (see never-array-sentinel.ts) keeps one identity per type.
interface Item {
  id: number
}
const lists: Item[][] = Array.from({ length: 3 }, () => [])
lists[0]!.push({ id: 1 }, { id: 2 })
lists[1]!.push({ id: 3 })
const boxed: any[][] = Array.from({ length: 2 }, () => [])
boxed[0]!.push(1)
console.log(lists[0] === lists[1], lists[0]!.length, lists[1]!.length, boxed[0]!.length, boxed[1]!.length)
