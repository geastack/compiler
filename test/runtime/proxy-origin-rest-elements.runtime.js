// @ts-nocheck
//! expect: pos|neg|3,-1
//! expect: typed 5
// TSL's `If( ...params )` (three/src/nodes/tsl/TSLCore.js) inside a `Fn`
// body: the arguments it gathers are results of calling a callable Proxy, so
// they may be proxies, but the rest array itself is the fresh Array the
// language binds. Its elements are dynamic; the array keeps its own carrier
// and packs as every rest array does.
class Node {
  constructor(v) { this.v = v }
  greaterThan(o) { return new Node(this.v > o) }
}
class Stack {
  If(cond, method) { if (cond.v) method(); return this }
}
let currentStack = new Stack()
/** @param {...any} params */
export const If = (...params) => currentStack.If(...params)
class FnNode {
  constructor(jsFunc) { this.jsFunc = jsFunc }
  call(...params) { return this.jsFunc(params) }
}
export function Fn(jsFunc) {
  const instance = new FnNode(jsFunc)
  return new Proxy(() => {}, {
    apply(target, thisArg, params) { return instance.call(...params) },
    get(target, prop, receiver) { return Reflect.get(instance, prop, receiver) }
  })
}
const positive = Fn(([x]) => x.greaterThan(0))
const out = []
const run = Fn(([a, b]) => {
  If(positive(a), () => { out.push('pos') })
  If(positive(b), () => { out.push('neg') })
  return a
})
const seen = [run(new Node(3), new Node(-3)).v, run(new Node(-1), new Node(1)).v]
console.log(out.join('|') + '|' + seen.join(','))
// A rest parameter with a stated element type keeps its array; the elements a
// proxy may be among become dynamic.
/** @param {...Node} nodes */
const firstOf = (...nodes) => nodes[0]
const picked = Fn(([a]) => firstOf(a, positive(a)))
console.log('typed', picked(new Node(5)).v)
