// @ts-nocheck
//! expect: max 4 [4,5,6]
//! expect: pair 2 1 null
// three's `MathNode` constructor, `( method, aNode, bNode = null, cNode = null )`,
// counts `arguments.length` so `max`/`min` can take any number of nodes. The
// checker gives such a constructor a phantom rest slot after its written
// parameters; the convention a `new` fills has to carry it too.
class MathNode {
  constructor(method, aNode, bNode = null, cNode = null) {
    if (method === 'max' && arguments.length > 3) {
      const rest = []
      for (let i = 1; i < arguments.length; i++) rest.push(arguments[i])
      this.inputs = rest
    } else {
      this.inputs = [aNode, bNode]
    }
    this.count = arguments.length
    this.cNode = cNode
  }
}
const wide = new MathNode('max', 4, 5, 6)
console.log('max', wide.count, '[' + wide.inputs.join(',') + ']')
const pair = new MathNode('add', 1)
console.log('pair', pair.inputs.length, pair.inputs[0], pair.cNode)
