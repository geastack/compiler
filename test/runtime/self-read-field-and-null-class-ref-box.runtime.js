//! dynamic-fallback
//! expect: null * true object * null
// A field written `null` and later `this.getWildcardChild() || new Wildcard()`
// holds either class instance or null -- a read of the field adds nothing
// new to its writes -- and a null class reference boxes as the null value,
// never as an object box holding nothing. find-my-way's router node.
'use strict'
class Wildcard { constructor () { this.label = '*' } }
class TreeNode {
  constructor () { this.wildcardChild = null }
  getWildcardChild () { return this.wildcardChild }
  createWildcardChild () {
    this.wildcardChild = this.getWildcardChild() || new Wildcard()
    return this.wildcardChild
  }
}
function describe (value) { return value === null ? 'null' : typeof value === 'object' ? 'object ' + value.label : typeof value }
const n = new TreeNode()
const before = describe(n.getWildcardChild())
const made = n.createWildcardChild()
const again = n.createWildcardChild()
const boxes = [n.getWildcardChild(), new TreeNode().getWildcardChild()]
console.log(before, made.label, again === made, describe(boxes[0]), describe(boxes[1]))
