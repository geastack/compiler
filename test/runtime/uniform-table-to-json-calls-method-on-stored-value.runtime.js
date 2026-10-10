// A material's `toJSON( meta )` walks its uniforms table and calls
// `value.toJSON( meta )` on a uniform whose `value.isPicture` is true -- a
// method read off a value the uniforms table holds as whatever was stored
// (`@type {any}`). Other uniforms are recognised by their own `is*` brand flags
// (a colour, a two-component vector) or fall through as a plain number.

/** @typedef {{ uuid: string, name: string }} PictureJSON */
/** @typedef {{ pictures: Object<string, PictureJSON> }} SerializationMeta */
/**
 * @typedef {Object} UniformSlot
 * @property {any} value
 */
/** @typedef {{ type?: string, value: any }} UniformJSON */
/** @typedef {{ type: string, uniforms: Object<string, UniformJSON> }} MaterialJSON */

let nextId = 0

class Picture {
  constructor() {
    this.isPicture = true
    this.uuid = 'picture-' + ++nextId
    this.name = ''
  }

  /**
   * @param {SerializationMeta | string} [meta]
   * @return {PictureJSON}
   */
  toJSON(meta) {
    if (meta !== undefined && typeof meta !== 'string') {
      const existing = meta.pictures[this.uuid]
      if (existing !== undefined) return existing
    }
    const output = { uuid: this.uuid, name: this.name }
    if (meta !== undefined && typeof meta !== 'string') {
      meta.pictures[this.uuid] = output
    }
    return output
  }
}

class Rgb {
  constructor(r = 1, g = 1, b = 1) {
    this.isRgb = true
    this.r = r
    this.g = g
    this.b = b
  }

  /** @return {number} */
  getHex() {
    return (Math.round(this.r * 255) << 16) ^ (Math.round(this.g * 255) << 8) ^ (Math.round(this.b * 255) << 0)
  }
}

class Pair {
  constructor(x = 0, y = 0) {
    this.isPair = true
    this.x = x
    this.y = y
  }

  /** @return {Array<number>} */
  toArray() {
    return [this.x, this.y]
  }
}

class Material {
  /**
   * @param {{ uniforms?: Object<string, UniformSlot> }} [parameters]
   */
  constructor(parameters) {
    this.type = 'Material'
    /** @type {Object<string, UniformSlot>} */
    this.uniforms = {}
    if (parameters !== undefined && parameters.uniforms !== undefined) {
      this.uniforms = parameters.uniforms
    }
  }

  /**
   * @param {SerializationMeta | string} [meta]
   * @return {MaterialJSON}
   */
  toJSON(meta) {
    if (meta === undefined) {
      meta = { pictures: {} }
    }
    /** @type {MaterialJSON} */
    const data = { type: this.type, uniforms: {} }
    for (const name in this.uniforms) {
      const uniform = this.uniforms[name]
      if (uniform === undefined) continue
      const value = uniform.value
      if (value && value.isPicture) {
        data.uniforms[name] = { type: 't', value: value.toJSON(meta).uuid }
      } else if (value && value.isRgb) {
        data.uniforms[name] = { type: 'c', value: value.getHex() }
      } else if (value && value.isPair) {
        data.uniforms[name] = { type: 'v2', value: value.toArray() }
      } else {
        data.uniforms[name] = { value: value }
      }
    }
    return data
  }
}

const material = new Material({
  uniforms: {
    map: { value: new Picture() },
    tint: { value: new Rgb(1, 0, 0) },
    offset: { value: new Pair(2, 3) },
    strength: { value: 0.5 }
  }
})
const json = /** @type {{ uniforms: any }} */ (material.toJSON())
const uniforms = json.uniforms
console.log(uniforms.map.type, typeof uniforms.map.value, uniforms.tint.type, uniforms.tint.value)
console.log(uniforms.offset.type, uniforms.offset.value.join(','), uniforms.strength.value)

//! expect: t string c 16711680
//! expect: v2 2,3 0.5
