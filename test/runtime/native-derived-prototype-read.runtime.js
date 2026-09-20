//! expect: derived 42
//! expect: missing undefined
//! expect: detached 9
//! expect: shadow 17
//! expect: computed 42
//! expect: computed-missing undefined
//! expect: shadow-undefined undefined
//! expect: restored 42
//! expect: native-derived 12
//! expect: read-time 14
//! expect: identity true

class Base {
  value = 3
}
class Derived extends Base {
  /** @this {Base} */
  compute() {
    return this.value * 2
  }
}

/** @param {Base & Record<string, any>} object */
function read(object) {
  return object.compute
}

/** @param {Base & Record<string, any>} object @param {string} key */
function readKey(object, key) {
  return object[key]
}

const derived = new Derived()
derived.value = 21
console.log('derived', read(derived).call(derived))
console.log('missing', typeof read(new Base()))
console.log('computed', readKey(derived, 'compute').call(derived))
console.log('computed-missing', typeof readKey(new Base(), 'compute'))
const method = read(derived)
const replacement = new Base()
replacement.value = 4.5
console.log('detached', method.call(replacement))
/** @type {*} */
const dynamic = derived
dynamic.compute = () => 17
console.log('shadow', read(derived).call(derived))

dynamic.compute = undefined
console.log('shadow-undefined', typeof read(derived))
delete dynamic.compute
console.log('restored', read(derived).call(derived))

class NativeDerived extends Base {
  own = 11
  bump() {
    return ++this.own
  }
}
const native = new NativeDerived()
console.log('native-derived', readKey(native, 'bump').call(native))
class Override extends Derived {
  /** @this {Base} */
  compute() {
    return this.value * 3
  }
}
const override = new Override()
override.value = 7
console.log('read-time', method.call(override))
console.log('identity', read(derived) === read(derived))
