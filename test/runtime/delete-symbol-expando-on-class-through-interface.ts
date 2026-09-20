// @hono/node-server's `Response.[getResponseCache]()`: a class instance is
// viewed through an interface declaring two OPTIONAL symbol-keyed fields the
// class itself never declares, one is deleted and the other `||=`-installed.
// Both are expandos on the instance (9.1.10 OrdinaryDelete / 10.1.9 OrdinarySet
// over a symbol the layout has no slot for), so the struct must carry the
// own-field protocol the delete and the write are spelled against.
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
  hasCache(): boolean {
    return (this as Light)[cacheKey] !== undefined
  }
}
const light = new Lightweight('hi')
console.log(light.hasCache())
console.log(light.native().status)
console.log(light.hasCache())
console.log(light.native() === light.native())
//! expect: true
//! expect: 201
//! expect: false
//! expect: true
