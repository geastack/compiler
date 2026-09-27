// @ts-nocheck
//
// A local refilled when a lookup misses (three's WebGLState.setMRTDrawBuffers:
// `drawBuffers = this.currentDrawbuffers.get( framebuffer )`, then `if (
// drawBuffers === undefined ) { drawBuffers = [] ... }`). Every read after the
// guard sees an array: the lookup's `undefined` is replaced before it is read.
// The checker types the cell `any`, so the reads kept the census's
// `undefined` arm and each one tested presence again -- and at three's
// `gl.drawBuffers( drawBuffers )` the union had no conversion into the host
// parameter. The forward walk (`valuesReachingRead`) drops the arm there.
//! emitted-lacks: throwGetPropertyOfNullish
class State {
  constructor() {
    this.cache = new Map()
    this.sent = 0
  }
  /** @param {number[]} xs */
  send(xs) {
    this.sent += xs.length
  }
  /**
   * @param {string} key
   * @param {number} n
   */
  update(key, n) {
    let list = []
    let changed = false
    if (n > 0) {
      list = this.cache.get(key)
      if (list === undefined) {
        list = []
        this.cache.set(key, list)
      }
      if (list.length !== n) {
        for (let i = 0; i < n; i++) list[i] = 10 + i
        list.length = n
        changed = true
      }
    } else {
      changed = true
    }
    if (changed) this.send(list)
    return list.join()
  }
}
const s = new State()
const key = 'fb1'
console.log(s.update(key, 2), s.update(key, 2), s.update(key, 0), s.sent)
//! expect: 10,11 10,11  2
