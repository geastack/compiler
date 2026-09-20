// @hono/node-server's `Response`: the method that deletes and re-installs the
// instance's symbol-keyed expandos is ITSELF symbol-keyed, and every caller
// reaches it as `this[getCache]()`. The callable flow that decides which
// bodies the reflection census walks must count that computed-key invocation
// as entering the method, or the body is emitted (it is reachable) against a
// struct whose own-field protocol the census never turned on.
const cacheKey = Symbol('cache')
const nativeKey = Symbol('native')
const getCache = Symbol('getCache')
class Native {
  status = 200
}
interface Light {
  [cacheKey]?: [number, string]
  [nativeKey]?: Native
}
class Lightweight {
  #body: string
  constructor(body: string, prebuilt?: Native) {
    this.#body = body
    if (prebuilt) {
      ;(this as Light)[nativeKey] = prebuilt
      this[getCache]()
      return
    }
    ;(this as Light)[cacheKey] = [201, body]
  }
  [getCache](): Native {
    const cache = (this as Light)[cacheKey]
    const status = cache ? cache[0] : 500
    delete (this as Light)[cacheKey]
    const made = ((this as Light)[nativeKey] ||= new Native())
    made.status = status
    return made
  }
  get status(): number {
    return ((this as Light)[cacheKey] as [number, string] | undefined)?.[0] ?? this[getCache]().status
  }
  get body(): string {
    return this.#body
  }
}
const light = new Lightweight('hi')
console.log(light.status)
console.log(light.status)
const pre = new Native()
pre.status = 404
const second = new Lightweight('x', pre)
console.log(second.status)
console.log(second.body)
//! expect: 201
//! expect: 201
//! expect: 500
//! expect: x
