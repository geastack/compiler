// @ts-nocheck
//! expect: true false true | 7 undefined | false
//! emitted-has: gea::keyedCollectionOrdinaryGet
// A computed key on a WeakMap reads and writes the WeakMap OBJECT's ordinary
// own property named by ToPropertyKey(key), not an entry. three's ShadowNode
// keys its per-camera frame ids that way, so every camera shares the one
// "[object Object]" slot; this is what three runs.
class Camera {
  constructor(name) {
    this.name = name
  }
}
class Shadow {
  constructor() {
    /** @type {WeakMap<Camera,number>} */
    this._cameraFrameId = new WeakMap()
  }
  /**
   * @param {Camera} camera
   * @param {number} frameId
   */
  update(camera, frameId) {
    if (this._cameraFrameId[camera] === frameId) return false
    this._cameraFrameId[camera] = frameId
    return true
  }
}
const shadow = new Shadow()
const left = new Camera('left')
const right = new Camera('right')
const first = shadow.update(left, 7)
// The second camera finds the first camera's id: one shared slot.
const second = shadow.update(right, 7)
const third = shadow.update(right, 8)
shadow._cameraFrameId[left] = 7
const stored = shadow._cameraFrameId[right]
const entries = shadow._cameraFrameId.get(left)
console.log(first, second, third, '|', stored, entries, '|', shadow._cameraFrameId.has(left))
