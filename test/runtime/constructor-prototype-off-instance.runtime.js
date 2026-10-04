// @ts-nocheck
//! expect: values mapped opacity
//! expect: copy none flat
// three's `NodeMaterial.setValues` and `copy`: `Object.getOwnPropertyDescriptors(
// material.constructor.prototype )` lists the own accessors of the class that
// ALLOCATED the material -- a subclass's, not the declared `Material`'s --
// and `this.constructor.prototype` is the node material subclass's own.
class Material {
  constructor() {
    this.color = 1
    this._opacity = 1
  }
  get opacity() {
    return this._opacity
  }
  set opacity(value) {
    this._opacity = value
  }
}
class BasicMaterial extends Material {
  constructor() {
    super()
    this.map = null
    this.flat = true
  }
  get mapped() {
    return this.map !== null
  }
}
class NodeMaterial extends Material {
  /** @param {Material} material */
  setValues(material) {
    const descriptors = Object.getOwnPropertyDescriptors(material.constructor.prototype)
    const getters = []
    for (const key in descriptors) {
      if (Object.getOwnPropertyDescriptor(this.constructor.prototype, key) === undefined && descriptors[key].get !== undefined)
        getters.push(key)
    }
    return getters.join(',')
  }
  /** @param {Material} source */
  copy(source) {
    const descriptors = Object.getOwnPropertyDescriptors(this.constructor.prototype)
    const setters = []
    for (const property in descriptors) {
      if (descriptors[property].set !== undefined && source[property] !== undefined) setters.push(property)
    }
    return setters.join(',') || 'none'
  }
}
class MeshNodeMaterial extends NodeMaterial {
  get flat() {
    return false
  }
  set flat(value) {}
}
const node = new NodeMaterial()
console.log('values', node.setValues(new BasicMaterial()), node.setValues(new Material()))
console.log('copy', node.copy(new BasicMaterial()), new MeshNodeMaterial().copy(new BasicMaterial()))
