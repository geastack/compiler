// A `Map` stored where a `ReadonlyMap` is declared is the SAME object read
// through the read-only name -- never a copy.
//
// A database client's query cursor does `this.findOptions.sort =
// formatSort(sort)` (twice in its cursor source), storing a
// `Map<string, SortDirectionForCmd>` (`1 | -1 | { $meta }`) into `Sort`, whose
// arm is `ReadonlyMap<string, SortDirection>` (which also admits 'asc',
// 'desc', ...). TypeScript allows it by covariance. The value carriers differ,
// so the arm holds a read-only VIEW of the one Map that widens each value it
// hands out: a later `set` on the source is visible through it (a copy would
// print `false 1`), `===` still names one object, and `instanceof Map` holds.
//
// A `ReadonlyMap<K, V>` filled from a `Map<K, V>` of the same value type needs
// no view at all: both names are the one `gea::Map<K, V>`.
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

const isMap = (t: Sort): t is ReadonlyMap<string, SortDirection> => t instanceof Map && t.size > 0

const describe = (direction: SortDirection): string => (typeof direction === 'object' ? `meta:${direction.$meta}` : `${direction}`)

const mapToPairs = (t: ReadonlyMap<string, SortDirection>): string =>
  Array.from(t)
    .map(([k, v]) => `${k}=${describe(v)}`)
    .join(',')

const options: { sort?: Sort } = {}
const formatted = formatSort('name')
options.sort = formatted
formatted.set('age', -1)
const stored = options.sort
console.log(stored === formatted, isMap(stored) ? stored.size : 0)
//! expect: true 2

formatted.set('score', { $meta: 'textScore' })
if (isMap(stored)) {
  console.log(mapToPairs(stored))
  console.log(stored.has('age'), stored.has('missing'), describe(stored.get('score') ?? 'asc'), stored.get('missing') === undefined)
  const walked: string[] = []
  for (const [key, value] of stored) walked.push(`${key}:${describe(value)}`)
  console.log(walked.join(' '))
}
//! expect: name=1,age=-1,score=meta:textScore
//! expect: true false meta:textScore true
//! expect: name:1 age:-1 score:meta:textScore

// Same value type: the read-only name shares the Map as it stands.
const counts = new Map<string, number>()
const readCounts = (view: ReadonlyMap<string, number>): string => `${view.size}:${view.get('a') ?? 0}`
counts.set('a', 1)
const held: ReadonlyMap<string, number> = counts
counts.set('a', 5)
counts.set('b', 2)
console.log(readCounts(held), held === counts)
//! expect: 2:5 true
