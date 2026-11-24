// hono's `#cachedBody`: `raw[key]()` with `key: keyof Body` over a request
// class whose prototype also has methods outside that key set (`bytes()`,
// `clone()`), and the result cached in a `Partial<Body>` under the same key.
// The read's domain is the key's own literal set: a method outside it -- even
// one whose frame converts into the joined result -- is no arm of the read.

export {}
class Blobby {
  constructor(readonly size: number) {}
}
class Req {
  constructor(private readonly body: string) {}
  text(): Promise<string> {
    return Promise.resolve(this.body)
  }
  async json(): Promise<any> {
    return JSON.parse(this.body)
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new TextEncoder().encode(this.body).buffer as ArrayBuffer)
  }
  blob(): Promise<Blobby> {
    return Promise.resolve(new Blobby(this.body.length))
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(this.body))
  }
  clone(): Req {
    return new Req(this.body)
  }
}
type Body = {
  json: any
  text: string
  arrayBuffer: ArrayBuffer
  blob: Blobby
}
type BodyCache = Partial<Body>
class Wrapper {
  bodyCache: BodyCache = {}
  constructor(readonly raw: Req) {}
  #cachedBody = (key: keyof Body) => {
    const { bodyCache, raw } = this
    const cachedBody = bodyCache[key]
    if (cachedBody) return cachedBody
    const anyCachedKey = Object.keys(bodyCache)[0]
    if (anyCachedKey) {
      return (bodyCache[anyCachedKey as keyof Body] as Promise<any>).then((body) => {
        if (anyCachedKey === 'json') body = JSON.stringify(body)
        return new Req(body)[key]()
      })
    }
    return (bodyCache[key] = raw[key]())
  }
  json<T = any>(): Promise<T> {
    return this.#cachedBody('json')
  }
  text(): Promise<string> {
    return this.#cachedBody('text')
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#cachedBody('arrayBuffer')
  }
  blob(): Promise<Blobby> {
    return this.#cachedBody('blob')
  }
}
const run = async (): Promise<void> => {
  const first = new Wrapper(new Req('{"a":1}'))
  const parsed = await first.json<{ a: number }>()
  const again = await first.text()
  const second = new Wrapper(new Req('hello'))
  const greeting = await second.text()
  const bytes = (await second.arrayBuffer()).byteLength
  const size = (await new Wrapper(new Req('blob!')).blob()).size
  console.log(parsed.a, again, greeting, bytes, size, (await new Req('xy').bytes()).length, new Req('z').clone() instanceof Req)
}
void run()
//! expect: 1 {"a":1} hello 5 5 2 true
