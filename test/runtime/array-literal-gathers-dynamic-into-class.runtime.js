// @ts-nocheck
//! expect: a,b,c
// three's `LightsNode.setupLightsNode` (`nodes/lighting/LightsNode.js`):
// `[ ...materialLightings, ...this._lights ]` gathers a dynamic context value
// into an array the callee states as `Array<Light>`. Each drained value is
// converted into the light carrier on the way in.
class Light {
  constructor(name) {
    this.name = name
  }
}
/**
 * @param {Array<Light>} lights
 * @return {string}
 */
const names = (lights) => lights.map((light) => light.name).join(',')
class LightsNode {
  constructor() {
    /** @type {Array<Light>} */
    this._lights = [new Light('c')]
  }
  setup(context) {
    const materialLightings = context.materialLightings
    return names([...materialLightings, ...this._lights])
  }
}
const context = JSON.parse('{}')
context.materialLightings = [new Light('a'), new Light('b')]
console.log(new LightsNode().setup(context))
