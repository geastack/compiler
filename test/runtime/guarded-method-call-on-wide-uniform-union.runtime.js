// A 3D scene-graph library's material `toJSON` walks `this.uniforms` and, behind
// `value && value.isColor`, calls `value.getHex()`. The uniform values the
// program stores are numbers, booleans, arrays and several classes, so the
// read of `getHex` is off a wide tagged union, and the call must still pass
// the colour as the method's receiver.

const Management = { offset: 0 }
const _scratch = { hex: 0 }

class Color {
  constructor(hex) {
    this.isColor = true
    this.hex = hex
  }
  /** @param {string} [space] */
  getHex(space = 'srgb') {
    _scratch.hex = this.hex + Management.offset
    return _scratch.hex + (space === 'srgb' ? 0 : 1)
  }
}

class Texture {
  constructor() {
    this.isTexture = true
  }
  toJSON() {
    return 'tex'
  }
}

class Material {
  constructor() {
    /** @type {Object} */
    this.uniforms = {}
  }
}

const material = new Material()
material.uniforms.a = { value: 3 }
material.uniforms.b = { value: true }
material.uniforms.c = { value: [1, 2] }
material.uniforms.d = { value: new Color(255) }
material.uniforms.e = { value: new Texture() }

let out = ''
for (const name in material.uniforms) {
  const value = material.uniforms[name].value
  if (value && value.isTexture) out += name + '=' + value.toJSON() + ' '
  else if (value && value.isColor) out += name + '=' + value.getHex() + ' '
  else out += name + '=' + value + ' '
}
//! expect: a=3 b=true c=1,2 d=255 e=tex
console.log(out.trim())
