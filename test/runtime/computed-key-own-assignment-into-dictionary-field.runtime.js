// @ts-nocheck
// A 3D scene-graph library's `Material.setValues( values )` copies each parameter onto the
// material with `this[ key ] = newValue`. `ShadedMaterial` declares
// `this.uniforms = {}` (`@type {Object}`) and reads it as a table of
// `{ value }` records, while the program passes `uniforms` as one object
// literal with fixed keys. JavaScript stores that very object: the material's
// table IS the parameter's literal, and a write through either is visible
// through the other.

class Material {
  /** @param {Object} [parameters] */
  constructor(parameters) {
    /** @type {Object} */
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
  total() {
    let sum = 0
    for (const name in this.uniforms) sum += this.uniforms[name].value
    return sum
  }
}

const uniforms = { tint: { value: 2 }, strength: { value: 0.5 } }
const material = new Material({ uniforms })
uniforms.tint.value = 3
console.log(material.total(), material.uniforms === uniforms)

//! expect: 3.5 true
