// @ts-nocheck
//! expect: map t1 sampler:true
//! expect: 7
// three's `NodeSampler( name, textureNode )` under `@param {TextureNode}
// textureNode`, constructed by `WGSLNodeBuilder` with `uniformNode.node`, a
// field stated `UniformNode` -- the base class of `TextureNode` -- and only for
// texture uniforms. The argument is wider than the tag, not outside it, so the
// tag stands: `textureNode.value` is `TextureNode`'s getter, the texture, and
// not the `value` a plain `UniformNode` holds.
class Texture {
  constructor(uuid) {
    /** @type {string} */
    this.uuid = uuid
  }
}
class InputNode {
  /** @param {any} value */
  constructor(value) {
    /** @type {any} */
    this.value = value
  }
}
class UniformNode extends InputNode {
  /** @param {any} value */
  constructor(value) {
    super(value)
    /** @type {boolean} */
    this.isUniformNode = true
  }
}
class TextureNode extends UniformNode {
  /** @param {Texture} texture */
  constructor(texture) {
    super(null)
    /** @type {Texture} */
    this._texture = texture
  }
  set value(texture) {
    this._texture = texture
  }
  /** @type {Texture} */
  get value() {
    return this._texture
  }
}
class Sampler {
  /**
   * @param {string} name
   * @param {?Texture} texture
   */
  constructor(name, texture) {
    /** @type {string} */
    this.name = name
    /** @type {?Texture} */
    this.texture = texture
  }
}
class NodeSampler extends Sampler {
  /**
   * @param {string} name
   * @param {TextureNode} textureNode
   */
  constructor(name, textureNode) {
    super(name, textureNode ? textureNode.value : null)
    /** @type {TextureNode} */
    this.textureNode = textureNode
  }
}
class NodeUniform {
  /** @param {UniformNode} node */
  constructor(node) {
    /** @type {UniformNode} */
    this.node = node
  }
}
const textured = new NodeUniform(new TextureNode(new Texture('t1')))
const plain = new NodeUniform(new UniformNode(7))
const sampler = new NodeSampler('map', textured.node)
console.log(sampler.name + ' ' + sampler.texture.uuid + ' sampler:' + (sampler.textureNode === textured.node))
console.log(plain.node.value)
