// A parsed Document reaches a sort specification typed as a union that has a
// string-keyed table arm, a pair tuple arm and array arms. The Document is a
// table, so it lands in the table arm: the guards that read `t[0]` and `t[1]`
// off the array-like arms never see it.

export {}

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
type SortForCmd = Map<string, SortDirectionForCmd>

function isMeta(t: SortDirection): t is { $meta: string } {
  return typeof t === 'object' && t != null && '$meta' in t && typeof t.$meta === 'string'
}

function prepareDirection(direction: any = 1): SortDirectionForCmd {
  const value = `${direction}`.toLowerCase()
  if (isMeta(direction)) return direction
  switch (value) {
    case 'ascending':
    case 'asc':
    case '1':
      return 1
    case 'descending':
    case 'desc':
    case '-1':
      return -1
    default:
      throw new TypeError(`Invalid sort direction: ${JSON.stringify(direction)}`)
  }
}

function isPair(t: Sort): t is readonly [string, SortDirection] {
  if (Array.isArray(t) && t.length === 2) {
    try {
      prepareDirection(t[1])
      return true
    } catch {
      return false
    }
  }
  return false
}

function isDeep(t: Sort): t is ReadonlyArray<readonly [string, SortDirection]> {
  return Array.isArray(t) && Array.isArray(t[0])
}

function isMap(t: Sort): t is ReadonlyMap<string, SortDirection> {
  return t instanceof Map && t.size > 0
}

function isReadonlyArray<T>(value: any): value is readonly T[] {
  return Array.isArray(value)
}

type SortPairForCmd = [string, SortDirectionForCmd]

function pairToMap(v: readonly [string, SortDirection]): SortForCmd {
  return new Map([[`${v[0]}`, prepareDirection([v[1]])]])
}

function deepToMap(t: ReadonlyArray<readonly [string, SortDirection]>): SortForCmd {
  const sortEntries: SortPairForCmd[] = t.map(([k, v]) => [`${k}`, prepareDirection(v)])
  return new Map(sortEntries)
}

function stringsToMap(t: ReadonlyArray<string>): SortForCmd {
  const sortEntries: SortPairForCmd[] = t.map((key) => [`${key}`, 1])
  return new Map(sortEntries)
}

function objectToMap(t: { readonly [key: string]: SortDirection }): SortForCmd {
  const sortEntries: SortPairForCmd[] = Object.entries(t).map(([k, v]) => [`${k}`, prepareDirection(v)])
  return new Map(sortEntries)
}

function mapToMap(t: ReadonlyMap<string, SortDirection>): SortForCmd {
  const sortEntries: SortPairForCmd[] = Array.from(t).map(([k, v]) => [`${k}`, prepareDirection(v)])
  return new Map(sortEntries)
}

function formatSort(sort: Sort | undefined, direction?: SortDirection): SortForCmd | undefined {
  if (sort == null) return undefined
  if (typeof sort === 'string') return new Map([[sort, prepareDirection(direction)]])
  if (typeof sort !== 'object') throw new TypeError(`Invalid sort format: ${JSON.stringify(sort)} Sort must be a valid object`)
  if (!isReadonlyArray(sort)) {
    if (isMap(sort)) return mapToMap(sort)
    if (Object.keys(sort).length) return objectToMap(sort)
    return undefined
  }
  if (!sort.length) return undefined
  if (isDeep(sort)) return deepToMap(sort)
  if (isPair(sort)) return pairToMap(sort)
  return stringsToMap(sort)
}

type Document = { [key: string]: any }

const show = (sort: SortForCmd | undefined): string =>
  sort === undefined
    ? 'none'
    : Array.from(sort)
        .map(([k, v]) => `${k}:${typeof v === 'object' ? v.$meta : v}`)
        .join(',')

function orderby(value: string | Document): SortForCmd | undefined {
  return formatSort(value)
}

const parsed: Document = JSON.parse('{"a":1,"b":"desc"}')
console.log(show(orderby(parsed)))
console.log(show(orderby('_id')))
console.log(show(formatSort(['n', 'desc'] as const)))

//! expect: a:1,b:-1
//! expect: _id:1
//! expect: n:-1
