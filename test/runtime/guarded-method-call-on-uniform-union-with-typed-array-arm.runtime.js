// @ts-nocheck
// A 3D scene-graph library's material `toJSON` reads `value.toJSON( meta )` behind
// `value && value.isTexture`, off uniform values that include typed arrays.
// The method is read off a sum whose arms are classes and typed-array views,
// and the call still hands the texture over as its receiver: a typed-array
// arm is an object receiver like the class arms beside it.

class Color {
  constructor(hex) {
    this.isColor = true
    this.hex = hex
  }
  getHex() {
    return this.hex
  }
}

class Texture {
  constructor() {
    this.isTexture = true
    this.uuid = 'tex-1'
  }
  /** @param {any} meta */
  toJSON(meta) {
    return this.uuid + ':' + typeof meta
  }
}

class Material {
  constructor() {
    /** @type {Record<string, { value: number | boolean | null | undefined | Color | Texture | Float32Array | Int32Array }>} */
    this.uniforms = {}
  }
}

const material = new Material()
material.uniforms.a = { value: 3 }
material.uniforms.d = { value: new Color(255) }
material.uniforms.e = { value: new Texture() }
material.uniforms.f = { value: new Float32Array([0.25, 0.5]) }
material.uniforms.g = { value: new Int32Array([3]) }

let out = ''
for (const name in material.uniforms) {
  const value = material.uniforms[name].value
  if (value && value.isTexture) out += name + '=' + value.toJSON({}) + ' '
  else if (value && value.isColor) out += name + '=' + value.getHex() + ' '
  else out += name + '=' + value + ' '
}
console.log(out.trim())

// The same call on an arm without the method: the member reads `undefined`
// there, and calling it is a TypeError -- before any receiver conversion.
for (const name of ['d', 'f', 'a']) {
  const value = material.uniforms[name].value
  try {
    value.toJSON({})
    console.log(name, 'called')
  } catch (error) {
    console.log(name, error instanceof TypeError)
  }
}

//! expect: a=3 d=255 e=tex-1:object f=0.25,0.5 g=3
//! expect: d true
//! expect: f true
//! expect: a true
