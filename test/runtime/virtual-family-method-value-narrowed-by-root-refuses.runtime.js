// @ts-nocheck
//! expect-refusal: overridden-method-value-narrows
// A method value read off an object is typed by the checker from the root's
// declaration, `() => string`, while the override it selects declares a
// formal. JS lets a caller pass the argument anyway -- through
// `Function.prototype.call` or a bound copy -- and node prints
// `extracted:frame` and `called:frame`. A carrier with no formal for it would
// drop it and run the override with `undefined`, so the read refuses.
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
   * @param {Frame} [state]
   * @return {string}
   */
  updateReference(state) {
    return state === undefined ? 'none' : state.name
  }
}
const frame = new Frame()
/** @type {Node} */
const node = new FrameNode()
const extracted = node.updateReference
console.log('extracted:' + extracted.call(node, frame))
const bound = node.updateReference.bind(node)
console.log('called:' + bound(frame))
export {}
