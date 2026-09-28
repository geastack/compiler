// @ts-nocheck
//! dynamic-fallback
//! expect: ValueError boom true
//! expect: FST_X x failed true
// Reading a host constructor's prototype (@fastify/error's
// `Object.create(Base.prototype, ...)` over `Error`) leaves `Error` itself a
// native base that a class extends.
function createError (code, message, Base = Error) {
  function FastifyError () {
    if (!new.target) return new FastifyError()
    this.code = code
    this.message = message
  }
  FastifyError.prototype = Object.create(Base.prototype, {
    constructor: { value: FastifyError, enumerable: false, writable: true, configurable: true }
  })
  return FastifyError
}
class ValueError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ValueError'
  }
}
const v = new ValueError('boom')
console.log(v.name, v.message, v instanceof Error)
const E = createError('FST_X', 'x failed')
const e = new E()
console.log(e.code, e.message, e instanceof Error)
