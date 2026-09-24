// @ts-nocheck
// The shapes three.js's node system spreads a rest list into NAMED formals
// with: `getValueFromType( type, ...params )` building `new Color( ...params )`
// (`NodeUtils.js`), and `StackNode.build( builder, ...params )` forwarding to
// `super.build( builder, ...params )` against `Node.build( builder, output =
// null )` (`StackNode.js`, `IsolateNode.js`, `SubBuildNode.js`). Each was
// refused as "a spread argument whose source has a native iteration cursor
// can only be range-copied into a rest parameter".
class Color {
  /**
   * @param {number} [r]
   * @param {number} [g]
   * @param {number} [b]
   */
  constructor(r = 1, g = 1, b = 1) {
    this.r = r
    this.g = g
    this.b = b
  }
  /** @returns {string} */
  label() {
    return this.r + ',' + this.g + ',' + this.b
  }
}

/**
 * @param {string} type
 * @param {...number} params
 * @returns {Color | null}
 */
function getValueFromType(type, ...params) {
  if (type === 'color') return new Color(...params)
  return null
}

class Builder {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}

class ShaderNode {
  /**
   * @param {Builder} builder
   * @param {?string} [output=null]
   * @returns {string}
   */
  build(builder, output = null) {
    return builder.name + ':' + output
  }
}

class StackNode extends ShaderNode {
  /**
   * @param {Builder} builder
   * @param {...(string|null)} params
   * @returns {string}
   */
  build(builder, ...params) {
    return 'stack(' + super.build(builder, ...params) + ')'
  }
}

// `node` is typed as the subclass: a call through a `ShaderNode` handle needs
// dynamic dispatch between `build( builder, output )` and the subclasses'
// `build( builder, ...params )`, two conventions for one member, which is a
// separate gap from the spread.
class IsolateNode extends ShaderNode {
  /** @param {StackNode} node */
  constructor(node) {
    super()
    this.node = node
  }
  /**
   * @param {Builder} builder
   * @param {...(string|null)} params
   * @returns {string}
   */
  build(builder, ...params) {
    return 'isolate(' + this.node.build(builder, ...params) + ')'
  }
}

// `Object3D.clear()`: `this.remove( ...this.children )` into `remove( object )`,
// whose body reads `arguments`. The values past `object` reach the body through
// `arguments`, so they must be packed into its frame rather than dropped.
class Group {
  constructor() {
    /** @type {number[]} */
    this.children = []
    this.removed = ''
  }
  /**
   * @param {number} id
   * @returns {Group}
   */
  add(id) {
    this.children.push(id)
    return this
  }
  /**
   * @param {number} object
   * @returns {Group}
   */
  remove(object) {
    if (arguments.length > 1) {
      for (let i = 0; i < arguments.length; i++) this.remove(arguments[i])
      return this
    }
    const index = this.children.indexOf(object)
    if (index !== -1) {
      this.children.splice(index, 1)
      this.removed += object
    }
    return this
  }
  /** @returns {Group} */
  clear() {
    return this.remove(...this.children)
  }
}

const builder = new Builder('b')
const stack = new StackNode()
const isolate = new IsolateNode(stack)

console.log(new Color(...[1, 0, 0]).label())
console.log(getValueFromType('color', 0.5, 0.25).label(), getValueFromType('color').label(), getValueFromType('color', 1, 2, 3, 4).label())
console.log(stack.build(builder), stack.build(builder, 'vec3'), stack.build(builder, 'vec3', 'extra'))
console.log(isolate.build(builder, 'float'), isolate.build(builder))
const group = new Group().add(1).add(2).add(3)
group.clear()
const single = new Group().add(4)
single.clear()
console.log(group.children.length, group.removed, single.children.length, single.removed)
//! expect: 1,0,0
//! expect: 0.5,0.25,1 1,1,1 1,2,3
//! expect: stack(b:null) stack(b:vec3) stack(b:vec3)
//! expect: isolate(stack(b:float)) isolate(stack(b:null))
//! expect: 0 123 0 4
