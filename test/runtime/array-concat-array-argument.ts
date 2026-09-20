// `Array.prototype.concat` with an ARRAY argument, which is the first
// overload's `ConcatArray<T>` rest element -- hono's `RegExpRouter`
// (`Object.keys(a).concat(Object.keys(b))`) and its trie router
// (`tempNodes.concat(shifted)`) both take it.
//! expect: a,b,c,d
//! expect: 1,2,3
//! expect: 4
class Cell {
  n: number
  constructor(n: number) {
    this.n = n
  }
}

const left: string[] = ['a', 'b']
const right: string[] = ['c', 'd']
console.log(left.concat(right).join(','))

const numbers: number[] = [1]
console.log(numbers.concat([2, 3]).join(','))

const cells: Cell[] = [new Cell(1), new Cell(3)]
const more: Cell[] = [new Cell(4)]
const all = cells.concat(more)
console.log(all[2]!.n)
