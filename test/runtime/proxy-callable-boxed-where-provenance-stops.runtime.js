// @ts-nocheck
//! expect: call 5
//! expect: receiver is proxy true
//! expect: conditional 7
//! expect: listed 3 9
//! expect: passed 11
//! expect: typeof function
//! expect: same box true

// TSL's `Fn()` (three/src/nodes/tsl/TSLCore.js): a proxy over an arrow whose
// `apply` trap runs the node and whose `get` trap takes the proxy itself as
// its `receiver`. The proxy stays native where its provenance is followed;
// where it stops -- a conditional arm, an array element, an argument, a trap's
// `any` receiver -- it is boxed, and the box is the same proxy every time, so
// calling it runs `apply` and `===` still holds.
class FnNode {
  constructor(jsFunc) {
    this.jsFunc = jsFunc
    this.isFn = true
  }
  call(a, b) {
    return this.jsFunc(a, b)
  }
}

let seenReceiver = null

function Fn(jsFunc) {
  const instance = new FnNode(jsFunc)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return instance.call(params[0], params[1])
    },
    get(target, prop, receiver) {
      seenReceiver = receiver
      return Reflect.get(instance, prop, receiver)
    }
  })
}

const add = Fn((a, b) => b)
console.log('call', add(2, 5))
const flag = add.isFn
console.log('receiver is proxy ' + (seenReceiver === add && flag === true))

function shader(obj) {
  return obj.isFn ? obj : Fn(obj)
}
console.log('conditional', shader((a) => a)(7))

const listed = [Fn((a) => a), Fn((a, b) => b)]
console.log('listed', listed[0](3), listed[1](3, 9))

function invoke(fn, value) {
  return fn(value)
}
console.log(
  'passed',
  invoke(
    Fn((a) => a),
    11
  )
)

console.log('typeof ' + typeof add)

const boxes = [add, add]
console.log('same box ' + (boxes[0] === boxes[1]))
