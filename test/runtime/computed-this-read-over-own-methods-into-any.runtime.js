// @ts-nocheck
// A 3D scene-graph library's `Material.setValues` reads `this[ key ]` for every key of the
// parameter object it was handed, so the read's key is any string and its
// value is `any`: a field, or one of the class's own methods -- including
// `setValues` itself. The method values are the class's Function objects.

class Material {
  constructor() {
    this.opacity = 1
    this.name = 'm'
  }
  /** @param {Object} [values] */
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      const currentValue = this[key]
      if (currentValue === undefined) {
        console.log('no', key)
        continue
      }
      if (typeof currentValue === 'function') {
        console.log('method', key)
        continue
      }
      this[key] = newValue
    }
  }
}

const material = new Material()
material.setValues({ opacity: 0.5, setValues: 1, missing: 2 })
console.log(material.opacity, typeof material.setValues)

//! expect: method setValues
//! expect: no missing
//! expect: 0.5 function
