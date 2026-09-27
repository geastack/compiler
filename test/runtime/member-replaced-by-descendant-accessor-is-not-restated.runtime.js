// @ts-nocheck
//! expect: map t1 true
//! expect: 7
//! expect: t3
//! expect: set 2
// three's `InputNode` holds `@type {any} this.value`, and `TextureNode`, two
// classes below it, replaces `value` with `get value()` / `set value()`
// reading through `this.referenceNode`. On a TextureNode, InputNode's own
// `this.value = value` runs the setter and a read runs the getter, so what
// InputNode's writes store is not what a read through InputNode holds. The
// subclass overlay must not restate the member on InputNode; the base union
// (which carries the getter's Texture) stays what those reads see.
class Texture {
  constructor(uuid) {
    /** @type {string} */
    this.uuid = uuid
  }
}
class GNode {}
class RefNode extends GNode {
  constructor(v) {
    super()
    /** @type {any} */
    this.value = v
  }
}
class InputNode extends GNode {
  /** @param {any} value */
  constructor(value) {
    super()
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
    /** @type {?GNode} */
    this.referenceNode = null
    /** @type {Texture} */
    this._texture = texture
    /** @type {number} */
    this.sets = 0
  }
  set value(texture) {
    if (this.referenceNode) this.referenceNode.value = texture
    else this._texture = texture
  }
  /** @type {Texture} */
  get value() {
    return this.referenceNode ? this.referenceNode.value : this._texture
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
console.log(sampler.name + ' ' + sampler.texture.uuid + ' ' + (sampler.textureNode === textured.node))
console.log(plain.node.value)
const t2 = new TextureNode(new Texture('t2'))
t2.referenceNode = new RefNode(new Texture('t3'))
console.log(new NodeSampler('b', t2).texture.uuid)
t2.value = new Texture('set 2')
console.log(t2.referenceNode.value.uuid)
