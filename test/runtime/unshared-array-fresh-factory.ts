//! expect: false 2 1 0 3 true
// `Array.from({ length }, () => [])` is typed `never[][]` (TypeScript infers the
// callback's `[]` as `never[]`) and enters a `Leaf[][]` binding: the outer
// array is the factory's own fresh result, held by nothing else, so it is
// rebuilt once at the binding's element carrier. Each inner `[]` is unshared
// too and becomes its own `Leaf[]` -- a class element carrier holds
// `undefined` natively, which `gea::emptyArraySentinelOrAbsent` decides at
// runtime exactly as `any[]` does.
class Leaf {
  constructor(public id: number) {}
}
const rows: Leaf[][] = Array.from({ length: 3 }, () => [])
rows[0]!.push(new Leaf(1), new Leaf(2))
rows[1]!.push(new Leaf(3))
const total = rows.reduce((sum, row) => sum + row.length, 0)
console.log(rows[0] === rows[1], rows[0]!.length, rows[1]!.length, rows[2]!.length, total, rows[0]![1]!.id === 2)
export {}
