// @ts-nocheck
//! dynamic-fallback
//! expect: stub true
//! expect: Error boom
// pino-std-serializers' `Object.create({}, {...})` boxes the `{}` it links
// into a chain; an empty class, whose instance body is that same `{}`, keeps
// its struct.
class Stub {
  constructor (...args) {
    void args
  }
}
const s = new Stub()
console.log('stub', s instanceof Stub)
const errProto = Object.create({}, {
  type: { enumerable: true, writable: true, value: undefined },
  message: { enumerable: true, writable: true, value: undefined }
})
const e = Object.create(errProto)
e.type = 'Error'
e.message = 'boom'
console.log(e.type, e.message)
