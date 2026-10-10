// `for (const x of param ?? [])` OVER AN OPTIONAL `Iterable<T>` PARAMETER.
//
// A database client's `DeprioritizedServers` constructor (in its server selection)
// takes `descriptions?: Iterable<ServerDescription>` and walks
// `descriptions ?? []`. Every caller passes an array (or nothing), so the
// census carries the parameter as an array; the `??` fallback is an empty
// array literal whose element the merge's own `Iterable<T>` states. The client
// itself never passes the argument at all, so there the census narrows the
// parameter to `undefined` and the loop walks the fallback alone (`Never`
// below). The walk is an ordinary Array Iterator over whichever array arrived.

class Entry {
  constructor(readonly address: string) {}
}

class Seen {
  private seen: Set<string> = new Set()

  constructor(entries?: Iterable<Entry>) {
    for (const entry of entries ?? []) {
      this.add(entry)
    }
  }

  add({ address }: Entry) {
    this.seen.add(address)
  }

  has({ address }: Entry): boolean {
    return this.seen.has(address)
  }

  get size(): number {
    return this.seen.size
  }
}

const a = new Entry('a:1')
const b = new Entry('b:2')
const full = new Seen([a, b, a])
const empty = new Seen()

//! expect: full=2 a=true
console.log(`full=${full.size} a=${full.has(a)}`)
//! expect: empty=0 b=false
console.log(`empty=${empty.size} b=${empty.has(b)}`)
empty.add(b)
//! expect: after=1 b=true
console.log(`after=${empty.size} b=${empty.has(b)}`)

class Never {
  readonly seen: string[] = []

  constructor(entries?: Iterable<Entry>) {
    for (const entry of entries ?? []) {
      this.seen.push(entry.address)
    }
  }
}

//! expect: never=0
console.log(`never=${new Never().seen.length}`)
