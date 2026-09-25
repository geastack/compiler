//! dynamic-fallback
//! expect: true false true A 500
// @fastify/error's createError: a host error constructor held as a value
// (the `Base = Error` default, `TypeError` passed by a caller), its prototype
// read through the union of the two, Object.create linking to the intrinsic
// prototype, and instanceof walking the ordinary chain back to it.
'use strict'
function createError (code, message, statusCode = 500, Base = Error) {
  function FastifyError (...args) {
    if (!new.target) {
      return new FastifyError(...args)
    }
    this.code = code
    this.message = message
    this.statusCode = statusCode
  }
  FastifyError.prototype = Object.create(Base.prototype, {
    constructor: { value: FastifyError, enumerable: false, writable: true, configurable: true }
  })
  return FastifyError
}
const E1 = createError('A', 'a', 500, TypeError)
const E2 = createError('B', 'b')
const e1 = new E1()
const e2 = new E2()
console.log(e1 instanceof TypeError, e2 instanceof TypeError, e2 instanceof Error, e1.code, e2.statusCode)
