// @ts-nocheck
//! expect: max 4 [4,5,6] 3 6
//! expect: min 6 [1,2,3,4,5] 3 5
//! expect: pair 2 2 1 null undefined
//! expect: explicit 3 undefined true
// three's `MathNode` constructor, `( method, aNode, bNode = null, cNode = null )`,
// counts `arguments.length` so `max`/`min` can take any number of nodes. The
// checker gives such a constructor a phantom rest slot after its written
// parameters; the convention a `new` fills has to carry it too.
//
// `arguments.length` is the number of arguments the CALLER passed, never the
// number of written parameters: the `max`/`min` branch builds its chain with a
// three-argument `new MathNode`, and only a count of 3 there stops it from
// recursing until the stack overflows.
class MathNode {
  constructor(method, aNode, bNode = null, cNode = null) {
    this.count = arguments.length
    this.past = arguments[arguments.length]
    this.explicit = arguments.length > 2 && arguments[2] === undefined
    if ((method === 'max' || method === 'min') && arguments.length > 3) {
      const rest = []
      for (let i = 1; i < arguments.length; i++) rest.push(arguments[i])
      this.inputs = rest
      let finalOp = new MathNode(method, aNode, bNode)
      for (let i = 3; i < arguments.length - 1; i++) {
        finalOp = new MathNode(method, finalOp, arguments[i])
      }
      this.chain = finalOp.count
      this.last = arguments[arguments.length - 1]
    } else {
      this.inputs = [aNode, bNode]
    }
    this.cNode = cNode
  }
}
const wide = new MathNode('max', 4, 5, 6)
console.log('max', wide.count, '[' + wide.inputs.join(',') + ']', wide.chain, wide.last)
const wider = new MathNode('min', 1, 2, 3, 4, 5)
console.log('min', wider.count, '[' + wider.inputs.join(',') + ']', wider.chain, wider.last)
const pair = new MathNode('add', 1)
console.log('pair', pair.count, pair.inputs.length, pair.inputs[0], pair.cNode, pair.past)
const explicit = new MathNode('add', 1, undefined)
console.log('explicit', explicit.count, explicit.past, explicit.explicit)
