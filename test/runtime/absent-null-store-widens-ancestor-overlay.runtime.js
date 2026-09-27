// @ts-nocheck
//! expect: 5 3
// A field stated `@type {number|Array<number>}` and stored `null` admits the
// null (absent-jsdoc-tags.ts). The subclass-member overlay copies that tag onto
// the declarer's ancestors, and a read through an ancestor-typed receiver
// (`@param {Node}`) stores the field in the ancestor's slot, so the copies admit
// the null too. three's ComputeNode `this.dispatchSize = null`, read in
// WebGPUBackend.compute through `@param {Node} computeNode`.
class EventDispatcher {
  addEventListener( type ) { this._listeners = type }
}
class Node extends EventDispatcher {
  constructor() { super(); this.isNode = true }
}
class ComputeNode extends Node {
  constructor() {
    super()
    /**
     * @type {number|Array<number>}
     */
    this.count = null
    /**
     * @type {number|Array<number>}
     */
    this.dispatchSize = null
  }
}
/**
 * @param {number|Array<number>} count - The compute count or dispatch size.
 * @returns {ComputeNode}
 */
const compute = ( count ) => {
  const computeNode = new ComputeNode()
  if ( typeof count === 'number' ) {
    computeNode.count = count
  } else {
    computeNode.dispatchSize = count
  }
  return computeNode
}
class Backend {
  /**
   * @param {Node} computeNode
   */
  run( computeNode ) {
    const dispatchSize = computeNode.dispatchSize || computeNode.count
    return Array.isArray( dispatchSize ) ? dispatchSize.length : dispatchSize
  }
}
const b = new Backend()
console.log( b.run( compute( 5 ) ), b.run( compute( [ 1, 2, 3 ] ) ) )
export {}
