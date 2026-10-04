// @ts-nocheck
//! expect: base frame:frame-renderer omitted
//! expect: viewport viewport:viewport-renderer
// three's `Node.updateReference( /*state*/ )` declares no formal, and its
// overrides read the state a caller typed as `Node` passes
// (`nodeObject.updateReference( this )`). The family's dispatch slot takes the
// overrides' parameters past the root's: before, it stopped at the root's
// formals and every override ran with `undefined` for an argument its caller
// passed. A call that omits the argument still binds `undefined` (ECMA-262
// 10.2.11), and two overrides typed with different frame classes meet at
// their shared class, narrowed back per override.
class Frame {
  /** @param {string} renderer */
  constructor(renderer) {
    this.renderer = renderer
  }
}
class ViewportFrame extends Frame {
  constructor() {
    super('viewport-renderer')
    this.viewport = 'viewport'
  }
}
class Node {
  updateReference(/*state*/) {
    return 'base'
  }
}
class FrameNode extends Node {
  /** @param {Frame} [frame] */
  updateReference(frame) {
    return frame === undefined ? 'omitted' : 'frame:' + frame.renderer
  }
}
class ViewportNode extends Node {
  /** @param {ViewportFrame} [frame] */
  updateReference(frame) {
    return frame === undefined ? 'omitted' : frame.viewport + ':' + frame.renderer
  }
}
/** @param {Node} node @param {Frame} frame */
const update = (node, frame) => node.updateReference(frame)
/** @param {Node} node */
const updateAlone = (node) => node.updateReference()
const frame = new Frame('frame-renderer')
console.log(update(new Node(), frame), update(new FrameNode(), frame), updateAlone(new FrameNode()))
console.log('viewport', update(new ViewportNode(), new ViewportFrame()))
export {}
