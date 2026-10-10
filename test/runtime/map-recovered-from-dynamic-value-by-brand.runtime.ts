// A binary-document serializer's `isMap(v)` guard and `value instanceof Map || isMap(value)` over an
// `unknown`/`any` value: the Map is recovered from the dynamic carrier by a
// runtime brand check, whatever its key and value types were, and iterated
// as the entries it holds. A non-Map passes through untouched.
function isMap(d: unknown): d is Map<unknown, unknown> {
  return Object.prototype.toString.call(d) === '[object Map]'
}
function inspect(x: unknown): string {
  return JSON.stringify(x, (_k: string, v: unknown) => {
    if (isMap(v)) return Object.fromEntries(v)
    return v
  })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize(value: any): any {
  if (value instanceof Map || isMap(value)) {
    const obj: Record<string, unknown> = Object.create(null)
    for (const [k, v] of value) {
      if (typeof k !== 'string') throw new Error('Can only serialize maps with string keys')
      obj[k] = v
    }
    return obj
  }
  return value
}
const counts = new Map<string, number>()
counts.set('a', 1)
counts.set('b', 2)
const labels = new Map<string, string>()
labels.set('x', 'y')
const numbered = new Map<number, string>()
numbered.set(1, 'one')
// Handed over as `unknown`, the way a serializer receives a document's values.
const a: unknown = counts
const b: unknown = labels
const c: unknown = 7
const d: unknown = numbered
console.log(inspect(a), inspect(b), inspect(c))
console.log(JSON.stringify(serialize(a)), JSON.stringify(serialize(b)), serialize(c))
try {
  serialize(d)
} catch (error) {
  console.log((error as Error).message)
}
// The view is the map itself: a later write is visible through it.
counts.set('c', 3)
console.log(JSON.stringify(serialize(a)))

//! expect: {"a":1,"b":2} {"x":"y"} 7
//! expect: {"a":1,"b":2} {"x":"y"} 7
//! expect: Can only serialize maps with string keys
//! expect: {"a":1,"b":2,"c":3}
