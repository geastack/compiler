// `value.toJSON` read off a union of a number and a class that declares the
// method: the scalar arm has no such member, so it answers `undefined`, and the
// read's result is the open carrier (the class arm publishes a method there).
// A 3D scene-graph library's `ShadedMaterial.toJSON` walks uniforms shaped exactly like this.

class Texture {
  constructor() {
    this.isTexture = true
  }
  toJSON() {
    return 'texture'
  }
}

/** @type {Record<string, any>} */
const bag = {}
bag.a = { value: 3 }
bag.b = { value: new Texture() }
let out = ''
for (const name in bag) {
  const value = bag[name].value
  const read = value.toJSON
  out += typeof read + ' '
}
//! expect: undefined function
console.log(out.trim())
