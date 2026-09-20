// A derived constructor's `super( color, intensity )` runs the base body on the
// object it already owns. The host-mutation census used to read that call as an
// unauthenticated callee, and an opaque argument there (the three.js app's light
// intensities come through untyped three.js parameters) was the `*` wildcard
// that refused every Object-prototype obligation in the program.
class Light {
  /**
   * @param {number} color
   * @param {number} [intensity]
   */
  constructor(color, intensity = 1) {
    this.color = color
    this.intensity = intensity
  }
}
class Directional extends Light {
  /**
   * @param {number} color
   * @param {number} [intensity]
   */
  constructor(color, intensity) {
    super(color, intensity)
    this.target = { x: 0 }
  }
}
const sun = new Directional(0xffffff, JSON.parse('0.9'))
console.log(sun.color + ':' + sun.intensity + ':' + sun.target.x)
const dim = new Directional(0x202020)
console.log(dim.intensity)
//! expect: 16777215:0.9:0
//! expect: 1
