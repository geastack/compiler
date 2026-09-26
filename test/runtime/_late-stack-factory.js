// @ts-nocheck
// Helper for jsdoc-field-tag-held-by-silent-writes.runtime.js.
import StackNode from './_late-stack-node.js'

const proxy = (NodeClass) => (...params) => new NodeClass(...params)
export const stack = proxy(StackNode)
