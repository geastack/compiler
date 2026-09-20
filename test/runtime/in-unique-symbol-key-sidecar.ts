//! expect: true
//! expect: false

// `@hono/node-server` keys its response cache with a module-private
// `unique symbol` and tests for it with `cacheKey in res`, over a class that
// does NOT declare the member: the symbol is an expando the listener installs
// on the way out. The answer therefore comes from the object's own runtime
// sidecar, exactly as a runtime STRING key over the same carrier already does.
const cacheKey: unique symbol = Symbol('cache')

class LightResponse {
  status = 200
}

const cached = new LightResponse()
;(cached as unknown as Record<symbol, number>)[cacheKey] = 7
const plain = new LightResponse()

console.log(cacheKey in cached)
console.log(cacheKey in plain)
