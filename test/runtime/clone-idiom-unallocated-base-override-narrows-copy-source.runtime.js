// A 3D scene-graph library's `Shadow.clone() { return new
// this.constructor().copy( this ) }` where the base is never allocated itself:
// `new this.constructor()` is only ever a `DirectionalShadow` (inheriting
// `copy`) or a `SpotShadow` (overriding `copy( source )` with its own class).
// The `.copy` read off each receiver arm enters the base declaration's
// `(source: Shadow) => Shadow` slot, so the override's own-class parameter
// needs the source argument carried back to its class.
class Shade {
  /** @param {number} size */
  constructor(size) {
    this.size = size
  }
  /**
   * @param {Shade} source
   * @return {Shade}
   */
  copy(source) {
    this.size = source.size
    return this
  }
  /** @return {Shade} */
  clone() {
    return new this.constructor().copy(this)
  }
}
class FlatShade extends Shade {
  constructor() {
    super(2)
  }
}
class ConeShade extends Shade {
  constructor() {
    super(4)
    this.focus = 1
  }
  /**
   * @param {ConeShade} source
   * @return {ConeShade}
   */
  copy(source) {
    super.copy(source)
    this.focus = source.focus
    return this
  }
}

const flat = new FlatShade()
flat.size = 8
const cone = new ConeShade()
cone.size = 16
cone.focus = 0.5
/** @type {Shade[]} */
const shades = [flat, cone]
for (const shade of shades) {
  const copy = shade.clone()
  console.log(copy.size, copy instanceof FlatShade, copy instanceof ConeShade)
}
const coneCopy = cone.clone()
console.log(coneCopy instanceof ConeShade ? coneCopy.focus : -1)

//! expect: 8 true false
//! expect: 16 false true
//! expect: 0.5
