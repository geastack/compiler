// @ts-nocheck
//! dynamic-fallback
//! expect: FST_B bad x 500 true true TypeError
//! expect: FST_C RangeError true false
//! expect: TypeError true boom
// @fastify/error's `createError(code, message, statusCode, Base)`: fastify's
// errors.js hands it `TypeError` and `RangeError` as values, and it builds
// each error class on `Object.create(Base.prototype, ...)`.
function createError (code, message, statusCode = 500, Base = Error) {
  function FastifyError (...args) {
    if (!new.target) return new FastifyError(...args)
    this.code = code
    this.name = 'FastifyError'
    this.statusCode = statusCode
    this.message = message.replace('%s', args[0])
  }
  FastifyError.prototype = Object.create(Base.prototype, {
    constructor: { value: FastifyError, enumerable: false, writable: true, configurable: true }
  })
  return FastifyError
}
const factories = JSON.parse('{}')
factories.createError = createError
factories.pick = (value) => value
const create = factories.createError
const codes = {
  B: create('FST_B', 'bad %s', 500, TypeError),
  C: create('FST_C', 'range', 500, RangeError)
}
const b = new codes.B('x')
console.log(b.code, b.message, b.statusCode, b instanceof TypeError, b instanceof Error, Object.getPrototypeOf(codes.B.prototype).name)
const c = codes.C()
console.log(c.code, Object.getPrototypeOf(codes.C.prototype).name, c instanceof RangeError, c instanceof TypeError)
const Ctor = factories.pick(TypeError)
const made = new Ctor('boom')
console.log(Ctor.name, made instanceof TypeError, made.message)
