// @ts-nocheck
//! expect: true true 1
// An untagged `constructor(parent = null)` whose only callers pass a spread
// (`new NodeClass(...params)` through a factory, three's TSLCore proxies):
// the callers say nothing usable, so the parameter is open, and the field it
// fills must be open too. Typed by the checker's `null` of the default, the
// field unboxed every real parent into a carrier that holds only `null`.
class StackNode {
  constructor(parent = null) {
    this.parent = parent
    this.nodes = []
  }
}
const proxy = (NodeClass) => (...params) => new NodeClass(...params)
const stack = proxy(StackNode)
const outer = stack()
const inner = stack(outer)
inner.nodes.push(7)
console.log((outer.parent === null) + ' ' + (inner.parent === outer) + ' ' + inner.nodes.length)
