// A 3D renderer's GPU-state module wraps each GL call as a function that forwards its
// `arguments` (`function compressedTexImage2D() { gl.compressedTexImage2D(
// ...arguments ) }`) and returns them in one state object. When that object
// is reached dynamically, each wrapper is boxed, and its argument list --
// carried as a fixed tuple record, not an Array -- crosses the dynamic call
// boundary in both directions.

const seen = []
const gl = {
  /** @param {number} target @param {number} level @param {string} format */
  texImage(target, level, format) {
    seen.push(target + ':' + level + ':' + format)
  }
}

function texImage() {
  // @ts-ignore -- JS forwards `arguments` to a fixed-arity call, as such a renderer does
  gl.texImage(...arguments)
}

function makeState() {
  return { texImage }
}

/** @type {any} */
const state = makeState()
state.texImage(1, 2, 'rgba')
const call = state['tex' + 'Image']
call(3, 4, 'srgb')
//! expect: 1:2:rgba 3:4:srgb
console.log(seen.join(' '))
//! expect: keys=texImage
console.log('keys=' + Object.keys(state).join(','))
