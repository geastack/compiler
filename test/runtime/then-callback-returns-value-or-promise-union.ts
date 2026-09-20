// @hono/node-server's `readBodyWithFastPath`: a `then` callback whose result
// is typed `T | Promise<T>` -- the decoder it is handed may answer either --
// and is a plain string at runtime. The promise `then` returns must settle
// with that string (adopting only when the arm really is a promise); hono's
// `c.req.json()` sits on the far side of exactly this chain, and a `then`
// that never settles here is a POST that never answers.
const readDirect = (): Promise<string> =>
  new Promise<string>((resolve) => {
    Promise.resolve().then(() => resolve('{"name":"native-json","count":3}'))
  })
const readWithFastPath = <T>(fromBuffer: (text: string) => T | Promise<T>): Promise<T> =>
  readDirect().then((text) => {
    const result = fromBuffer(text)
    return result
  })
class LightRequest {
  text(): Promise<string> {
    return readWithFastPath((text) => text)
  }
}
type BodyReaders = { text: string; json: unknown }
const cache: { [Key in keyof BodyReaders]?: Promise<BodyReaders[Key]> } = {}
const cachedBody = <Key extends keyof BodyReaders>(key: Key, raw: LightRequest): Promise<BodyReaders[Key]> => {
  const hit = cache[key]
  if (hit) return hit
  const pending = raw.text() as Promise<BodyReaders[Key]>
  cache[key] = pending as Promise<string>
  return pending
}
const json = <T = any>(raw: LightRequest): Promise<T> => cachedBody('text', raw).then((text: string) => JSON.parse(text))
const main = async (): Promise<void> => {
  const value = await json(new LightRequest())
  if (typeof value !== 'object' || value === null) {
    console.log('invalid')
    return
  }
  const body = value as Record<string, unknown>
  console.log(typeof body.name === 'string' ? body.name : 'invalid')
}
main()
//! expect: native-json
