//! expect: true true false
//! expect: true true false
//! expect: false true
//! emitted-has: hostIntrinsicSidecar("Math")
//! emitted-has: properties->ownProperty
//! emitted-lacks: ObjectConstructor::hasOwn

console.log(Object.hasOwn(Math, 'abs'), Object.hasOwn(Date.prototype, 'getTime'), Object.hasOwn(Math, 'missing'))
const method = Date.prototype.getTime
console.log(Object.hasOwn(method, 'name'), Object.hasOwn(method, 'length'), Object.hasOwn(method, 'missing'))
Reflect.deleteProperty(Math, 'abs')
console.log(Object.hasOwn(Math, 'abs'), Object.hasOwn(Math, 'PI'))
