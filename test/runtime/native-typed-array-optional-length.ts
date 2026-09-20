//! expect: 0 3 0 0
//! expect: 0 2
//! expect: 0 0
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

// The ambient TypeScript lib omits these valid ECMAScript length alternatives.
// Declaration merging states the real overloads without changing the runtime
// constructors or asserting an absent value to be a number.
interface Int32ArrayConstructor {
  new (length: number | undefined): Int32Array
}
interface Float32ArrayConstructor {
  new (length: number | null): Float32Array
}
interface Uint8ArrayConstructor {
  new (length: null | undefined): Uint8Array
}

function optionalLength(length: number | undefined) {
  return new Int32Array(length).length
}

function nullableLength(length: number | null) {
  return new Float32Array(length).length
}

console.log(optionalLength(undefined), optionalLength(3.9), optionalLength(NaN), optionalLength(-0.5))
console.log(nullableLength(null), nullableLength(2.7))
console.log(new Uint8Array(undefined).length, new Uint8Array(null).length)
