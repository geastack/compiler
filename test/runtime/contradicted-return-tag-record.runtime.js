// @ts-nocheck
//! expect: false false
//! expect: true

// three's `NodeFrame._getMaps` states `@return {Object<string,WeakMap<Object,
// number>>}` and returns `{ renderId: 0, frameId: 0 }`; its callers store the
// frame number into the "WeakMap" slot and compare one against it. The tag is
// contradicted by the function's own return, and is blanked like a
// contradicted field tag, so the returned record is what the callers read.
class TNode {
  constructor(id) {
    this.id = id
  }
}
class NodeFrame {
  constructor() {
    /**
     * @type {WeakMap<TNode, Object>}
     */
    this.updateMap = new WeakMap()
    /**
     * @type {number}
     */
    this.frameId = 0
  }
  /**
   * @param {WeakMap<TNode, Object>} referenceMap - The reference weak map.
   * @param {TNode} nodeRef - The reference to the current node.
   * @return {Object<string,WeakMap<Object, number>>} The dictionary.
   */
  _getMaps(referenceMap, nodeRef) {
    let maps = referenceMap.get(nodeRef)
    if (maps === undefined) {
      maps = {
        renderId: 0,
        frameId: 0
      }
      referenceMap.set(nodeRef, maps)
    }
    return maps
  }
  update(node) {
    const nodeUpdateMap = this._getMaps(this.updateMap, node)
    if (nodeUpdateMap.frameId !== this.frameId) {
      nodeUpdateMap.frameId = this.frameId
      return true
    }
    return false
  }
}
const frame = new NodeFrame()
const node = new TNode(1)
console.log(frame.update(node), frame.update(node))
frame.frameId++
console.log(frame.update(node))
