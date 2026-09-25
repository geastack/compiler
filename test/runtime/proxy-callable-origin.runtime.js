// @ts-nocheck
//! expect: call 1+2 function fn
//! expect: pick 3+4 only 5
//! expect: param 6+6
//! expect: plain 7

// TSL's `Fn(jsFunc)` (three/src/nodes/tsl/TSLCore.js): a callable Proxy over
// a dummy arrow whose `apply` trap forwards to a node. Without
// `--dynamic-fallback` only the values that may hold that proxy are dynamic:
// the factory's result, the bindings it lands in, a conditional arm, and a
// plain function's parameter it is passed to. The checker types every one of
// them `() => void`, so a call through one is `void` to it; the trap decides.
class FnNode {
  constructor(jsFunc) {
    this.jsFunc = jsFunc
    this.label = 'fn'
  }
  call(...params) {
    return this.jsFunc(params[0], params[1])
  }
}
export function Fn(jsFunc) {
  const instance = new FnNode(jsFunc)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) {
      return instance.call(...params)
    },
    get(target, prop) {
      let value
      value = instance[prop]
      return value
    }
  })
}
const join = Fn((a, b) => `${a}+${b}`)
const sum = join(1, 2)
console.log('call', sum, typeof join, join.label)
const pick = (flag) => (flag ? join : Fn((a) => `only ${a}`))
console.log('pick', pick(true)(3, 4), pick(false)(5))
/**
 * @param {() => void} fn
 * @param {number} x
 */
function invoke(fn, x) {
  return fn(x, x)
}
console.log('param', invoke(join, 6))
// The same `() => void` shape, never a proxy, keeps its native convention.
/** @param {() => number} f */
const run = (f) => f()
console.log(
  'plain',
  run(() => 7)
)
