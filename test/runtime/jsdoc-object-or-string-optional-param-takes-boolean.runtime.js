// A 3D scene-graph library's `SceneNode.toJSON( meta )` is documented `@param {?(Object|string)}`
// and its light-shadow class calls it as `camera.toJSON( false )`. The parameter's carrier
// is `optional(string | <Object>)`: JSDoc's `Object` is a dynamic arm. A
// boolean argument enters that slot, and the dynamic arm is what holds it.

class Node3 {
  /**
   * @param {?(Object|string)} [meta] - optional meta information.
   * @return {*}
   */
  toJSON(meta) {
    const isRoot = meta === undefined || typeof meta === 'string'
    return { root: isRoot, kind: typeof meta }
  }
}

class Cam extends Node3 {
  /**
   * @param {?(Object|string)} [meta]
   * @return {*}
   */
  toJSON(meta) {
    const data = super.toJSON(meta)
    data.cam = true
    return data
  }
}

const cam = new Cam()
//! expect: false boolean
const viaFalse = cam.toJSON(false)
console.log(viaFalse.root + ' ' + viaFalse.kind)
//! expect: true undefined
const viaNone = cam.toJSON()
console.log(viaNone.root + ' ' + viaNone.kind)
//! expect: true string
const viaString = cam.toJSON('x')
console.log(viaString.root + ' ' + viaString.kind)
