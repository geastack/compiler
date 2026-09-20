// A COMPUTED STORE THROUGH A RECEIVER THE PROGRAM FILLS WITH SEVERAL OBJECTS.
//
// `@hono/node-server`'s `readBodyWithFastPath(request: Record<string | symbol,
// any>, ...)` caches a body under a module symbol on whichever request object
// it was handed -- `this` of a method installed with `Object.defineProperty`,
// declared `any` by the descriptor's `ThisType<any>` -- and reads it back later
// through the same symbol. Each arm keeps its native layout; only the stored
// value crosses the sidecar.

const cacheKey = Symbol('cache')

const remember = <T>(request: Record<string | symbol, any>, value: T): T => {
  request[cacheKey] = value
  return value
}

const recall = (request: Record<string | symbol, any>): string => request[cacheKey] ?? 'missing'

const lightPrototype: Record<string | symbol, any> = { url: '/light' }

Object.defineProperty(lightPrototype, 'store', {
  value: function (text: string): string {
    return remember(this, text)
  }
})

Object.defineProperty(lightPrototype, 'forget', {
  value: function (): undefined {
    return remember(this, undefined)
  }
})

const light = lightPrototype
const other: Record<string | symbol, any> = { method: 'GET' }

light.store('light-body')
remember(other, undefined)

//! expect: light=light-body
console.log('light=' + recall(light))

//! expect: other=missing
console.log('other=' + recall(other))

remember(other, 'other-body')
//! expect: other=other-body
console.log('other=' + recall(other))

light.forget()
//! expect: light=missing
console.log('light=' + recall(light))

//! expect: fields=/light GET
console.log('fields=' + light.url + ' ' + other.method)
