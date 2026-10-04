// @ts-nocheck
//! expect: other 9
//! expect: stored 1 x
//! expect: count 0 2
//! expect: count 0 3

// three's TSL `Fn( ( [ matrices, colors = null ], builder ) => ... )`
// (nodes/accessors/Instance.js): the checker types `colors` from its default
// alone, so `if ( colors )` narrows every read inside to `never`. The body is
// entered only through `jsFunc( inputs, builder )`, a dynamic callee handed a
// Proxy over the call's arguments (TSLCore.js `getProxyParameters`); the
// proxy reaches the destructured slot, which is then dynamic, and the narrowed
// reads take that carrier instead of converting the default's `null` into
// `never`'s stand-in.
class TNode {
  constructor(nodeType = 'node') {
    this.nodeType = nodeType
    this.count = 0
  }
}
class ShaderNodeInternal {
  constructor(jsFunc) {
    this.jsFunc = jsFunc
  }
  call(rawInputs, builder) {
    const inputs = rawInputs.length > 0 ? getProxyParameters(rawInputs) : null
    const jsFunc = this.jsFunc
    return inputs !== null || jsFunc.length > 1 ? jsFunc(inputs, builder) : jsFunc(builder)
  }
}
function getProxyParameters(params) {
  return new Proxy(params, {
    get: (target, property, receiver) => {
      if (property === 'length') return params.length
      if (Symbol.iterator === property) {
        return function* () {
          for (const inputNode of params) yield inputNode
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })
}
function Fn(jsFunc) {
  const shaderNode = new ShaderNodeInternal(jsFunc)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return { build: (builder) => shaderNode.call(params, builder) }
    }
  })
}
const _colorBuffers = new WeakMap()
const instance = Fn(([matrices, colors = null], builder) => {
  if (colors) {
    let bufferAttribute = _colorBuffers.get(colors)
    if (!bufferAttribute) {
      bufferAttribute = new TNode('x')
      _colorBuffers.set(colors, bufferAttribute)
      console.log('stored', builder.limit === 2 ? 1 : 0, bufferAttribute.nodeType)
    }
  }
  console.log('count', matrices.count, builder.limit)
})
const other = Fn((builder) => {
  console.log('other', builder.limit)
  return 1
})
other().build({ limit: 9 })
instance(new TNode(), new TNode()).build({ limit: 2 })
instance(new TNode()).build({ limit: 3 })
