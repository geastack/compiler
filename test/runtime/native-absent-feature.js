const array = new Float32Array([1, 2])
// @ts-expect-error This feature is deliberately absent from the host and the checker library.
const halfFloat = typeof Float16Array !== 'undefined' && array instanceof Float16Array
let threw = false
try {
  // @ts-expect-error An unguarded missing binding must still raise ReferenceError.
  Float16Array
} catch (error) {
  threw = true
}
function localConstructor() {
  class Float16Array {}
  return typeof Float16Array === 'function'
}
console.log(halfFloat, threw, localConstructor())
