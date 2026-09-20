// @ts-nocheck
// three's `WebGLState.js` as the native-webgl-angle plugin rewrites it:
// `function texStorage2D() { gl.texStorage2D( ...arguments ) }` becomes a
// rest frame with a STATED tuple contract, `/** @param {[number, number, number,
// number, number]} args */ function texStorage2D( ...args ) { gl.texStorage2D(
// ...args ) }`, forwarded into a host function with five NAMED formals and no
// rest slot. The tuple's arity is a declared fact, so the spread is exactly
// five positional reads -- the same expansion `f(...pair)` gets when `pair`
// is a closed tuple LOCAL. Read through the rest parameter's own cell it was
// refused as "a spread argument whose source has a native iteration cursor
// can only be range-copied into a rest parameter" (the three.js app, 2026-09-14): the
// cell's census type is the array the rest slot materializes, and the
// declared tuple was never consulted.
/** @param {[number, number]} args */
function forward(...args) {
  return sum(...args)
}
function sum(a, b) {
  return a + b
}
/** @param {[string, number, number]} args */
function label(...args) {
  return describe(...args)
}
function describe(name, x, y) {
  return name + ':' + x * y
}
console.log(forward(3, 4))
console.log(label('area', 5, 6))
//! expect: 7
//! expect: area:30
