// @ts-nocheck
//! expect-refusal: the @param type of parameter "node" of getData was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "node" of setData was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// three's `BufferAttributeNode.getHash( builder )` keys the node cache by
// `this.value` -- `InputNode`'s `@type {any}` field, which the binding census
// carries as the `BufferAttribute | Float32Array` the constructors store --
// under `NodeCache.getData( node )`'s `@param {Node} node`. The checker types
// the argument `any` and says nothing; the settled census contradicts the tag,
// which then loses, as a tag the checker could contradict does.
//
// Losing the tag does not make `node` dynamic. The census of `getData`'s and
// `setData`'s callers stays open (the member proof cannot close the `cache`
// receivers reached through `getHash`), so it cannot type `node` from its
// complete callers, and as `any` the parameter would box the class and typed
// array values passed to it. Both parameters are refused by name instead, as
// main refuses this program at the call (no conversion from the census union
// to `GNode`). The refusal moves when that member proof closes.
let nextId = 1
class GNode {
  constructor() {
    this.id = nextId++
  }
}
class NodeCache {
  constructor() {
    this.nodesData = new WeakMap()
  }
  /**
   * @param {GNode} node - The node.
   * @return {?Object} The data.
   */
  getData(node) {
    return this.nodesData.get(node)
  }
  /**
   * @param {GNode} node - The node.
   * @param {Object} data - The data.
   */
  setData(node, data) {
    this.nodesData.set(node, data)
  }
}
class BufferAttribute {
  constructor(array) {
    this.array = array
  }
}
class InputNode extends GNode {
  /** @param {any} value - The value. */
  constructor(value) {
    super()
    /** @type {any} */
    this.value = value
  }
}
class BufferAttributeNode extends InputNode {
  /** @param {BufferAttribute|Float32Array} value - data. */
  constructor(value) {
    super(value)
  }
  /** @param {NodeCache} cache - c. */
  getHash(cache) {
    let bufferData = cache.getData(this.value)
    if (bufferData === undefined) {
      bufferData = { node: this }
      cache.setData(this.value, bufferData)
    }
    return String(bufferData.node.id)
  }
}
const cache = new NodeCache()
const n = new GNode()
cache.setData(n, { node: n })
const a = new BufferAttributeNode(new BufferAttribute(new Float32Array(3)))
const b = new BufferAttributeNode(new Float32Array(2))
const c = new InputNode(1)
console.log(a.getHash(cache) + ' ' + a.getHash(cache) + ' ' + b.getHash(cache) + ' ' + c.value + ' ' + cache.getData(n).node.id)
