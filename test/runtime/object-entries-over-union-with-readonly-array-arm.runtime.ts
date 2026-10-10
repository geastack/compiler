// `Object.entries` of a value whose union still carries a `ReadonlyArray`
// arm: `Array.isArray`'s false branch does not remove a readonly array from
// the checker's type (a database client's index-description builder), so the
// dispatch spells the array arm too -- as an Array's own entries.

type Direction = 1 | -1 | 'text' | number
type Spec = string | [string, Direction] | { [key: string]: Direction } | Map<string, Direction>
type OneOrMore<T> = T | ReadonlyArray<T>

function isObject(arg: unknown): arg is object {
  return '[object Object]' === Object.prototype.toString.call(arg)
}

function isSingleIndexTuple(t: unknown): t is [string, Direction] {
  return Array.isArray(t) && t.length === 2
}

function describe(indexSpec: OneOrMore<Spec>): string {
  const key = new Map<string, Direction>()
  const specs = !Array.isArray(indexSpec) || isSingleIndexTuple(indexSpec) ? [indexSpec] : indexSpec
  for (const spec of specs) {
    if (typeof spec === 'string') key.set(spec, 1)
    else if (Array.isArray(spec)) key.set(spec[0], spec[1] ?? 1)
    else if (spec instanceof Map) for (const [property, value] of spec) key.set(property, value)
    else if (isObject(spec)) for (const [property, value] of Object.entries(spec)) key.set(property, value)
  }
  return [...key].map(([k, v]) => `${k}:${String(v)}`).join(',')
}

//! expect: name:1,qty:-1
console.log(describe({ name: 1, qty: -1 }))
//! expect: a:b
console.log(describe(['a', 'b']))
//! expect: array-entries 0=x 1=y
console.log(
  `array-entries ${Object.entries(['x', 'y'] as readonly string[])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`
)
