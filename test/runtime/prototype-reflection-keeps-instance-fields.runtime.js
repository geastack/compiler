// @ts-nocheck
//! expect: before true
//! expect: after true true 1
// Handing a class's prototype object out materializes an instance of the
// class layout that owns none of its fields. Its presence bits must be its
// own: when they were class-wide constants, clearing them on the prototype
// made every instance lose its own fields to a dynamic read.
class Material {
  constructor() {
    this.color = 1
  }
}
class BasicMaterial extends Material {
  constructor() {
    super()
    this.flat = true
  }
}
/** @param {Material} material */
const reflect = (material) => Object.getOwnPropertyDescriptors(Object.getPrototypeOf(material))
/** @param {Material} source */
const read = (source) => source.flat
const held = new BasicMaterial()
console.log('before', read(held))
reflect(new BasicMaterial())
console.log('after', read(held), read(new BasicMaterial()), held.color)
