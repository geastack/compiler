// @ts-nocheck
//! expect: map null
//! expect: filter 3
//! expect: missing undefined

// three's `NodeMaterial.setDefaultValues` copies another material's own keys
// onto a node material, so `MeshBasicNodeMaterial` gets `map` from
// `MeshBasicMaterial`. A class instance's prototype chain never holds
// `Array.prototype`, so a key named like one of its methods is an ordinary
// property here, present or not, and never a refusal by that name.
class Base {
  constructor() {
    this.color = 1
  }
  setDefaultValues(source) {
    for (const key in source) {
      if (this[key] === undefined) this[key] = source[key]
    }
  }
}
class Source {
  constructor() {
    this.map = null
    this.filter = 3
    this.color = 2
  }
}
class Material extends Base {
  constructor() {
    super()
    this.setDefaultValues(new Source())
  }
}
const material = new Material()
console.log('map', material.map)
console.log('filter', material.filter)
console.log('missing', material.join)
