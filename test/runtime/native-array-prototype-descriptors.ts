const intrinsic = Array.prototype
const ordinary: typeof Array.prototype = []
console.log(intrinsic === Array.prototype, intrinsic === ordinary, Array.isArray(intrinsic), intrinsic.length)
//! expect: true false true 0

const joinDescriptor = Object.getOwnPropertyDescriptor(intrinsic, 'join')!
console.log(typeof joinDescriptor.value, joinDescriptor.writable, joinDescriptor.enumerable, joinDescriptor.configurable)
//! expect: function true false true
console.log(Object.getOwnPropertyDescriptor(ordinary, 'join') === undefined)
//! expect: true
console.log(Object.getOwnPropertyNames(intrinsic).indexOf('join') >= 0, Object.keys(intrinsic).indexOf('join'))
//! expect: true -1

console.log(joinDescriptor.value === Object.getOwnPropertyDescriptor(Array.prototype, 'join')!.value)
//! expect: true
