// @ts-nocheck
//! expect: true true true | true 3 | true true 2
// A named-key `delete` off a number or a typed array removes nothing and
// answers `true`: neither holds an ordinary own property. three's
// Renderer.highPrecision deletes `modelViewMatrix` off a Node's `value`, whose
// union has a number and a Float32Array arm beside the object arm.
class GraphNode {
  constructor(value) {
    this.value = value
  }
}
const nodes = [new GraphNode(3), new GraphNode(new Float32Array(2)), new GraphNode({ radiance: 2 })]
const clear = (node) => {
  const data = node.value
  return delete data.modelViewMatrix
}
const cleared = [clear(nodes[0]), clear(nodes[1]), clear(nodes[2])]
const count = 3
const fromNumber = delete count.toFixed
// An index past the end names no element; an in-bounds one is a
// non-configurable element, so a strict delete throws and keeps it.
const view = new Float32Array(2)
let threw = false
try {
  delete view[0]
} catch (error) {
  threw = error instanceof TypeError
}
console.log(cleared[0], cleared[1], cleared[2], '|', fromNumber, count, '|', delete view[5], threw, view.length)
