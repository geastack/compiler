// A database client's handshake `LimitedSizeDocument` hands a binary-document
// serializer's `serialize(object: Document)` two maps: its own
// `private document = new Map()` field, and a probe `new Map().set(key, value)`
// built per candidate entry. The serializer walks either under `object instanceof Map`.
// Both are `Map<any, any>` to the checker and `Map<string, Doc | string>` to
// every write the program makes, so the parameter's map arm is that native map:
// the field enters as itself, with no box and no dynamic view.

interface Doc {
  [key: string]: any
}

function walk(object: Doc): string {
  if (object instanceof Map) {
    const parts: string[] = []
    for (const [key, value] of (object as Map<unknown, unknown>).entries())
      parts.push(`${String(key)}=${typeof value === 'string' ? value : Object.keys(value as object).join('+')}`)
    return `map(${parts.join(',')})`
  }
  const target: Doc = object
  return `doc(${Object.keys(target).join(',')})`
}

class Limited {
  private document = new Map()
  fits(key: string, value: Doc | string): boolean {
    const probe = walk(new Map().set(key, value))
    if (probe.length > 40) return false
    this.document.set(key, value)
    return true
  }
  describe(): string {
    return walk(this.document)
  }
}

const limited = new Limited()
limited.fits('name', 'x')
const before = limited.describe()
limited.fits('os', { type: 'linux', arch: 'arm64' })
//! expect: map(name=x) map(name=x,os=type+arch) doc(a)
//! emitted-lacks: unboxDynamicMap
console.log(before, limited.describe(), walk({ a: 1 }))
