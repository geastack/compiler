// @ts-nocheck
//! expect: 1 true true
// A JS field's `@type` naming an unimported default-export class, where every
// write is silent (an untyped factory call, or a read of the field's own
// `parent`): three's `NodeBuilder.stack`, `@type {StackNode}`, written
// `this.stack = stack(this.stack)` and returned by `addStack()`. The tag is
// not evidence enough to bind the field, and the call `builder.addStack()`
// keeps one result type.
import Builder from './_late-stack-builder.js'
import StackNode from './_late-stack-node.js'

const builder = new Builder()
const inner = builder.addStack()
inner.add(7)
const removed = builder.removeStack()
console.log(inner.nodes.length + ' ' + (removed === inner) + ' ' + (builder.stack instanceof StackNode))
