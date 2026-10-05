// three's TSLCore: `nodeImmutable( PropertyNode, 'float', 'AmbientOcclusion',
// false, 1 )` builds `new NodeClass( ...nodeArray( params ) )`, and
// `nodeArray` has already turned the primitive `false` into a ConstNode. So
// PropertyNode's `varying` formal -- JSDoc `boolean`, and only ever handed
// `true`/`false` at the direct `new PropertyNode( ... )` sites -- receives a
// node object through the spread, and the field it is stored into (JSDoc
// `boolean` too) and every read of that field must hold it. `nodeArray` is
// also handed a parsed JSON array, which makes the spread source a boxed
// value rather than a typed array.
//! expect: direct true false
//! expect: immutable object true false 1
//! expect: other 2 const 3

export {}

class Node {
  /** @param {?string} [nodeType=null] */
  constructor(nodeType = null) {
    this.nodeType = nodeType
    this.isNode = true
  }
}

class ConstNode extends Node {
  /** @param {*} value */
  constructor(value) {
    super('const')
    this.value = value
  }
}

class PropertyNode extends Node {
  /**
   * @param {string} nodeType
   * @param {?string} [name=null]
   * @param {boolean} [varying=false]
   * @param {?Node} [placeholderNode=null]
   */
  constructor(nodeType, name = null, varying = false, placeholderNode = null) {
    super(nodeType)
    /** @type {?string} */
    this.name = name
    /** @type {boolean} */
    this.varying = varying
    /** @type {?Node} */
    this.placeholderNode = nodeObject(placeholderNode)
  }
}

class OtherNode extends Node {
  /** @param {Node} input */
  constructor(input) {
    super('other')
    this.input = input
  }
}

class FunctionCallNode extends Node {
  /**
   * @param {*} functionNode
   * @param {*} [parameters={}]
   */
  constructor(functionNode, parameters = {}) {
    super()
    this.functionNode = functionNode
    this.parameters = parameters
  }
}

const nodeObject = (obj) => {
  if (obj && obj.isNode === true) return obj
  if (typeof obj === 'boolean' || typeof obj === 'number') return new ConstNode(obj)
  return obj
}

const nodeObjects = (objects) => {
  for (const name in objects) objects[name] = nodeObject(objects[name])
  return objects
}

const nodeArray = (array) => {
  const len = array.length
  for (let i = 0; i < len; i++) array[i] = nodeObject(array[i])
  return array
}

const ShaderNodeImmutable = function (NodeClass, ...params) {
  return new NodeClass(...nodeArray(params))
}

// @ts-ignore -- a plain function used as a constructor, as in three's untyped source
const nodeImmutable = (NodeClass, ...params) => new ShaderNodeImmutable(NodeClass, ...params)

const call = (func, ...params) => {
  const args = params.length > 1 || (params[0] && params[0].isNode === true) ? nodeArray(params) : nodeObjects(params[0])
  return new FunctionCallNode(nodeObject(func), args)
}

const direct = new PropertyNode('vec3', 'Direct', true)
const plain = new PropertyNode('float', 'Plain', false)
console.log('direct', direct.varying, plain.varying)

const ao = nodeImmutable(PropertyNode, 'float', 'AmbientOcclusion', false, 1)
const varying = ao.varying
// @ts-ignore -- `placeholderNode` is a ConstNode here
console.log('immutable', typeof varying, varying.isNode, varying.value, ao.placeholderNode.value)

const other = nodeImmutable(OtherNode, 2)
const called = call('fn', 1, true)
const parsed = nodeArray(JSON.parse('[3]'))
// @ts-ignore -- the record JSDoc is an array here
console.log('other', other.input.value, called.parameters[1].nodeType, parsed[0].value)
