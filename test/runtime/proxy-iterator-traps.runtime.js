// @ts-nocheck
//! expect: builder ctx dflt undefined
//! expect: body 3+4 5/6/2
//! expect: pattern 7+8 9/10

// TSL's other two proxy shapes (three/src/nodes/tsl/TSLCore.js), reduced.
// `secureNodeBuilder`'s `get` trap answers `@@iterator` with a generator that
// yields `undefined`, so a Fn body destructuring the builder sees defaults.
// `getProxyParameters`' trap answers `length`, `@@iterator` (a generator over
// the call's arguments) and any other key through a closure counter, so
// `{ x, y }` takes the arguments in order. Both proxies travel into the Fn
// body through a call whose callee is `dynamic` (`jsFunc`, whichever arrow was
// handed to `Fn`), and the arrow destructures them in its body or in its
// parameter list. Each trap's `let value` holds a generator function for one
// key and whatever the target answers for the rest.
class TNode {
  constructor(v) {
    this.v = v
    this.isNode = true
  }
}
class Builder {
  constructor() {
    this.context = 'ctx'
  }
}
const nodeObject = (x) => x
function secureNodeBuilder(builder) {
  return new Proxy(builder, {
    get: (target, property, receiver) => {
      let value
      if (Symbol.iterator === property) {
        value = function* () {
          yield undefined
        }
      } else {
        value = target[property]
      }
      return value
    }
  })
}
function getProxyParameters(params) {
  let index = 0
  return new Proxy(params, {
    get: (target, property, receiver) => {
      let value
      if (property === 'length') {
        value = params.length
        return value
      }
      if (Symbol.iterator === property) {
        value = function* () {
          for (const inputNode of params) yield nodeObject(inputNode)
        }
      } else {
        if (params.length > 0) {
          if (params[0] instanceof TNode) {
            if (params[property] === undefined) value = params[index++]
            else value = params[property]
          }
        } else {
          value = target[property]
        }
        value = nodeObject(value)
      }
      return value
    }
  })
}
class ShaderCallNodeInternal {
  constructor(jsFunc, rawInputs) {
    this.jsFunc = jsFunc
    this.rawInputs = rawInputs
  }
  build(builder) {
    const jsFunc = this.jsFunc
    if (this.rawInputs.length === 0) return jsFunc(secureNodeBuilder(builder))
    return jsFunc(getProxyParameters(this.rawInputs), secureNodeBuilder(builder))
  }
}
class FnNode {
  /** @param {Function} jsFunc */
  constructor(jsFunc) {
    this.jsFunc = jsFunc
  }
  call(...params) {
    return new ShaderCallNodeInternal(this.jsFunc, params).build(new Builder())
  }
}
/** @param {Function} jsFunc */
function Fn(jsFunc) {
  const instance = new FnNode(jsFunc)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return instance.call(...params)
    }
  })
}
const noInputs = Fn(([first = 'dflt', second]) => `${first} ${second}`)
const sum = Fn((inputs) => {
  const [a, b] = inputs
  return `${a.v}+${b.v}`
})
const named = Fn((inputs, builder) => {
  const { x, y } = inputs
  return `${x.v}/${y.v}/${inputs.length}`
})
const context = Fn((inputs, builder) => builder.context)
console.log('builder', context(new TNode(0)), noInputs())
console.log('body', sum(new TNode(3), new TNode(4)), named(new TNode(5), new TNode(6)))
const patternSum = Fn(([a, b]) => `${a.v}+${b.v}`)
const patternNamed = Fn(({ x, y }) => `${x.v}/${y.v}`)
console.log('pattern', patternSum(new TNode(7), new TNode(8)), patternNamed(new TNode(9), new TNode(10)))
