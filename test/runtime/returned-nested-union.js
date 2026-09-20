/** @param {number} choice @returns {number | string | undefined} */
function inner(choice) {
  if (choice === 0) return 17
  if (choice === 1) return 'texture'
  return undefined
}

// The inferred return joins an existing union with two additional arms.
// Each absence must remain distinguishable after native materialization.
function outer(value, mode) {
  if (mode === 0) return value
  if (mode === 1) return false
  return null
}

class Texture {
  id = 29
}

// A bare class must reach its leaf inside the grouped present alternatives.
function withObject(value, mode) {
  if (mode === 0) return value
  if (mode === 1) return new Texture()
  return null
}

//! expect: 17
//! expect: texture
//! expect: undefined
//! expect: false
//! expect: null
console.log(outer(inner(0), 0))
console.log(outer(inner(1), 0))
console.log(outer(inner(2), 0))
console.log(outer(inner(0), 1))
console.log(outer(inner(0), 2))
const texture = withObject(inner(0), 1)
//! expect: 29
if (texture instanceof Texture) console.log(texture.id)
