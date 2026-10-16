// @ts-nocheck -- checkJs reports TS2610 for an accessor over an inherited property; three.js ships this shape from node_modules, where it is never checked
// three.js's `Material.setValues( values )` reads `this[ key ]` and skips any
// key whose current value is undefined. `alphaTest` is an accessor on
// `Material` itself, and `sheen` one that `MeshPhysicalMaterial` redeclares
// over a data property the base's `fromJSON` assigns. OrdinaryGet finds no own
// property for either and continues to the prototype, so the computed read
// must call the getter and the computed write the setter; reading only own
// storage dropped every such parameter with a warning.
class GlazeMaterial {
  constructor() {
    this.type = 'Glaze'
    this.color = 1
    this._cutoff = 0
  }
  get cutoff() {
    return this._cutoff
  }
  set cutoff(value) {
    this._cutoff = value
  }
  fromJSON(json) {
    if (json.sheen !== undefined) this.sheen = json.sheen
  }
  /**
   * @param {Object} [values]
   */
  setValues(values) {
    if (values === undefined) return
    for (const key in values) {
      const newValue = values[key]
      if (newValue === undefined) continue
      const currentValue = this[key]
      if (currentValue === undefined) {
        console.log(`'${key}' is not a property of ${this.type}`)
        continue
      }
      this[key] = newValue
    }
  }
}
class PaintedMaterial extends GlazeMaterial {
  constructor(parameters) {
    super()
    this.type = 'Painted'
    this.setValues(parameters)
  }
}
class FabricMaterial extends GlazeMaterial {
  constructor(parameters) {
    super()
    this.type = 'Fabric'
    this._sheen = 0
    this.setValues(parameters)
  }
  get sheen() {
    return this._sheen
  }
  set sheen(value) {
    this._sheen = value
  }
}

const painted = new PaintedMaterial({ cutoff: 0.5, color: 2 })
console.log(painted.cutoff, painted.color)
const fabric = new FabricMaterial({ cutoff: 0.25, sheen: 0.75 })
console.log(fabric.cutoff, fabric.sheen)
const loaded = new PaintedMaterial({ color: 3 })
loaded.fromJSON(JSON.parse('{"sheen":0.5}'))
console.log(loaded.color, loaded.sheen)

//! expect: 0.5 2
//! expect: 0.25 0.75
//! expect: 3 0.5
