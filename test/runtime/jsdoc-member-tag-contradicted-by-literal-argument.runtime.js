// @ts-nocheck
//! expect: color depth 4
// A member tag of an options parameter that a literal argument contradicts:
// three's `ReflectorNode( parameters = {} )` states
// `[parameters.defaultTexture]` a `TextureNode`, and `getDepthNode()` passes
// `{ defaultTexture: _defaultRT.depthTexture }`, a `DepthTexture` the
// constructor hands on as its texture.
class Texture { constructor(name) { this.name = name } }
class DepthTexture extends Texture {}
class RenderTarget {
  constructor() {
    this.texture = new Texture('color')
    this._depthTexture = null
  }
  set depthTexture(current) { this._depthTexture = current }
  /** @type {?DepthTexture} */
  get depthTexture() { return this._depthTexture }
}
class TextureNode { constructor(value) { this.value = value } }
const _rt = new RenderTarget()
_rt.depthTexture = new DepthTexture('depth')
class ReflectorNode extends TextureNode {
  /**
   * @param {Object} [parameters={}] - Configuration.
   * @param {number} [parameters.samples] - Samples.
   * @param {TextureNode} [parameters.defaultTexture] - The default texture node.
   * @param {Object} [parameters.reflector] - The base.
   */
  constructor(parameters = {}) {
    super(parameters.defaultTexture || _rt.texture)
    this.samples = parameters.samples || 0
    this._depth = null
  }
  depthNode() {
    if (this._depth === null) this._depth = new ReflectorNode({ defaultTexture: _rt.depthTexture, reflector: this })
    return this._depth
  }
}
const r = new ReflectorNode({ samples: 4 })
console.log(r.value.name + ' ' + r.depthNode().value.name + ' ' + r.samples)
