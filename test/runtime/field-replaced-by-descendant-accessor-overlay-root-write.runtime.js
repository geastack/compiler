// @ts-nocheck
//! expect: set tex1,tex2,tex3
//! expect: through base 4|tex3|p2|5
//! expect: pmrem p1,p2
// The sibling of `field-replaced-by-descendant-accessor-write-dispatches`
// where the overlay is real storage: `describe` reads `value` through a
// receiver typed `GraphNode`, so GraphNode keeps the overlay slot InputNode's
// and ContextNode's stores land in, and the family stays rooted at it, since
// rooting at the class that holds the slot is what a family over an omitted
// overlay moved to. That one family answers for TextureNode's accessor below
// InputNode and for PMREMNode's on another branch, and writes through a
// UniformNode still reach TextureNode's setter.
const log = []
const pmremLog = []
class Texture {
  /** @param {string} name */
  constructor(name) {
    /** @type {string} */
    this.name = name
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
class UniformNode extends InputNode {}
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
    pmremLog.push(texture.name)
  }
  /** @param {Texture} value */
  set value(value) {
    pmremLog.push(value.name)
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
/** @param {GraphNode} node */
const describe = (node) => {
  const value = node.value
  return value instanceof Texture ? value.name : String(value)
}
const tex = new TextureNode(new Texture('tex1'))
const num = new UniformNode(1)
assignUniform(num, 4)
assignUniform(tex, new Texture('tex2'))
tex.value = new Texture('tex3')
const pmrem = new PMREMNode(new Texture('p1'))
pmrem.value = new Texture('p2')
console.log('set ' + log.join(','))
/** @type {GraphNode[]} */
const all = [num, tex, pmrem, new ContextNode(5)]
console.log('through base ' + all.map(describe).join('|'))
console.log('pmrem ' + pmremLog.join(','))
