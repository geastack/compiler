// @ts-nocheck
//! expect-abort
//! expect: before 0
//! expect: Uncaught TypeError: Object.defineProperty with an accessor descriptor (get) is not rendered by this backend
// Plan 2.6 decision 5: `NodeMaterial.setDefaultValues` copies another
// material class's own getters onto the node material's prototype (only
// `MeshPhysicalMaterial` declares any). A declared getter's body takes its
// own class's receiver, and a node material is not one, so the copy stops
// the program by name when it runs rather than install a getter that reads
// the wrong object. It needs 2.8's receiver-generic clones to run. The
// refusal is an uncaught TypeError, which prints its message before the abort.
class ExtMaterial {
  constructor() {
    this.color = 1
  }
}
class ExtPhysicalMaterial extends ExtMaterial {
  constructor() {
    super()
    this._clearcoat = 0
  }
  get clearcoat() {
    return this._clearcoat
  }
  set clearcoat(value) {
    this._clearcoat = value
  }
}
class ExtNodeMaterial extends ExtMaterial {}

/** @param {any} material */
function setDefaultValues(material) {
  const descriptors = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(material))
  for (const key in descriptors) {
    if (Object.getOwnPropertyDescriptor(ExtNodeMaterial.prototype, key) === undefined && descriptors[key].get !== undefined) {
      Object.defineProperty(ExtNodeMaterial.prototype, key, descriptors[key])
    }
  }
}
const physical = new ExtPhysicalMaterial()
console.log('before', physical.clearcoat)
setDefaultValues(physical)
console.log('after', new ExtNodeMaterial().clearcoat)
