//! expect: false 2 1 0 1 0
// `rows.map(() => [])` is the same fresh-array case as `Array.from({ length },
// () => [])`: the map's result is consumed where it is converted to `E[][]`, so
// every inner `never[]` is its own array, and a push into one row stays there.
interface Item {
  id: number
}
const rows = ['a', 'b', 'c']
const lists: Item[][] = rows.map(() => [])
lists[0]!.push({ id: 1 }, { id: 2 })
lists[1]!.push({ id: 3 })
const boxed: any[][] = rows.slice(0, 2).map(() => [])
boxed[1]!.push(1)
console.log(lists[0] === lists[1], lists[0]!.length, lists[1]!.length, lists[2]!.length, boxed[1]!.length, boxed[0]!.length)
