// hono's `HonoRequest.#cachedBody`: ONE generic reader stored in a field,
// `<Key extends keyof Readers>(key: Key) => Promise<Readers[Key]>`, whose
// callable carries the union of every payload; each caller (`text()`,
// `json()`) adapts the promise it gets back to its own `Promise<T>` at the
// call. The promise is the body read, which has NOT arrived when the adapter
// runs. The adapted promise must settle when the source does -- a snapshot of
// the pending source is a promise nothing ever settles, and `await
// c.req.json()` never resumed.
type Readers = { text: string; count: number }
let deliver: ((body: string) => void) | undefined
const readBody = (): Promise<string> =>
  new Promise<string>((resolve) => {
    deliver = resolve
  })
class LightRequest {
  private cache: { [Key in keyof Readers]?: Promise<Readers[Key]> } = {}
  cached = <Key extends keyof Readers>(key: Key): Promise<Readers[Key]> => {
    const hit = this.cache[key]
    if (hit) return hit
    const pending = (key === 'text' ? readBody() : readBody().then((body) => body.length)) as Promise<Readers[Key]>
    ;(this.cache as { [Key in keyof Readers]?: Promise<unknown> })[key] = pending
    return pending
  }
  text(): Promise<string> {
    return this.cached('text')
  }
  json(): Promise<unknown> {
    return this.cached('text').then((text: string) => JSON.parse(text))
  }
  count(): Promise<number> {
    return this.cached('count')
  }
}
const main = async (): Promise<void> => {
  const request = new LightRequest()
  const pending = request.json()
  deliver?.('{"name":"native-json","count":3}')
  const value = await pending
  const body = value as Record<string, unknown>
  console.log(typeof body.name === 'string' ? body.name : 'invalid')
  console.log(await request.text())
  const counted = new LightRequest()
  const countPending = counted.count()
  deliver?.('abcd')
  console.log(await countPending)
}
main()
//! expect: native-json
//! expect: {"name":"native-json","count":3}
//! expect: 4
