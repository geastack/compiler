// @ts-nocheck
//! expect: present cleared true absent TypeError
//! expect: set TypeError
//! emitted-has: Cannot create property 'outputNode' on string
// A union of a primitive and an object, written through a key only the object
// arm has (three's `ComputeNode` build result `string | Node`, and
// `Renderer.highPrecision`'s `number | object` context data). The primitive
// arm's intact prototype chain has no such property, which the semantic proof
// states per domain, so [[Set]] finds no setter and answers false: a TypeError
// in this strict module, while the object arm stores.
class Node {
  constructor() {
    /** @type {Node|null} */
    this.outputNode = this
  }
}
/** @param {boolean} flag @returns {string|Node} */
const build = (flag) => (flag ? new Node() : 'snippet')
/** @param {boolean} flag */
const run = (flag) => {
  const result = build(flag)
  const read = result.outputNode
  try {
    result.outputNode = null
    return (read === undefined ? 'absent' : 'present') + ' cleared ' + (result.outputNode === null)
  } catch (error) {
    return (read === undefined ? 'absent' : 'present') + ' ' + (error instanceof TypeError ? 'TypeError' : 'other')
  }
}
console.log(run(true), run(false))
class Matrix {
  constructor() {
    this.name = 'highp'
  }
}
/** @param {boolean} flag @returns {number|{modelViewMatrix: Matrix|null}} */
const data = (flag) => (flag ? { modelViewMatrix: null } : 1)
/** @param {boolean} flag */
const setHigh = (flag) => {
  const contextNodeData = data(flag)
  try {
    contextNodeData.modelViewMatrix = new Matrix()
    return 'set'
  } catch (error) {
    return error instanceof TypeError ? 'TypeError' : 'other'
  }
}
console.log(setHigh(true), setHigh(false))
export {}
