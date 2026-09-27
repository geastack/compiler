// @ts-nocheck
//! expect: 7 3
// three's WebGLBackend.compute: in `count && typeof count === 'object' &&
// count.isIndirectStorageBufferAttribute` over a `?number`, the checker
// narrows the last `count` to `never`. The read is dead, but it still needs
// a carrier its cell converts into.
class Backend {
  /**
   * @param {Object} computeNode
   * @param {?number} [count=null]
   * @return {number}
   */
  compute(computeNode, count = null) {
    count = count !== null ? count : computeNode.count
    if (count && typeof count === 'object' && count.isIndirectStorageBufferAttribute) {
      count = computeNode.count
    }
    return count
  }
}
class CN {
  constructor() {
    /** @type {number} */
    this.count = 7
  }
}
const b = new Backend()
console.log(b.compute(new CN()) + ' ' + b.compute(new CN(), 3))
