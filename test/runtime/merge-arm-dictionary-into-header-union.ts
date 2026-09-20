//! expect: text/plain
//! expect: b
//! expect: none
// `@hono/node-server` response.ts `get headers()`, spelled exactly: the cache's
// header slot is `Record<string, string> | [string, string][] | Headers |
// OutgoingHttpHeaders | undefined`, the `instanceof` guard removes the class
// arm, and `||` supplies a `Record<string, string>` literal contextually typed
// by the trailing `as HeaderInitLite`. TypeScript subtype-reduces the `||`
// result: `Record<string, string>` is a subtype of `OutgoingHttpHeaders`, so
// the merge's union carries only the WIDER dictionary, and the string
// dictionary reaching it -- both the literal and the slot's own arm -- must
// widen its values into the wider dictionary's.
type OutgoingHttpHeader = string | number | boolean | readonly string[]
interface OutgoingHttpHeaders {
  [name: string]: OutgoingHttpHeader | undefined
}
class HeadersLite {
  private names: string[] = []
  private values: string[] = []
  constructor(init?: HeaderInitLite) {
    if (init === undefined) return
    if (init instanceof HeadersLite) {
      this.names = init.names.slice()
      this.values = init.values.slice()
    } else if (Array.isArray(init)) {
      for (const [name, value] of init) this.set(name, value)
    } else {
      for (const name in init) this.set(name, init[name]!)
    }
  }
  get(name: string): string | null {
    const index = this.names.indexOf(name)
    return index < 0 ? null : this.values[index]!
  }
  set(name: string, value: string): void {
    this.names.push(name)
    this.values.push(value)
  }
}
type HeaderInitLite = HeadersLite | Record<string, string> | [string, string][]
type CacheTuple = [number, string | null, Record<string, string> | [string, string][] | HeadersLite | OutgoingHttpHeaders | undefined]
const defaultContentType = 'text/plain'

const headersOf = (cache: CacheTuple): HeadersLite => {
  if (!(cache[2] instanceof HeadersLite)) {
    cache[2] = new HeadersLite((cache[2] || (cache[1] === null ? undefined : { 'content-type': defaultContentType })) as HeaderInitLite)
  }
  return cache[2]
}

console.log(headersOf([200, 'body', undefined]).get('content-type') ?? 'none')
console.log(headersOf([200, 'body', { a: 'b' }]).get('a') ?? 'none')
console.log(headersOf([200, null, undefined]).get('content-type') ?? 'none')
