// A database driver's sort option is a union whose arms include a typed
// `ReadonlyMap`, and its options bag is filled from `any`-typed input. The
// Map that comes back out of the box is the one this program boxed: its
// payload type selects the arm, with no copy, so the program's later write
// through the original Map is seen through the option.

export {}

type SortDirection = 1 | -1 | 'asc' | 'desc' | { readonly $meta: string }
type Sort =
  | string
  | Exclude<SortDirection, { readonly $meta: string }>
  | ReadonlyArray<string>
  | { readonly [key: string]: SortDirection }
  | ReadonlyMap<string, SortDirection>
  | ReadonlyArray<readonly [string, SortDirection]>
  | readonly [string, SortDirection]

interface FindOptions {
  sort?: Sort
  limit?: number
}

function describe(options: FindOptions): string {
  const sort = options.sort
  if (sort === undefined) return 'none'
  if (typeof sort === 'string' || typeof sort === 'number') return `scalar:${sort}`
  if (sort instanceof Map) return `map:${[...sort.entries()].map(([key, direction]) => `${key}=${String(direction)}`).join(',')}`
  if (Array.isArray(sort)) return `array:${sort.length}`
  return 'object'
}

function fromInput(raw: any): FindOptions {
  return { sort: raw.sort, limit: raw.limit }
}

const byName = new Map<string, SortDirection>([['name', 1]])
const boxed: any = { sort: byName, limit: 3 }
const options = fromInput(boxed)
byName.set('age', -1)
console.log(describe(options))
console.log(describe(fromInput({ sort: 'name' })))
console.log(describe(fromInput({})))
console.log(options.limit)
//! expect: map:name=1,age=-1
//! expect: scalar:name
//! expect: none
//! expect: 3
