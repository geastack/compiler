// @ts-nocheck
//! expect: 1.4999999999999998 0.49999999999999983
// three's `MeshPhysicalMaterial` (`materials/MeshPhysicalMaterial.js`): an
// accessor pair defined on `this` with plain `function` expressions. The
// setter assigns to `this`, so the checker also gives it a construct
// signature, `(): set`, whose frame is not the setter's `( reflectivity )`.
// Nothing constructs it; the body is entered through `[[Call]]` alone.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
class Mat {
  constructor() {
    this.ior = 1.5
    Object.defineProperty( this, 'reflectivity', {
      get: function () {
        return ( clamp( 2.5 * ( this.ior - 1 ) / ( this.ior + 1 ), 0, 1 ) );
      },
      set: function ( reflectivity ) {
        this.ior = ( 1 + 0.4 * reflectivity ) / ( 1 - 0.4 * reflectivity );
      }
    } );
  }
}
const m = new Mat()
m.reflectivity = 0.5
console.log(m.ior, m.reflectivity)
