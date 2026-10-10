// ECMA-262 23.1.2.1 Array.from: a source with an @@iterator is walked through
// it, and a mapfn is called with (value, index) per step. A database client
// maps a Set<Cursor> through `Array.from(set, c => c.close())` and copies its
// own linked `List<T>` (a class whose `[Symbol.iterator]` is a generator) with
// `Array.from(this)`.

class Item {
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
  close(): string {
    return 'closed:' + this.name
  }
}

const items = new Set<Item>([new Item('a'), new Item('b')])
//! expect: mapped=closed:a,closed:b
console.log('mapped=' + Array.from(items, (item) => item.close()).join(','))

// The Set Iterator is live (24.2.5.1): an entry added by the mapper is visited.
const growing = new Set<number>([1, 2])
const seen = Array.from(growing, (n: number, i: number): number => {
  if (n < 3) growing.add(n + 2)
  return n * 10 + i
})
//! expect: live=10,21,32,43
console.log('live=' + seen.join(','))

class List<T> {
  private readonly values: T[] = []
  push(value: T): void {
    this.values.push(value)
  }
  *[Symbol.iterator](): Generator<T, void, void> {
    for (const value of this.values) yield value
  }
  toArray(): T[] {
    return Array.from(this)
  }
  viaSpread(): T[] {
    return [...this]
  }
  viaForOf(): T[] {
    const out: T[] = []
    for (const value of this) out.push(value)
    return out
  }
}

const list = new List<string>()
list.push('x')
list.push('y')
//! expect: list=x,y
console.log('list=' + list.toArray().join(','))
//! expect: list-mapped=X0,Y1
console.log('list-mapped=' + Array.from(list, (s: string, i: number) => s.toUpperCase() + i).join(','))
//! expect: for-of=x,y
console.log('for-of=' + list.viaForOf().join(','))
//! expect: spread=x,y
console.log('spread=' + list.viaSpread().join(','))

// A throwing mapper closes the generator (IfAbruptCloseIterator, 23.1.2.1
// step 5.k.vi): its `finally` runs before the throw reaches the caller.
class Guarded {
  readonly log: string[]
  constructor() {
    this.log = []
  }
  *[Symbol.iterator](): Generator<number, void, void> {
    try {
      yield 1
      yield 2
      yield 3
    } finally {
      this.log.push('closed')
    }
  }
}
const guarded = new Guarded()
try {
  Array.from(guarded, (n: number): number => {
    if (n === 2) throw new Error('stop at ' + n)
    return n
  })
} catch (error) {
  guarded.log.push((error as Error).message)
}
//! expect: guarded=closed,stop at 2
console.log('guarded=' + guarded.log.join(','))
