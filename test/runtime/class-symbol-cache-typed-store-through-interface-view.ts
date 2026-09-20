//! expect: 200 hello
//! expect: 404 none
// The typed spelling of the same cache: the store goes through the interface
// view too, so store, accessor read and the destructuring read in another
// function all name ONE declared field -- the `[cacheKey]?: InternalCache`
// the interface states -- and the tuple is carried as that declared record,
// never boxed.
const cacheKey = Symbol('cache')
type InternalCache = [number, string | null]
interface Light {
  [cacheKey]?: InternalCache
}
class LightResponse {
  #status: number
  constructor(status: number, body: string | null) {
    this.#status = status
    if (body === null || typeof body === 'string') {
      ;(this as Light)[cacheKey] = [status, body]
    }
  }
  get status(): number {
    return ((this as Light)[cacheKey] as InternalCache | undefined)?.[0] ?? this.#status
  }
}
const describe = (res: LightResponse): string => {
  const [status, body] = (res as Light)[cacheKey] as InternalCache
  return `${status} ${body ?? 'none'}`
}
console.log(describe(new LightResponse(200, 'hello')))
console.log(describe(new LightResponse(404, null)))
