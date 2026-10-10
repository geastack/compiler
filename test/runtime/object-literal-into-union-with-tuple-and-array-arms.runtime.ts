// An object literal handed to a union that also has array, tuple and Map
// arms (a database client's `Sort` and `IndexSpecification`) is the index-signature
// arm: the literal is a plain object, never an array.

type Direction = 1 | -1 | 'asc' | 'desc'
type Sort =
  | string
  | ReadonlyArray<string>
  | { readonly [key: string]: Direction }
  | ReadonlyMap<string, Direction>
  | ReadonlyArray<readonly [string, Direction]>
  | readonly [string, Direction]

function isReadonlyArray<T>(value: any): value is readonly T[] {
  return Array.isArray(value)
}

function describe(sort: Sort): string {
  if (typeof sort === 'string') return `string:${sort}`
  if (isReadonlyArray(sort)) return `array:${sort.length}`
  if (sort instanceof Map) return `map:${sort.size}`
  const record = sort as { readonly [key: string]: Direction }
  return `object:${Object.keys(record)
    .map((key) => `${key}=${String(record[key])}`)
    .join(',')}`
}

type IndexSpecification = OneOrMore<string | [string, Direction] | { [key: string]: Direction } | Map<string, Direction>>
type OneOrMore<T> = T | ReadonlyArray<T>

function describeIndex(spec: IndexSpecification): string {
  if (isReadonlyArray(spec)) return `array:${spec.length}`
  if (typeof spec === 'string') return `string:${spec}`
  if (spec instanceof Map) return `map:${spec.size}`
  const record = spec as { [key: string]: Direction }
  return `object:${Object.keys(record).join(',')}`
}

//! expect: object:qty=-1
console.log(describe({ qty: -1 }))
//! expect: object:_id=1,name=asc
console.log(describe({ _id: 1, name: 'asc' }))
//! expect: string:name
console.log(describe('name'))
//! expect: object:name,qty
console.log(describeIndex({ name: 1, qty: -1 }))
