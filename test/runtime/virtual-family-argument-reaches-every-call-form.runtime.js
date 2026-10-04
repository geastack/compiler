// @ts-nocheck
//! expect: direct:none
//! known-wrong: extracted:none -- node prints extracted:frame
//! known-wrong: called:none -- node prints called:frame
//! expect: dynamic:frame
//! expect: computed:frame
// The slot of a family whose root declares no formal may stop before an
// override's formal only when no call through the slot passes it. Every other
// way a program can call the override must still hand it the argument: a
// method value read off the object (selected when it is read, and called
// through its own body), `Function.prototype.call` on one, a call through a
// box (the dynamic read calls the body itself), and a computed-key call. Here
// the direct call through the slot omits the argument and the `any` one --
// which flow narrows back to the class, so it goes through the slot too --
// passes it, so the slot carries it optional.
//
// The two known-wrong lines are not the slot's: a method value read off the
// object is selected at read time but published at the ROOT's convention (the
// checker's `() => string`), so a call through that value has no formal for
// the argument and the override runs with `undefined`.
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
const extracted = node.updateReference
console.log('extracted:' + extracted.call(node, frame))
const bound = node.updateReference.bind(node)
console.log('called:' + bound(frame))
/** @type {any} */
const boxed = node
console.log('dynamic:' + boxed.updateReference(frame))
/** @type {string} */
const key = ['update', 'Reference'].join('')
console.log('computed:' + node[key](frame))
export {}
