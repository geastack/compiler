// @ts-nocheck
//! expect: scale 6 NaN NaN
//! expect: shift 3 -1 NaN
//! expect: twice 8 NaN 10 14
// three's `WebGLBackend._createVao`: `attribute.offset * bytesPerElement`
// reads an `offset` the program states as `number | Vector2 | undefined`.
// JavaScript multiplication takes ToNumber of the whole value, so beneath
// the absence each arm takes its own conversion: a number is itself, an
// object is ToNumber of its string, `undefined` is NaN and `null` is 0.
// (`@ts-nocheck` because the checker lints arithmetic on an object arm; the
// JSDoc still states the finite domain.)
class Plain {
  constructor() {
    this.x = 1
  }
}
/** @param {number|Plain|undefined} value */
function scale(value) {
  return value * 2
}
/** @param {number|Plain|null} value */
function shift(value) {
  return value - 1
}
/** @param {number|Array<number>|undefined} value */
function twice(value) {
  return value * 2
}
console.log('scale', scale(3), scale(undefined), scale(new Plain()))
console.log('shift', shift(4), shift(null), shift(new Plain()))
console.log('twice', twice(4), twice(undefined), twice([5]), twice([7]))
