// @ts-nocheck
//! expect: set tex1,tex2,tex3,tex4,tex5
//! expect: read 7|8|tex5|9
//! expect: pmrem p2 ctx 1
//! expect: type Material Node Object3D GraphNode
// three's `InputNode` stores `this.value = value`, `UniformNode` extends it,
// and `TextureNode` replaces `value` with `get value()` / `set value()`. A
// write through a receiver typed as the base or as the intermediate class runs
// the setter on a TextureNode, including writes with no read of the field
// through that receiver. `ContextNode` declares its own `value` and
// `PMREMNode`, on another branch, its own accessor, so `GraphNode` carries an
// overlay `value` that nothing accesses through it and native storage
// therefore omits: the slot is InputNode's, and the family is rooted there.
// Rooted at the overlay, the root's member stored into a struct member that
// was never declared. `Material.type` is a string field that `NodeMaterial`
// replaces with an accessor whose setter ignores its value, under an
// `EventDispatcher` that `Object3D` and Material give a `type` overlay;
// `GraphNode`, on another branch, declares a getter-only `type`. Rooted at the
// overlay, that getter joined the family, which then had no setter for
// GraphNode, and every write through a Material was refused.
const log = []
class Texture {
  /** @param {string} name */
  constructor(name) {
    /** @type {string} */
    this.name = name
  }
}
class EventDispatcher {}
class GraphNode extends EventDispatcher {
  constructor() {
    super()
    /** @type {string} */
    this.kind = 'node'
  }
  get type() {
    return 'GraphNode'
  }
}
class InputNode extends GraphNode {
  /** @param {any} value */
  constructor(value) {
    super()
    /** @type {any} */
    this.value = value
  }
  /** @param {any} data */
  deserialize(data) {
    this.value = data.value
  }
}
class UniformNode extends InputNode {
  /** @param {any} value */
  constructor(value) {
    super(value)
    /** @type {string} */
    this.name = ''
  }
  /** @param {any} value */
  update(value) {
    this.value = value
    return this
  }
}
class TextureNode extends UniformNode {
  /** @param {Texture} texture */
  constructor(texture) {
    super(texture)
    /** @type {Texture} */
    this._value = texture
  }
  /** @param {Texture} value */
  set value(value) {
    log.push(value.name)
    this._value = value
  }
  /** @type {Texture} */
  get value() {
    return this._value
  }
}
class ContextNode extends GraphNode {
  /** @param {number} value */
  constructor(value) {
    super()
    /** @type {number} */
    this.value = value
  }
}
class TempNode extends GraphNode {}
class PMREMNode extends TempNode {
  /** @param {Texture} texture */
  constructor(texture) {
    super()
    /** @type {Texture} */
    this._value = texture
  }
  /** @param {Texture} value */
  set value(value) {
    this._value = value
  }
  /** @type {Texture} */
  get value() {
    return this._value
  }
}
/** @param {UniformNode} node @param {any} value */
const assignUniform = (node, value) => {
  node.value = value
}
/** @param {InputNode} node @param {any} value */
const assignInput = (node, value) => {
  node.value = value
}
const tex = new TextureNode(new Texture('tex1'))
const num = new UniformNode(1)
const input = new InputNode(2)
assignUniform(num, 7)
assignUniform(tex, new Texture('tex2'))
assignInput(input, 8)
assignInput(tex, new Texture('tex3'))
tex.update(new Texture('tex4'))
tex.deserialize({ value: new Texture('tex5') })
const other = new UniformNode(0)
other.update(9)
console.log('set ' + log.join(','))
/** @type {InputNode[]} */
const nodes = [num, input, tex, other]
console.log('read ' + nodes.map((node) => (node instanceof TextureNode ? node.value.name : String(node.value))).join('|'))
const pmrem = new PMREMNode(new Texture('p1'))
pmrem.value = new Texture('p2')
const context = new ContextNode(1)
console.log('pmrem ' + pmrem.value.name + ' ctx ' + String(context.value))

class Object3D extends EventDispatcher {
  constructor() {
    super()
    /** @type {string} */
    this.type = 'Object3D'
  }
}
class Material extends EventDispatcher {
  constructor() {
    super()
    /** @type {string} */
    this.type = 'Material'
  }
  /** @param {string} name */
  rename(name) {
    this.type = name
  }
}
class NodeMaterial extends Material {
  get type() {
    return 'Node'
  }
  set type(_value) {}
}
/** @param {Material} material @param {string} name */
const retype = (material, name) => {
  material.type = name
}
const plainMaterial = new Material()
const nodeMaterial = new NodeMaterial()
/** @type {Material[]} */
const materials = [plainMaterial, nodeMaterial]
for (const material of materials) material.rename(material.type)
retype(nodeMaterial, 'Other')
console.log('type ' + materials.map((material) => material.type).join(' ') + ' ' + new Object3D().type + ' ' + tex.type)
