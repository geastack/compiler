// An HTTP framework's query parser as the framework ships it: `_getQueryParam` fills one
// `Object.create(null)` with strings or arrays by a flag, `getQueryParam` is the
// same function under a cast that drops the `multiple` parameter, and
// `getQueryParams` passes `true`. The cast alias only ever holds that function
// and is only ever called, so its calls are the parser's callers and its own
// signature answers the table's storage. `Request#query` is the public method
// handing the table to the application, which does what it likes with it
// (`JSON.stringify` here): it states one view, so it receives the table
// through that view instead of refusing the parser's storage.
export {}

const _getQueryParam = (
  url: string,
  key?: string,
  multiple?: boolean
): string | undefined | Record<string, string> | string[] | Record<string, string[]> => {
  const results: Record<string, string> | Record<string, string[]> = Object.create(null)
  for (const pair of url.split('&')) {
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

const getQueryParam: (url: string, key?: string) => string | undefined | Record<string, string> = _getQueryParam as (
  url: string,
  key?: string
) => string | undefined | Record<string, string>

const getQueryParams = (url: string, key?: string): string[] | undefined | Record<string, string[]> => {
  return _getQueryParam(url, key, true) as string[] | undefined | Record<string, string[]>
}

class Request {
  constructor(readonly url: string) {}
  query(key: string): string | undefined
  query(): Record<string, string>
  query(key?: string) {
    return getQueryParam(this.url, key)
  }
}

const request = new Request('a=1&b=2&a=3')
const one = getQueryParam('a=1&b=2', 'a') as string
const many = getQueryParams('a=1&a=3', 'a') as string[]
const table = getQueryParams('a=1&a=3&b=2') as Record<string, string[]>
console.log(one, many.join('+'), table.a!.length, table.b![0])
//! expect: 1 1+3 2 2
console.log(request.query('b'), JSON.stringify(request.query()), JSON.stringify(new Request('').query()))
//! expect: 2 {"a":"1","b":"2"} {}
