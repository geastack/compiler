// @hono/node-server's lightweight `Response` once its global override is
// gone: the class is evaluated (its binding is read), so its members are
// emitted, but nothing ever constructs it, so the callable flow proves every
// method body never entered and the reflection census leaves the struct's
// own-field protocol off. The `delete` and the `||=` write inside the dead
// method must still compile against that protocol-less struct: the routing
// they need lives in the runtime behind `if constexpr`, not in the emitter.
const cacheKey = Symbol('cache')
const nativeKey = Symbol('native')
class Native {
  status = 200
}
interface Light {
  [cacheKey]?: [number, string]
  [nativeKey]?: Native
}
class Lightweight {
  #body: string
  constructor(body: string) {
    this.#body = body
    ;(this as Light)[cacheKey] = [201, body]
  }
  native(): Native {
    const cache = (this as Light)[cacheKey]
    const status = cache ? cache[0] : 500
    delete (this as Light)[cacheKey]
    const made = ((this as Light)[nativeKey] ||= new Native())
    made.status = status
    return made
  }
  get body(): string {
    return this.#body
  }
}
console.log(typeof Lightweight)
console.log(new Native().status)
//! expect: function
//! expect: 200
