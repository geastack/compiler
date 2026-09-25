// @ts-nocheck
//! expect: chain * float vec3 true true
//! expect: nested + * true
//! expect: assign true * this
//! expect: get installed:x:float declared:y installed:z:float
//! expect: own-keys nodeType | nodeType,op,aNode,bNode
//! expect: shared true true
// three's TSL installs its node methods on `Node.prototype` from another
// module, with keys computed at run time (`addMethodChaining`), and every
// node class inherits them. A read that misses the instance and every
// declared method finds them in the prototype's table; a subclass's own
// declared method still wins (`MRTNode.get` over the installed `get`). The
// installs are prototype entries, never own keys of an instance.
import { ExtNode, ExtOperatorNode, ExtMemberNode } from './_prototype-install-nodes.js'
import './_prototype-install-chaining.js'

const a = new ExtNode('float')
const b = new ExtNode('vec3')
const product = a.mul(b)
console.log(
  'chain',
  product.op,
  product.aNode.getNodeType(),
  product.bNode.getNodeType(),
  product instanceof ExtOperatorNode,
  product.aNode === a
)
const sum = product.add(a)
console.log('nested', sum.op, sum.aNode.op, sum.bNode === a)
const self = a.mulAssign(b)
console.log('assign', self === a, a.assigned.op, self === a ? 'this' : 'other')
console.log('get', a.get('x'), new ExtMemberNode('int').get('y'), product.get('z'))
console.log('own-keys', Object.keys(b).join(','), '|', Object.keys(product).join(','))
console.log('shared', a.mul === b.mul, product.mul === a.mul)
