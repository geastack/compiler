//! expect: lazy:b
//! expect: eager:b
//! expect: true
// `@hono/node-server` headers.ts: `RequestHeaders` derives from the captured
// `GlobalHeaders` (a const alias of the class), overrides every accessor, and
// `newHeadersFromIncoming` merges `new RequestHeaders(...)` with a plain
// `GlobalHeaders` in one conditional -- the upcast happens in the merge and
// every later call must dispatch to the override.
class HeadersImpl {
  private names: string[] = []
  private values: string[] = []
  append(name: string, value: string): void {
    this.names.push(name)
    this.values.push(value)
  }
  get(name: string): string | null {
    const index = this.names.indexOf(name)
    return index < 0 ? null : `eager:${this.values[index]}`
  }
}
const GlobalHeaders = HeadersImpl
type GlobalHeaders = InstanceType<typeof GlobalHeaders>

class RequestHeaders extends GlobalHeaders {
  #raw: string[]
  #headers?: GlobalHeaders
  constructor(raw: string[]) {
    super()
    this.#raw = raw
  }
  get #native(): GlobalHeaders {
    if (!this.#headers) {
      const headers = new GlobalHeaders()
      for (let i = 0; i < this.#raw.length; i += 2) headers.append(this.#raw[i]!, this.#raw[i + 1]!)
      this.#headers = headers
    }
    return this.#headers
  }
  override get(name: string): string | null {
    const value = this.#native.get(name)
    return value === null ? null : `lazy:${value.slice('eager:'.length)}`
  }
}

const newHeaders = (raw: string[], lazy: boolean): GlobalHeaders => {
  if (lazy) return new RequestHeaders(raw) as unknown as GlobalHeaders
  const headers = new GlobalHeaders()
  for (let i = 0; i < raw.length; i += 2) headers.append(raw[i]!, raw[i + 1]!)
  return headers
}
const viaConditional = (raw: string[], lazy: boolean): GlobalHeaders =>
  lazy ? (new RequestHeaders(raw) as unknown as GlobalHeaders) : newHeaders(raw, false)

console.log(viaConditional(['a', 'b'], true).get('a'))
console.log(viaConditional(['a', 'b'], false).get('a'))
console.log(viaConditional(['a', 'b'], true) instanceof GlobalHeaders)
