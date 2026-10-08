// @ts-nocheck
//! expect-refusal: no runtime conversion is installed from constructor-identity
// `light.constructor` read off a `Light` can be `Light` itself, which the
// parameter's union of light classes does not name: no arm can hold that
// class, so the conversion is refused rather than storing `Light` in another
// class's arm.
class Light {}
class PointLight extends Light {}
class SpotLight extends Light {}

class Library {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    /** @type {WeakMap<(typeof PointLight|typeof SpotLight), string>} */
    this.names = new WeakMap()
  }
  /** @param {(typeof PointLight|typeof SpotLight)} light */
  nameOf(light) {
    return this.names.get(light) ?? 'none'
  }
}

const library = new Library()
library.names.set(PointLight, 'point')
/** @type {Array<Light>} */
const lights = [new PointLight(), new Light()]
for (const light of lights) console.log(library.nameOf(light.constructor))
