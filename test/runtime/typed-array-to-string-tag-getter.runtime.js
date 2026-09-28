// @ts-nocheck
//! dynamic-fallback
//! expect: Uint8Array Float64Array undefined undefined true false
// safe-stable-stringify's typed-array test, read once at module init: the
// `@@toStringTag` getter of %TypedArray%.prototype, two prototypes up from a
// view, called on whatever value is being stringified.
const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(new Int8Array())), Symbol.toStringTag).get
function tag (value) { return get.call(value) }
function tagged (value) { return get.call(value) !== undefined && value.length !== 0 }
console.log(tag(new Uint8Array(2)), tag(new Float64Array(0)), tag({}), tag([1]), tagged(new Int16Array(3)), tagged([]))
