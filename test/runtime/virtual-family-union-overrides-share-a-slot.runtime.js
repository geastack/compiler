// @ts-nocheck
//! expect: root:none
//! expect: ref:frame
//! expect: ref:builder
//! expect: viewport:frame!
//! expect: viewport:builder!
// three's `updateReference`: the root declares no formal, most overrides state
// `@param {(NodeFrame|NodeBuilder)} state`, and `ViewportTextureNode`'s leaves
// it untagged, so it holds what the calls through the slot pass. Those pass a
// `NodeFrame` or a `NodeBuilder`, each of which goes into exactly one arm of the
// declared union, so the slot carries the union and each override takes it.
class NodeFrame {
  constructor() {
    this.kind = 'frame'
  }
}
class NodeBuilder {
  constructor() {
    this.kind = 'builder'
  }
}
class Node {
  /** @return {string} */
  updateReference(/*state*/) {
    return 'none'
  }
}
class ReferenceNode extends Node {
  /**
   * @param {(NodeFrame|NodeBuilder)} state
   * @return {string}
   */
  updateReference(state) {
    return state.kind
  }
}
class ViewportNode extends Node {
  /**
   * @param {any} frame
   * @return {string}
   */
  updateReference(frame) {
    return frame.kind + '!'
  }
}
const frame = new NodeFrame()
const builder = new NodeBuilder()
/** @type {Node[]} */
const nodes = [new Node(), new ReferenceNode(), new ViewportNode()]
const names = ['root', 'ref', 'viewport']
/**
 * @param {Node} node
 * @param {string} name
 */
const show = (node, name) => {
  if (name === 'root') {
    console.log(name + ':' + node.updateReference(frame))
    return
  }
  console.log(name + ':' + node.updateReference(frame))
  console.log(name + ':' + node.updateReference(builder))
}
for (let i = 0; i < nodes.length; i++) show(nodes[i], names[i])
export {}
