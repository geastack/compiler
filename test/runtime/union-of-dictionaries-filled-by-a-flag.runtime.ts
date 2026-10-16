// An HTTP framework's `_getQueryParam` fills ONE `Object.create(null)` declared
// `Record<string, string> | Record<string, string[]>`: with `multiple` every
// value is an array, without it every value is a string. The two records are
// views of one table, not two allocations, so the closed fresh-table census
// lays the allocation out as a table of `string | string[]` -- an empty
// null-prototype object is that table's origin, `results[name] = []` stores
// the array view it fits, and `??=` is an ordinary entry write.
export {}

const parse = (
  query: string,
  key?: string,
  multiple?: boolean
): string | undefined | Record<string, string> | string[] | Record<string, string[]> => {
  const results: Record<string, string> | Record<string, string[]> = Object.create(null)
  for (const pair of query.split('&')) {
    const [name = '', value = ''] = pair.split('=')
    if (name === '') continue
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = []
      }
      ;(results[name] as string[]).push(value)
    } else {
      results[name] ??= value
    }
  }
  return key ? results[key] : results
}

const single = parse('a=1&b=2&a=3') as Record<string, string>
const many = parse('a=1&b=2&a=3', undefined, true) as Record<string, string[]>
const values = parse('a=1&a=2', 'a', true) as string[]
const value = parse('x=9', 'x') as string
console.log(single.a, single.b, many.a!.join('+'), many.b!.length, values.join(','), value)
//! expect: 1 2 1+3 1 1,2 9
