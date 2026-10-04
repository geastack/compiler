// `this.constructor.type` (three's `Node#type`): the static getter as the
// class that ALLOCATED the instance resolves it -- redeclared by one subclass,
// inherited by another -- not the declared class's.
class BaseNode {
  static get type() {
    return 'BaseNode'
  }

  get type() {
    // @ts-ignore -- `constructor` is `Function` to the checker, as in three's untyped source
    return this.constructor.type
  }
}

class TextureNode extends BaseNode {
  static get type() {
    return 'TextureNode'
  }
}

class PlainNode extends BaseNode {}

const nodes = [new BaseNode(), new TextureNode(), new PlainNode()]
console.log(nodes.map((node) => node.type).join(' '))

//! expect: BaseNode TextureNode BaseNode
