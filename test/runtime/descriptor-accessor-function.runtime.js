//! dynamic-fallback
//! expect: raw 2
//! expect: doubled 4
//! expect: label hello
//! expect: arrow outer
// pino-std-serializers' `raw` and fastify's request decorators: a function in
// a property descriptor runs with the object it is installed on.
const rawSymbol = Symbol('raw')
function Wrapper(value) {
  this[rawSymbol] = value
}
Object.defineProperty(Wrapper.prototype, 'raw', {
  enumerable: false,
  get: function () {
    return this[rawSymbol]
  },
  set: function (val) {
    this[rawSymbol] = val
  }
})
Object.defineProperties(Wrapper.prototype, {
  doubled: {
    get: function () {
      return this[rawSymbol] * 2
    }
  },
  label: {
    value: function (text) {
      return 'label ' + text
    }
  }
})
const wrapped = new Wrapper(1)
wrapped.raw = 2
console.log('raw', wrapped.raw)
console.log('doubled', wrapped.doubled)
console.log(wrapped.label('hello'))
const outer = { name: 'outer' }
const reader = {}
function install() {
  const self = this
  Object.defineProperty(reader, 'who', { get: () => self.name })
}
install.call(outer)
console.log('arrow', reader.who)
