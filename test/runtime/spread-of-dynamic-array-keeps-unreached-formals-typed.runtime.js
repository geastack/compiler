// A spread of unknown elements widens only the formals it can reach without
// the census already judging the call. three's `getValueFromType( type,
// ...params )` runs `new Vector3( ...params )`: a call that names its class,
// whose spread-covered positions `collectPassedArguments` judges like the
// explicit `params[ 0 ]` spelling -- `x` stays a number and each element
// converts, checked, at the boundary. Widening it made `x` dynamic, and every
// `this.x -= v.x`, `this.x *= v.x` and Box3's `this.max.x < this.min.x`
// became a dynamic operator with no C++ spelling. ShaderNodeProxy's `scope
// === null` branch constructs every class any proxy was made for, OperatorNode
// included; its `op` has no default, so it keeps its `string` binding, and
// `_vectorOperators[ this.op ]` stays a string-keyed read of a by-value record.
// PropertyNode's defaulted `varying`, reached through the same class-valued
// callee, still holds the ConstNode the spread delivers.
//! expect: vec 7 14 4 8
//! expect: box true false
//! expect: op lessThan
//! expect: prop true true
//! emitted-has: double x;
//! emitted-has: std::string op;
//! emitted-has: gea::Value varying;
export {}

class Vec3 {
  /**
   * @param {number} [x=0]
   * @param {number} [y=0]
   */
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
  /** @param {Vec3} v */
  sub(v) {
    this.x -= v.x
    this.y -= v.y
    return this
  }
  /** @param {Vec3} v */
  multiply(v) {
    this.x *= v.x
    this.y *= v.y
    return this
  }
}

class Box {
  constructor(min = new Vec3(Infinity, Infinity), max = new Vec3(-Infinity, -Infinity)) {
    this.min = min
    this.max = max
  }
  isEmpty() {
    return this.max.x < this.min.x || this.max.y < this.min.y
  }
}

class Node {
  constructor() {
    this.isNode = true
  }
}

class ConstNode extends Node {
  /** @param {*} value */
  constructor(value) {
    super()
    this.value = value
  }
}

const _ops = { '<': 'lessThan', '%': 'mod' }

class OperatorNode extends Node {
  /**
   * @param {string} op
   * @param {Node} aNode
   * @param {Node} bNode
   */
  constructor(op, aNode, bNode) {
    super()
    this.op = op
    this.aNode = aNode
    this.bNode = bNode
  }
  method() {
    return _ops[this.op] || this.op
  }
}

class PropertyNode extends Node {
  /**
   * @param {string} name
   * @param {boolean} [varying=false]
   */
  constructor(name, varying = false) {
    super()
    this.name = name
    this.varying = varying
  }
}

const nodeObject = (obj) => {
  if (obj && obj.isNode === true) return obj
  if (typeof obj === 'boolean' || typeof obj === 'number') return new ConstNode(obj)
  return obj
}

const nodeArray = (array) => {
  for (let i = 0; i < array.length; i++) array[i] = nodeObject(array[i])
  return array
}

/** @param {...any} params */
function valueFromType(type, ...params) {
  if (type === 'vec3') return new Vec3(...params)
  return params[0]
}

/**
 * @param {*} NodeClass
 * @param {?string} [scope=null]
 */
const ShaderNodeProxy = function (NodeClass, scope = null) {
  if (scope === null) return (...params) => new NodeClass(...nodeArray(params))
  return (...params) => new NodeClass(scope, ...nodeArray(params))
}
// @ts-ignore
const nodeProxy = (NodeClass, /** @type {?string} */ scope = null) => new ShaderNodeProxy(NodeClass, scope)
// @ts-ignore
const nodeImmutable = (NodeClass, ...params) => new NodeClass(...nodeArray(params))

const convert =
  (type) =>
  (...params) =>
    valueFromType(type, ...params)
const vec3 = convert('vec3')

const sub = nodeProxy(OperatorNode, '<')
const prop = nodeProxy(PropertyNode)

const invoke = (target, method, ...args) => target[method](...args)

const a = new Vec3(5, 7)
a.sub(new Vec3(1, 2)).multiply(new Vec3(2, 3))
invoke(a, 'sub', new Vec3(1, 1))
const made = vec3(4, 4)
const parsed = valueFromType('vec3', ...JSON.parse('[9, 8]'))
console.log('vec', a.x, a.y, made.x, parsed.y)
const box = new Box()
console.log('box', box.isEmpty(), new Box(new Vec3(0, 0), new Vec3(1, 1)).isEmpty())
const op = sub(new ConstNode(1), new ConstNode(2))
console.log('op', op.method())
const p = prop('P', true)
const q = nodeImmutable(PropertyNode, 'Q', false)
console.log('prop', p.varying.value, q.varying.isNode)
