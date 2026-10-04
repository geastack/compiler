// @ts-nocheck
//! expect: node
//! expect: got:frame-renderer
//! expect: omitted
// Every override of a root that declares no formal takes its argument as
// `@param {any}` (three's `updateReference( state )`). The family's slot
// stopped at the root's formals because a `dynamic` position does not join,
// and the check below it let the override through because `dynamic` holds
// undefined: the call dropped `this` and the override ran with `undefined`,
// printing "omitted" where node prints "got:frame-renderer". The slot now
// carries the position at the carrier the calls pass (`NodeFrame`, optional
// since `updateAlone` omits it), and the adapter boxes it for the override.
class NodeFrame {
  constructor() {
    this.renderer = 'frame-renderer'
  }
  /** @param {Node} node */
  updateNode(node) {
    return node.updateReference(this)
  }
  /** @param {Node} node */
  updateAlone(node) {
    return node.updateReference()
  }
}
class Node {
  constructor() {
    this.tag = 'node'
  }
  /**
   * @param {any} state
   * @return {any}
   */
  updateReference(/*state*/) {
    return this
  }
}
class FrameNode extends Node {
  constructor() {
    super()
    this.tag = 'frame-node'
  }
  /**
   * @param {any} state
   * @return {Node}
   */
  updateReference(state) {
    this.tag = state === undefined ? 'omitted' : 'got:' + state.renderer
    return this
  }
}
const frame = new NodeFrame()
/** @type {Node[]} */
const nodes = [new Node(), new FrameNode()]
for (const n of nodes) console.log(frame.updateNode(n).tag)
console.log(frame.updateAlone(new FrameNode()).tag)
export {}
