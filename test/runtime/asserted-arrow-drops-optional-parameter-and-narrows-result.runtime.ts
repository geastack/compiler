//! expect: one:a
//! expect: all:{"a":"1","b":"2"}
//! expect: many:["1","3"]
//! expect: missing:undefined

// An HTTP framework's URL utilities: one implementation with an optional third parameter is
// exported twice -- once asserted to a two-parameter signature whose result
// union omits the `multiple` arms, once wrapped to pass `true`. The asserted
// value is the same function; a call through it simply never supplies the
// omitted optional parameter.

const lookup = (
  query: string,
  key?: string,
  multiple?: boolean
): string | undefined | Record<string, string> | string[] | Record<string, string[]> => {
  const pairs = query.split('&').map((pair) => pair.split('='))
  if (multiple) return pairs.filter(([name]) => name === key).map(([, value]) => value ?? '')
  const results: Record<string, string> = {}
  for (const [name, value] of pairs) if (name !== undefined) results[name] ??= value ?? ''
  return key ? results[key] : results
}

export const single: (query: string, key?: string) => string | undefined | Record<string, string> = lookup as (
  query: string,
  key?: string
) => string | undefined | Record<string, string>

const one = single('a=1&b=2', 'a')
console.log(`one:${typeof one === 'string' ? 'a' : 'other'}`)
console.log(`all:${JSON.stringify(single('a=1&b=2'))}`)
console.log(`many:${JSON.stringify(lookup('a=1&b=2&a=3', 'a', true))}`)
const missing = single('a=1', 'z')
console.log(`missing:${missing === undefined ? 'undefined' : 'present'}`)
