// @ts-nocheck
// Helper for node-library-native-registries.runtime.js: three's tone-mapping
// functions (nodes/display/ToneMappingFunctions.js) as TSL makes them. `Fn`
// returns a Proxy over an arrow whose traps forward to an FnNode, and
// `setLayout` is read through the `get` trap and returns the FnNode
// (nodes/tsl/TSLCore.js). Each export carries the `@type` the native-webgpu
// plugin states for it.
import { Node } from './_node-library-nodes.js'

class ShaderNode extends Node {
  constructor(jsFunc, nodeType) {
    super()
    this.jsFunc = jsFunc
    this.nodeType = nodeType
    this.layout = null
  }
  setLayout(layout) {
    this.layout = layout
    return this
  }
  call(params) {
    return this.jsFunc(params)
  }
}

let fnId = 0

class FnNode extends Node {
  constructor(jsFunc, layout = null) {
    super()
    let nodeType = null
    if (layout !== null && typeof layout === 'string') nodeType = layout
    this.shaderNode = new ShaderNode(jsFunc, nodeType)
    this.isFn = true
  }
  setLayout(layout) {
    const nodeType = this.shaderNode.nodeType
    if (typeof layout.inputs !== 'object') {
      layout = { name: 'fn' + fnId++, type: nodeType, inputs: [] }
    }
    this.shaderNode.setLayout(layout)
    return this
  }
  call(...params) {
    return this.shaderNode.call(params)
  }
}

function Fn(jsFunc, layout = null) {
  const instance = new FnNode(jsFunc, layout)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return instance.call(...params)
    },
    get(target, prop, receiver) {
      return Reflect.get(instance, prop, receiver)
    },
    set(target, prop, value, receiver) {
      return Reflect.set(instance, prop, value, receiver)
    }
  })
}

const layout = (name) => ({
  name,
  type: 'vec3',
  inputs: [
    { name: 'color', type: 'vec3' },
    { name: 'exposure', type: 'float' }
  ]
})

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const linearToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).clamp()
  }).setLayout(layout('linearToneMapping'))

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const reinhardToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).add(10)
  }).setLayout(layout('reinhardToneMapping'))

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const cineonToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).add(20)
  }).setLayout(layout('cineonToneMapping'))

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const acesFilmicToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).add(30)
  }).setLayout(layout('acesFilmicToneMapping'))

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const agxToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).add(40)
  }).setLayout(layout('agxToneMapping'))

/** @type {(color: import('./_node-library-nodes.js').Node, exposure: import('./_node-library-nodes.js').Node) => import('./_node-library-nodes.js').Node} */ export const neutralToneMapping =
  /*@__PURE__*/ Fn(([color, exposure]) => {
    return color.mul(exposure).add(50)
  }).setLayout(layout('neutralToneMapping'))
