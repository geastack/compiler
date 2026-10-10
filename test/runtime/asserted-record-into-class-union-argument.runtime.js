// @ts-nocheck
// a 3D scene-graph library's `Material.setValues` (as a native WebGL plugin rewrites it)
// hands a parameter value to `Color.set` through a JSDoc assertion:
// `colorValue.value.set( /** @type {number|string|Color|undefined} */ ( newValue ) )`.
// The values the program passes are records, so the asserted operand is a
// record and the slot is `number | string | Color | undefined`. A record
// reaches that slot only as a view of a Color allocation; the assertion is
// the author's promise that it is one, checked at runtime like any `as T`.

class Color {
  constructor(hex) {
    this.isColor = true
    this.hex = hex
  }
  /** @param {number|string|Color} [value] */
  set(value) {
    if (value && value.isColor) this.hex = value.hex
    else if (typeof value === 'number') this.hex = value
    else if (typeof value === 'string') this.hex = parseInt(value, 16)
    return this
  }
}

class Material {
  constructor() {
    this.color = new Color(0)
    this.uniforms = { tint: { value: 0 } }
  }
}

/** @param {Material} material @param {Object} [values] */
function setValues(material, values) {
  if (values === undefined) return
  for (const key in values) {
    const newValue = values[key]
    if (newValue === undefined) continue
    const currentValue = material[key]
    if (currentValue === undefined) continue
    if (currentValue && currentValue.isColor) {
      const colorValue = { value: /** @type {Color} */ (currentValue) }
      colorValue.value.set(/** @type {number|string|Color|undefined} */ (newValue))
    } else {
      material[key] = newValue
    }
  }
}

const material = new Material()
setValues(material, { uniforms: { tint: { value: 3 } } })
console.log(material.uniforms.tint.value, material.color.hex)

//! expect: 3 0
//! emitted-has: gea::host::unhomedAssertedRecord
