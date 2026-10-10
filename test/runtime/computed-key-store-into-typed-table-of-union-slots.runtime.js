// @ts-nocheck
// A 3D scene-graph library's `Material.setValues` stores each parameter with `this[ key ] =
// newValue`; the webgl plugin states `ShadedMaterial.uniforms` as a
// `Record<string, { value: <union>, needsUpdate? }>` whose value union carries
// several Array arms. The stored object literal is that table -- viewed, not
// copied -- and each slot's value is selected into its union arm: a native
// Array by its own carrier, never by an overlapping "any Array" test.

class Vec {
  /** @param {number} x */
  constructor(x) {
    this.x = x
  }
}

/** @typedef {number|null|undefined|Vec|number[]|Vec[]} SlotValue */
/** @typedef {{ value: SlotValue, needsUpdate?: boolean }} Slot */
/** @typedef {Record<string, Slot>} Slots */

class Material {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    /** @type {Slots} */
    this.uniforms = {}
    this.name = ''
    this.setValues(parameters)
  }
  /** @param {Object} [values] */
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) continue
      const currentValue = this[key]
      if (currentValue === undefined) continue
      this[key] = newValue
    }
  }
  describe() {
    const out = []
    for (const name in this.uniforms) {
      const value = this.uniforms[name].value
      if (value instanceof Vec) out.push(name + ':vec' + value.x)
      else if (Array.isArray(value)) out.push(name + ':arr' + value.length)
      else out.push(name + ':' + value)
    }
    return out.join(' ')
  }
}

const uniforms = { a: { value: 2 }, b: { value: new Vec(3) }, c: { value: [1, 2] }, d: { value: [new Vec(1)] } }
const material = new Material({ uniforms })
uniforms.a.value = 5
console.log(material.describe())

//! expect: a:5 b:vec3 c:arr2 d:arr1
