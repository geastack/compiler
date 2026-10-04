// @ts-nocheck
//! expect: direct:none
//! expect: boxed:frame
//! expect: plain:frame!
// Every call through the family's slot omits the argument, so the slot ends
// before the override's `@param {any}` formal (a box no static slot carrier
// joins) and the adapter supplies `undefined`: the language's own answer for
// those calls. A call on a box the flow cannot
// narrow back to the class does not go through the slot: the boxed read
// calls the override's own body, at its own convention, and keeps the
// argument.
class Frame {
  constructor() {
    this.name = 'frame'
  }
}
class Node {
  /** @return {string} */
  updateReference(/*state*/) {
    return 'none'
  }
}
class FrameNode extends Node {
  /**
   * @param {any} state
   * @return {string}
   */
  updateReference(state) {
    return state === undefined ? 'none' : state.name
  }
}
/** @type {Node} */
const node = new FrameNode()
console.log('direct:' + node.updateReference())
/**
 * @param {any} target
 * @param {Frame} frame
 */
const poke = (target, frame) => target.updateReference(frame)
console.log('boxed:' + poke(node, new Frame()))
console.log('plain:' + poke({ updateReference: (/** @type {Frame} */ state) => state.name + '!' }, new Frame()))
export {}
