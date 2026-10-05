// @ts-nocheck
//! expect: set a,b,c
//! expect: uniforms [{"kind":"node","value":1,"name":""},{"kind":"node","value":{"x":6},"name":""},{"kind":"node","value":null,"name":""}]
//! expect: others q node
// three's uniform writes go through receivers typed `UniformNode` and carry
// numbers, vectors, functions and nulls (`this.cutoffDistanceNode.value =
// light.distance`); a Texture reaches `value` only through `TextureNode`'s own
// constructor and receivers. The family dispatching `value` down to
// TextureNode's accessor took its slot from the field's evidence -- the values
// the flow saw stored, which hold no Texture -- while the field is stored
// boxed (a function was stored), so the setter's parameter had no conversion
// from the slot, the family was refused, and every write through an InputNode
// or a UniformNode refused with it, even one that only ever reaches a plain
// UniformNode. The slot is now the field as stored, which is what such a write
// already converts into. A read through those receivers is not exercised: the
// boxed field does not narrow to the evidence a read publishes, with or
// without the accessor, so the writes are observed through the instances.
const log = []
class Texture {
  /** @param {string} name */
  constructor(name) {
    /** @type {string} */
    this.name = name
  }
}
class Vector3 {
  constructor() {
    /** @type {number} */
    this.x = 6
  }
}
class GraphNode {
  constructor() {
    /** @type {string} */
    this.kind = 'node'
  }
}
class InputNode extends GraphNode {
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
    /** @type {string} */
    this.name = ''
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
  /** @param {Object} value */
  constructor(value) {
    super()
    /** @type {Object} */
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
/** @param {UniformNode} node */
const bump = (node) => {
  node.value = 1
}
/** @param {UniformNode} node */
const vec = (node) => {
  node.value = new Vector3()
}
/** @param {UniformNode} node */
const fn = (node) => {
  node.value = () => 2
}
/** @param {InputNode} node @param {any} v */
const raw = (node, v) => {
  node.value = v
}
const tex = new TextureNode(new Texture('a'))
const counter = new UniformNode(true)
bump(counter)
const position = new UniformNode(0)
vec(position)
const callback = new UniformNode(() => 1)
fn(callback)
const buffer = new UniformNode(new Float32Array(3))
raw(buffer, 's')
raw(buffer, null)
tex.value = new Texture('b')
tex.value = new Texture('c')
console.log('set ' + log.join(','))
console.log('uniforms ' + JSON.stringify([counter, position, buffer]))
const pmrem = new PMREMNode(new Texture('p'))
pmrem.value = new Texture('q')
const context = new ContextNode({ a: 1 })
console.log('others ' + pmrem.value.name + ' ' + context.kind)
