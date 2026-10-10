// A `Map<string, any>` HANDED TO A `Document` PARAMETER THAT BRANCHES ON `instanceof Map`.
//
// A database client's size-limited handshake document's `toObject()` is
// `Wire.deserialize(Wire.serialize(this.document))` with `document` a
// `Map<string, any>`; the binary-document serializer's `serialize(object: Document)` walks a Map by its
// entries under `object instanceof Map`. Other callers pass plain documents
// and `Map<unknown, unknown>`s to the same parameter, so the Map has to reach
// it as the same object -- entries set after the call included.

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
  document: Map<string, any> = new Map()
  add(key: string, value: any): void {
    this.document.set(key, value)
  }
  describe(): string {
    return walk(this.document)
  }
}

const limited = new Limited()
limited.add('driver', 'nodejs')
limited.add('os', 'linux')
const loose = new Map<unknown, unknown>()
loose.set(1, 'one')
//! expect: map(driver=nodejs,os=linux) map(1=one) doc(a,b)
console.log(limited.describe(), walk(loose), walk({ a: 1, b: 2 }))
limited.add('platform', 'x64')
//! expect: map(driver=nodejs,os=linux,platform=x64)
console.log(limited.describe())

// Held in a `Document` variable first, the Map is still the Map: `instanceof`
// answers from the object the Document views.
const held: Doc = limited.document
//! expect: true false map(driver=nodejs,os=linux,platform=x64)
console.log(held instanceof Map, ({ a: 1 } as Doc) instanceof Map, walk(held))
