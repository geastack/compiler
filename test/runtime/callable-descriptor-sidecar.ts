//! expect: 2 object 7 false true true
//! expect: true
//! expect: renamed false false true
//! expect: true
//! expect: TypeError 1
//! expect: object true false false
//! emitted-has: __gea_callable_identity->properties->ownProperty(__gea_key)
//! emitted-has: __gea_callable_identity->properties->defineOwnProperty(__gea_key
//! emitted-has: gea::installCallableConstructorPrototype
//! emitted-has: Cannot define callable property
//! emitted-lacks: gea::host::ObjectConstructor::getOwnPropertyDescriptor
//! emitted-lacks: gea::host::ObjectConstructor::defineProperty

interface DualCallableConstructor {
  (value: number): number
  new (value: number): object
  extra?: number
  locked?: number
}

// The explicit call+construct type keeps the function-and-constructor carrier
// live throughout these property operations.
const dual = function (value: number) {
  return value + 1
} as unknown as DualCallableConstructor

const called = dual(1)
const instance = new dual(2)
const prototypeDescriptor = Object.getOwnPropertyDescriptor(dual, 'prototype')!
console.log(
  typeof prototypeDescriptor.value,
  prototypeDescriptor.writable,
  prototypeDescriptor.enumerable,
  prototypeDescriptor.configurable
)

Object.defineProperty(dual, 'extra', {
  value: 7,
  writable: false,
  enumerable: true,
  configurable: true
})
const extra = Object.getOwnPropertyDescriptor(dual, 'extra')!
console.log(called, typeof instance, extra.value, extra.writable, extra.enumerable, extra.configurable)

delete dual.extra
console.log(Object.getOwnPropertyDescriptor(dual, 'extra') === undefined)

Object.defineProperty(dual, 'name', { value: 'renamed', configurable: true })
const renamed = Object.getOwnPropertyDescriptor(dual, 'name')!
console.log(renamed.value, renamed.writable, renamed.enumerable, renamed.configurable)
Reflect.deleteProperty(dual, 'name')
console.log(Object.getOwnPropertyDescriptor(dual, 'name') === undefined)

Object.defineProperty(dual, 'locked', { value: 1, writable: false, configurable: false })
let rejection = 'missing'
try {
  Object.defineProperty(dual, 'locked', { value: 2 })
} catch (error) {
  rejection = (error as Error).name
}
console.log(rejection, dual.locked)
