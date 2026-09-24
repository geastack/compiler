//! dynamic-fallback
//! expect: true stream@exit
//! expect: [object WeakRef] true
//! expect: true true
//! expect: TypeError: Constructor WeakRef requires 'new'
//! expect: TypeError: WeakRef: invalid target
//! expect: TypeError: Method WeakRef.prototype.deref called on incompatible receiver undefined
//! expect: undefined false
//! expect: true false
//! expect: TypeError: FinalizationRegistry.prototype.register: target and holdings must not be same
//! expect: TypeError: Invalid unregisterToken ('abc')
//! expect: TypeError: FinalizationRegistry: cleanup must be callable
// on-exit-leak-free and thread-stream, reached from pino at fastify startup:
// the constructor is a value (`global.WeakRef || FakeWeakRef`), the instance
// carries an expando (`ref.fn = fn`), and the registry is constructed at
// module load. Every TypeError below is V8's, spelled the same.
class FakeWeakRef {
  constructor(value) {
    this._value = value
  }

  deref() {
    return this._value
  }
}
const describe = (error) => error.name + ': ' + error.message
const target = { name: 'stream' }
const ref = new WeakRef(target)
ref.fn = (object, event) => object.name + '@' + event
const held = ref.deref()
if (held !== undefined) console.log(held === target, ref.fn(held, 'exit'))
console.log(Object.prototype.toString.call(ref), ref instanceof WeakRef)
const Chosen = globalThis.WeakRef || FakeWeakRef
console.log(new Chosen(target).deref() === target, Chosen === WeakRef)
try {
  WeakRef(target)
} catch (error) {
  console.log(describe(error))
}
try {
  new WeakRef(1)
} catch (error) {
  console.log(describe(error))
}
try {
  const deref = WeakRef.prototype.deref
  deref()
} catch (error) {
  console.log(describe(error))
}
const registry = new FinalizationRegistry((worker) => {
  console.log('cleanup', worker)
})
console.log(registry.register(target, 'worker'), registry.unregister(target))
const token = {}
registry.register(target, 1, token)
registry.register({}, 2, token)
console.log(registry.unregister(token), registry.unregister(token))
try {
  registry.register(target, target)
} catch (error) {
  console.log(describe(error))
}
try {
  registry.unregister('abc')
} catch (error) {
  console.log(describe(error))
}
try {
  new FinalizationRegistry(1)
} catch (error) {
  console.log(describe(error))
}
