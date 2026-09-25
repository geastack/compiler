// @ts-nocheck
// three's `UniformNode.onUpdate`: `callback = callback.bind( this )` rebinds
// the parameter itself, then calls it with no receiver. The bound value types
// (`OmitThisParameter` over the polymorphic `this`, see
// `bind-polymorphic-this-callback.runtime.js`), but the parameter's cell keeps
// the declared `(this: this, frame, self: this) => ...` convention, so the
// plain call through it omits the receiver that convention declares. In
// checked TypeScript that call is an error ("The 'this' context of type
// 'void' is not assignable"); only the bind makes it work at run time.
//! expect-refusal: omits the receiver its callee's convention declares
class GraphNode {
  constructor() {
    this.updateType = 'none'
    this.count = 0
  }

  /** @param {number} frame */
  update(frame) {
    return frame
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
}

class Uniform extends GraphNode {
  constructor() {
    super()
    this.value = 1
  }

  /**
   * @param {(this: this, frame: number, self: this) => number | undefined} callback
   * @param {string} updateType
   */
  onUpdate(callback, updateType) {
    callback = callback.bind(this)
    return super.onUpdate((frame) => {
      const value = callback(frame, this)
      if (value !== undefined) this.value = value
    }, updateType)
  }
}

const uniform = new Uniform()
uniform.count = 3
uniform.onUpdate(function (frame, self) {
  return self.value + frame + this.count
}, 'render')
uniform.update(4)
uniform.update(5)
console.log(uniform.value, uniform.updateType)
