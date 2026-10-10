// @ts-nocheck
// `setValues( values )` walks a bag with `for...in` and stores each present
// value into the instance field of the same name with `this[ key ] = value`.
// Every key the bag holds at run time -- its literal members and the members
// a caller added conditionally -- must land in the field it names.
//! expect: 1016 1003 linear false 1006
//! expect: 1009 1006 none false 1006

class Surface {
  constructor() {
    /** @type {number} */
    this.type = 1009
    /** @type {number} */
    this.magFilter = 1006
    /** @type {string} */
    this.colorSpace = 'none'
    /** @type {boolean} */
    this.flipY = true
    /** @type {number} */
    this.minFilter = 1008
  }

  /** @param {Object} values */
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) continue
      if (this[key] === undefined) continue
      this[key] = newValue
    }
  }
}

function apply(options) {
  const values = { minFilter: 1006, flipY: false }
  if (options.type !== undefined) values.type = options.type
  if (options.magFilter !== undefined) values.magFilter = options.magFilter
  if (options.colorSpace !== undefined) values.colorSpace = options.colorSpace
  const surface = new Surface()
  surface.setValues(values)
  console.log(surface.type, surface.magFilter, surface.colorSpace, surface.flipY, surface.minFilter)
}

apply({ type: 1016, magFilter: 1003, colorSpace: 'linear' })
apply({})
