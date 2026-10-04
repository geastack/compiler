// @ts-nocheck
//! expect: flow 1 2 4 b,c,a
//! expect: skips 7 x
//! expect: same true
// three's ContextNode.getFlowContextData: `Object.assign( {}, ...children )`
// passes every source through a spread. ECMA-262 20.1.2.1 copies each
// source's own enumerable keys into the target in order (a later source
// overwrites an earlier one), skips an undefined/null source, and returns the
// target itself.
class Ctx {
  constructor(value, parent) {
    this.value = value
    this.parent = parent
    this.isContextNode = true
  }
  traverse(callback) {
    for (let node = this; node; node = node.parent) callback(node)
  }
  getFlowContextData() {
    const children = []
    this.traverse((node) => {
      if (node.isContextNode === true) children.push(node.value)
    })
    return Object.assign({}, ...children)
  }
}
const root = new Ctx(JSON.parse('{"a":1,"b":2}'), null)
const leaf = new Ctx(JSON.parse('{"b":3,"c":4}'), root)
const data = leaf.getFlowContextData()
console.log('flow', data.a, data.b, data.c, Object.keys(data).join(','))
const holes = JSON.parse('[null,{"n":7},{"k":"x"}]')
holes.push(undefined)
const merged = Object.assign({}, ...holes)
console.log('skips', merged.n, merged.k)
const target = {}
console.log('same', Object.assign(target, ...holes) === target)
