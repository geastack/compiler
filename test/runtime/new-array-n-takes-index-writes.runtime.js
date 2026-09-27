// @ts-nocheck
//
// `new Array( n )` stored into an unstated cell and filled by index writes
// (three's Material.copy: `let dstPlanes = null`, `dstPlanes = new Array( n )`,
// `dstPlanes[ i ] = srcPlanes[ i ].clone()`, then `this.clippingPlanes =
// dstPlanes` into `@type {?Array<Plane>}`). `new Array( n )` is n holes, an
// allocation that states no element, as `[]` does, so the array census owns
// it and its index writes type it. It used to keep the checker's `any[]`, so
// the cell was an array of dynamic values stored into an array of Plane.
class Plane {
  constructor(c = 0) {
    /** @type {number} */
    this.constant = c
  }
  /** @return {Plane} */
  clone() {
    return new Plane(this.constant)
  }
}
class Material {
  constructor() {
    /** @type {?Array<Plane>} */
    this.clippingPlanes = null
  }
  /**
   * @param {Material} source
   * @return {Material}
   */
  copy(source) {
    const srcPlanes = source.clippingPlanes
    let dstPlanes = null
    if (srcPlanes !== null) {
      const n = srcPlanes.length
      dstPlanes = new Array(n)
      for (let i = 0; i !== n; ++i) {
        dstPlanes[i] = srcPlanes[i].clone()
      }
    }
    this.clippingPlanes = dstPlanes
    return this
  }
}
const a = new Material()
a.clippingPlanes = [new Plane(3), new Plane(4)]
const b = new Material().copy(a)
a.clippingPlanes[0].constant = 9
console.log(b.clippingPlanes.length, b.clippingPlanes[0].constant, b.clippingPlanes[1].constant)
console.log(new Material().copy(new Material()).clippingPlanes === null)
//! expect: 2 3 4
//! expect: true
