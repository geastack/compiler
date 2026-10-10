// An `any` argument is unchecked: TypeScript lets it reach a parameter whose
// declared type does not admit the runtime value. A database client's sort
// `pairToMap` does
// exactly this -- `prepareDirection([v[1]])` hands an ARRAY through
// `direction: any` to `isMeta(t: SortDirection)`, which must simply answer
// false for it, not stop the program.
type Direction = number | string | { $meta: string }

function isMeta(t: Direction): t is { $meta: string } {
  return typeof t === 'object' && t != null && '$meta' in t && typeof t.$meta === 'string'
}

function prepare(direction: any): string {
  if (isMeta(direction)) return `meta:${direction.$meta}`
  return `${direction}`
}

console.log(prepare([-1]))
console.log(prepare({ $meta: 'textScore' }))
console.log(prepare(1))
console.log(prepare(true))

//! expect: -1
//! expect: meta:textScore
//! expect: 1
//! expect: true
