// @ts-nocheck
// three's `Node.onUpdate` and `onReference`, with the parameter type
// `@types/three` states for them: `callback.bind( this )` over a
// `(this: this, frame) => unknown` types as `OmitThisParameter<T>`, which the
// checker defers on `unknown extends this` although the polymorphic `this` is
// always a class instance. The bound value is the callback without its
// receiver, stored into the class's own method slot.
//! expect: 5 frame reference:builder 14
class GraphNode {
  constructor() {
    this.updateType = 'none'
    this.count = 0
  }

  /** @param {number} frame */
  update(frame) {
    return frame
  }

  /** @param {string | number} state */
  updateReference(state) {
    return state
  }

  /**
   * @param {(this: this, frame: number) => unknown} callback
   * @param {string} updateType
   * @return {GraphNode}
   */
  onUpdate(callback, updateType) {
    this.updateType = updateType
    this.update = callback.bind(this)
    return this
  }

  /**
   * @param {(this: this, state: string | number) => unknown} callback
   * @return {GraphNode}
   */
  onReference(callback) {
    this.updateReference = callback.bind(this)
    return this
  }
}

const node = new GraphNode().onUpdate(function (frame) {
  this.count += frame
  return this.count
}, 'frame')
node.update(2)
node.update(3)
const other = new GraphNode()
other.count = 7
other.onReference(function (state) {
  this.count += String(state).length
  return 'reference:' + state
})
const returned = other.updateReference('builder')
console.log(node.count, node.updateType, returned, other.count)
