// @ts-nocheck
// The TSL half of `prototype-install-runtime-key.runtime.js`: installs on
// another module's class prototype, keyed at run time, as `TSLCore.js`'s
// `addMethodChaining` does.
import { ExtNode, ExtOperatorNode } from './_prototype-install-nodes.js'

export function addChaining(name, nodeElement) {
  ExtNode.prototype[name] = function (...params) {
    return this.isStackNode ? null : nodeElement(this, params[0])
  }
  ExtNode.prototype[name + 'Assign'] = function (...params) {
    this.assigned = nodeElement(this, params[0])
    return this
  }
}

export const mul = (a, b) => new ExtOperatorNode('*', a, b)
export const add = (a, b) => new ExtOperatorNode('+', a, b)
addChaining('mul', mul)
addChaining('add', add)
ExtNode.prototype.get = function (name) {
  return 'installed:' + name + ':' + this.getNodeType()
}
