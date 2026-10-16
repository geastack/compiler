// @ts-nocheck -- checkJs reports TS2610 for an accessor over an inherited property; three.js ships this shape from node_modules, where it is never checked
// three.js's `Material.fromJSON` assigns `this.clearcoat = json.clearcoat`, so
// checkJs declares a `clearcoat` data property on the base, and
// `MeshPhysicalMaterial` redeclares the key as a getter/setter pair over
// `_clearcoat`. An instance of the subclass never owns a data property under
// the key: a read through a base-typed receiver (`copy( source )`'s
// `source.clearcoat`, `toJSON`'s `this.clearcoat`) calls the getter, and a
// base-typed write calls the setter. Reading the base slot instead aborted on
// its undefined when the setter took a number, and answered undefined
// everywhere else.
class SurfaceMaterial {
  constructor() {
    this.name = 'surface'
  }
  fromJSON(json) {
    if (json.coat !== undefined) this.coat = json.coat
    return this
  }
  toJSON() {
    const data = {}
    if (this.coat !== undefined) data.coat = this.coat
    return data
  }
  /**
   * @param {SurfaceMaterial} source
   * @return {SurfaceMaterial}
   */
  copy(source) {
    this.name = source.name
    return this
  }
  /** @return {SurfaceMaterial} */
  clone() {
    return new this.constructor().copy(this)
  }
}
class CoatedMaterial extends SurfaceMaterial {
  constructor() {
    super()
    this._coat = 0
  }
  get coat() {
    return this._coat
  }
  set coat(value) {
    this._coat = value
  }
  /**
   * @param {SurfaceMaterial} source
   * @return {SurfaceMaterial}
   */
  copy(source) {
    super.copy(source)
    this.coat = source.coat
    return this
  }
}
class MatteMaterial extends SurfaceMaterial {}

const coated = new CoatedMaterial()
coated.coat = 0.5
const twin = coated.clone()
console.log(twin instanceof CoatedMaterial, twin.coat, JSON.stringify(twin.toJSON()))
const loaded = new CoatedMaterial().fromJSON(JSON.parse('{"coat":3}'))
console.log(loaded.coat, JSON.stringify(loaded.toJSON()))
const matte = new MatteMaterial().fromJSON(JSON.parse('{"coat":2}'))
console.log(matte.coat, JSON.stringify(matte.toJSON()), JSON.stringify(new MatteMaterial().toJSON()))

//! expect: true 0.5 {"coat":0.5}
//! expect: 3 {"coat":3}
//! expect: 2 {"coat":2} {}
