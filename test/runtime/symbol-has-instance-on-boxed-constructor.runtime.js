// @ts-nocheck
//! dynamic-fallback
//! expect: true false FST_A a failed false
// A constructor's own @@hasInstance decides `instanceof` (ECMA-262 13.10.2):
// @fastify/error installs one per error constructor it creates.
'use strict'
function createError (code, message) {
  const specific = Symbol.for(`fastify-error ${code}`)
  function FastifyError (...args) {
    if (!new.target) return new FastifyError(...args)
    this.code = code
    this.name = 'FastifyError'
    this.message = message
  }
  FastifyError.prototype = Object.create(Error.prototype, {
    constructor: { value: FastifyError, enumerable: false, writable: true, configurable: true },
    [specific]: { value: true, enumerable: false, writable: false, configurable: false }
  })
  Object.defineProperty(FastifyError, Symbol.hasInstance, {
    value (instance) { return instance && instance[specific] },
    configurable: false,
    writable: false,
    enumerable: false
  })
  return FastifyError
}
const A = createError('FST_A', 'a failed')
const B = createError('FST_B', 'b failed')
const a = new A()
console.log(a instanceof A, a instanceof B, a.code, a.message, Boolean({} instanceof A))
