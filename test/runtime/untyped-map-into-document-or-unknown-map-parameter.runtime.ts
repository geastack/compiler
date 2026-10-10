// AN UNTYPED `new Map()` HANDED TO A `Document` PARAMETER WHOSE OTHER CALLERS PASS `Map<unknown, unknown>`.
//
// A database client's size-limited handshake document holds
// `private document = new Map()` -- a `Map<any, any>` the program only ever
// keys by strings -- and calls `Wire.serialize(this.document)`. The parameter's
// union names that map as `Map<unknown, unknown>`, which the string-keyed
// carrier is not, so the map enters that arm as a view of the SAME object:
// the serializer walks it under `object instanceof Map`, and entries set after the call
// are the entries it reads.

interface Doc {
  [key: string]: any
}

function walk(object: Doc): string {
  if (object instanceof Map) {
    const parts: string[] = []
    for (const [key, value] of (object as Map<unknown, unknown>).entries()) parts.push(`${String(key)}=${String(value)}`)
    return `map(${parts.join(',')})`
  }
  const target: Doc = object
  return `doc(${Object.keys(target as object).join(',')})`
}

class Limited {
  private document = new Map()
  add(key: string, value: any): void {
    this.document.set(key, value)
  }
  describe(): string {
    return walk(this.document)
  }
}

const limited = new Limited()
limited.add('name', 'x')
const before = limited.describe()
limited.add('size', 2)
const loose = new Map<unknown, unknown>()
loose.set(1, 'one')
//! expect: map(name=x) map(name=x,size=2) map(1=one) doc(a)
console.log(before, limited.describe(), walk(loose), walk({ a: 1 }))
