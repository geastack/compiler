// @ts-nocheck
// Helper for jsdoc-field-tag-held-by-silent-writes.runtime.js.
import { stack } from './_late-stack-factory.js'

class Builder {
  constructor() {
    /**
     * Written only through the untyped `stack(...)` factory; this file never imports StackNode.
     *
     * @type {StackNode}
     */
    this.stack = stack()
  }
  /** @return {StackNode} */
  addStack() {
    this.stack = stack(this.stack)
    return this.stack
  }
  /** @return {StackNode} */
  removeStack() {
    const lastStack = this.stack
    this.stack = lastStack.parent
    return lastStack
  }
}
export default Builder
