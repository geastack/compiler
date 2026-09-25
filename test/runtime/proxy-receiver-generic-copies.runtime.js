// @ts-nocheck
//! expect: fn function 1+2 true add
//! expect: builder true sub_x sub-n_y ctx:3 flat
//! expect: plain ctx:4 flat sub_z sub-m_w
//! emitted-has: _dynamic_this(gea::Value gea_this

// A proxy as `this` (three/src/nodes/tsl/TSLCore.js). `Fn(...).setLayout(...)
// .once()` runs FnNode's methods through the `get` trap with the callable
// proxy as `this`; both end in `return this`, so the chain must end at the
// proxy for the call after it to run the `apply` trap. A Fn body calls
// NodeBuilder methods on the builder proxy (`isFlatShading`,
// `getSubBuildProperty`, which calls `this.getClosestSubBuild`) and hands it
// to plain functions whose JSDoc types the parameter `{NodeBuilder}`
// (`createInstanceMatrixNode`, `getViewZNode`). Each method read through a
// proxy gets a copy with a `dynamic` receiver; the typed body still serves a
// native receiver. The traps here read the object behind the proxy through a
// dynamic cell, which is what `Reflect.get( target, property, receiver )`
// does for them in three.
class ShaderNodeInternal {
  constructor(jsFunc) {
    this.jsFunc = jsFunc
    this.layout = null
    this.once = false
  }
  setLayout(layout) {
    this.layout = layout
    return this
  }
}
class FnNode {
  constructor(jsFunc) {
    this.shaderNode = new ShaderNodeInternal(jsFunc)
  }
  call(...params) {
    return this.shaderNode.jsFunc(params[0], params[1])
  }
  setLayout(layout) {
    this.shaderNode.setLayout(layout)
    return this
  }
  once() {
    this.shaderNode.once = true
    return this.self()
  }
  self() {
    return this
  }
}
function Fn(jsFunc) {
  const instance = new FnNode(jsFunc)
  const held = JSON.parse('{}')
  held.instance = instance
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return instance.call(...params)
    },
    get(target, prop) {
      return held.instance[prop]
    }
  })
}
const add = Fn((a, b) => `${a}+${b}`)
  .setLayout({ name: 'add' })
  .once()
console.log('fn', typeof add, add(1, 2), add.shaderNode.once, add.shaderNode.layout.name)
class NodeBuilder {
  constructor() {
    this.material = { flatShading: true }
    this.subBuildFn = 'sub'
    this.context = { label: 'ctx' }
  }
  isFlatShading() {
    return this.material.flatShading === true
  }
  /**
   * @param {?string} node
   * @return {?string}
   */
  getClosestSubBuild(node) {
    return node === null ? null : `${this.subBuildFn}-${node}`
  }
  /**
   * @param {string} [property]
   * @param {?string} [node]
   * @return {string}
   */
  getSubBuildProperty(property = '', node = null) {
    let subBuild
    if (node !== null) subBuild = this.getClosestSubBuild(node)
    else subBuild = this.subBuildFn
    return subBuild ? subBuild + '_' + property : property
  }
}
/**
 * @param {NodeBuilder} builder
 * @param {number} count
 * @return {string}
 */
function createInstanceMatrixNode(builder, count) {
  return `${builder.context.label}:${count}`
}
/**
 * @param {NodeBuilder} builder
 * @return {string}
 */
function getViewZNode(builder) {
  return builder.isFlatShading() ? 'flat' : 'smooth'
}
function secure(builder) {
  const held = JSON.parse('{}')
  held.target = builder
  return new Proxy(builder, {
    get: (target, property, receiver) => {
      let value
      if (Symbol.iterator === property) {
        value = function* () {
          yield undefined
        }
      } else {
        value = held.target[property]
      }
      return value
    }
  })
}
const jsFuncs = JSON.parse('{}')
jsFuncs.body = (inputs, builder) =>
  [
    builder.isFlatShading(),
    builder.getSubBuildProperty('x'),
    builder.getSubBuildProperty('y', 'n'),
    createInstanceMatrixNode(builder, 3),
    getViewZNode(builder)
  ].join(' ')
console.log('builder', jsFuncs.body(null, secure(new NodeBuilder())))
const plain = new NodeBuilder()
console.log(
  'plain',
  createInstanceMatrixNode(plain, 4),
  getViewZNode(plain),
  plain.getSubBuildProperty('z'),
  plain.getSubBuildProperty('w', 'm')
)
