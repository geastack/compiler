// @ts-nocheck
//! expect: direct:none
//! expect: dynamic:frame
//! expect: computed:frame
// The slot of a family whose root declares no formal may stop before an
// override's formal only when no call through the slot passes it. Every other
// way a program can call the override must still hand it the argument: a
// call through a box (the dynamic read calls the body itself) and a
// computed-key call. A method value read off the object is the other way, and
// `virtual-family-method-value-narrowed-by-root-refuses` covers it. Here
// the direct call through the slot omits the argument and the `any` one --
// which flow narrows back to the class, so it goes through the slot too --
// passes it, so the slot carries it optional.
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
console.log('direct:' + node.updateReference())
/** @type {any} */
const boxed = node
console.log('dynamic:' + boxed.updateReference(frame))
/** @type {string} */
const key = ['update', 'Reference'].join('')
console.log('computed:' + node[key](frame))
export {}
