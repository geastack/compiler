// A `Map` stored into a union slot whose `ReadonlyMap` arm holds a WIDER value
// type: a database client's query cursor does
// `this.findOptions.sort = formatSort(sort)` (twice in its cursor source),
// storing a `Map<string, SortDirectionForCmd>` (`1 | -1 | { $meta }`) into
// `Sort`, whose arm is `ReadonlyMap<string, SortDirection>` (which also admits
// 'asc', 'desc', ...). TypeScript allows it by covariance.
//
// Natively the arm is the `ReadonlyMap` interface's record, not the Map
// carrier, and the Map is a mutable object shared by reference. The only
// sound bridge is a read-only VIEW of the same Map that widens each value it
// hands out; a copy would lose the later `set` (node prints `true 2`, a copy
// would print `false 1`). The store takes that view, so identity and the later
// `set` both survive.
type SortDirection = 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending' | { readonly $meta: string }
type Sort =
  | string
  | Exclude<SortDirection, { readonly $meta: string }>
  | ReadonlyArray<string>
  | { readonly [key: string]: SortDirection }
  | ReadonlyMap<string, SortDirection>
  | ReadonlyArray<readonly [string, SortDirection]>
  | readonly [string, SortDirection]
type SortDirectionForCmd = 1 | -1 | { $meta: string }

const formatSort = (field: string): Map<string, SortDirectionForCmd> => {
  const formatted = new Map<string, SortDirectionForCmd>()
  formatted.set(field, 1)
  return formatted
}

const options: { sort?: Sort } = {}
const formatted = formatSort('name')
options.sort = formatted
formatted.set('age', -1)
const stored = options.sort
console.log(
  stored === formatted,
  typeof stored === 'object' && !Array.isArray(stored) ? (stored as ReadonlyMap<string, SortDirection>).size : 0
)
//! expect: true 2
