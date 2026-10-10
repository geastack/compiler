// A `string | number` NAME SCANNED AGAINST A LIST, AND LOOKED UP IN A CACHE.
//
// A database client's on-demand document `getElement(name: string | number)` reads the
// cache with `this.cache[name]`, then compares the string arm against every
// element's bytes through `isElementName(name, element)`. The key lookup must
// not copy the string arm just to view it, and the per-element call must bind
// the formal's own string instead of a fresh copy each iteration. Both
// answers have to stay exactly what the copying spelling gave.

interface Entry {
  nameBytes: number[]
  value: number
}

class Doc {
  private readonly cache: Record<string, Entry | false | undefined> = Object.create(null)
  private readonly found: Record<number, boolean> = Object.create(null)
  constructor(private readonly entries: Entry[]) {}

  private matches(name: string, entry: Entry): boolean {
    if (name.length !== entry.nameBytes.length) return false
    for (let i = 0; i < name.length; i++) if (entry.nameBytes[i] !== name.charCodeAt(i)) return false
    return true
  }

  get(name: string | number): Entry | null {
    const cached = this.cache[name]
    if (cached === false) return null
    if (cached != null) return cached
    if (typeof name === 'number') {
      if (name < this.entries.length) {
        const entry = this.entries[name]!
        this.cache[name] = entry
        return entry
      }
      return null
    }
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!
      if (!(i in this.found) && this.matches(name, entry)) {
        this.cache[name] = entry
        this.found[i] = true
        return entry
      }
    }
    this.cache[name] = false
    return null
  }
}

const bytes = (s: string): number[] => {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i))
  return out
}

const doc = new Doc([
  { nameBytes: bytes('cursor'), value: 1 },
  { nameBytes: bytes('ok'), value: 2 },
  { nameBytes: bytes('firstBatch'), value: 3 }
])

//! expect: ok=2
console.log(`ok=${doc.get('ok')?.value}`)
//! expect: ok again=2
console.log(`ok again=${doc.get('ok')?.value}`)
//! expect: firstBatch=3
console.log(`firstBatch=${doc.get('firstBatch')?.value}`)
//! expect: missing=none
console.log(`missing=${doc.get('nope') === null ? 'none' : 'some'}`)
//! expect: missing again=none
console.log(`missing again=${doc.get('nope') === null ? 'none' : 'some'}`)
//! expect: index 0=1
console.log(`index 0=${doc.get(0)?.value}`)
//! expect: index 9=none
console.log(`index 9=${doc.get(9) === null ? 'none' : 'some'}`)
//! expect: cursor=1
console.log(`cursor=${doc.get('cursor')?.value}`)
