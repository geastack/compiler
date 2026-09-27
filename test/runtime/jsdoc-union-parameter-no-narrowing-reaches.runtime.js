// @ts-nocheck
//! expect: c1 r2
//! expect: g3
//! expect: r2 c1 g3
// three's `WebGLBackend.beginCompute( computeGroup )` states `@param
// {Node|Array<Node>} computeGroup` and passes it on to `Backend.getTimestampUID(
// abstractRenderContext )` under `@param {RenderContext|ComputeNode}`. The
// `Node` arm is an ancestor of `ComputeNode`, but no arm of the argument is a
// `RenderContext`, so no test of the argument narrows it into the tag: the
// `Array` arm is a value the parameter holds, and the tag is contradicted.
class Node {
  constructor(id) {
    this.isNode = true
    this.id = id
  }
}
class ComputeNode extends Node {
  constructor(id) {
    super(id)
    this.count = 4
  }
}
class RenderContext {
  constructor(id) {
    this.id = id
    this.width = 3
  }
}
class Backend {
  constructor() {
    this.data = new WeakMap()
    this.calls = 0
  }
  get(object) {
    let map = this.data.get(object)
    if (map === undefined) {
      map = {}
      this.data.set(object, map)
    }
    return map
  }
  /**
   * @param {RenderContext|ComputeNode} abstractRenderContext - The render context.
   * @param {string} prefix - The prefix.
   */
  updateTimeStampUID(abstractRenderContext, prefix) {
    this.calls++
    this.get(abstractRenderContext).timestampUID = prefix + this.calls
  }
  /**
   * @param {RenderContext|ComputeNode} abstractRenderContext - The render context.
   * @return {string} The unique identifier.
   */
  getTimestampUID(abstractRenderContext) {
    return this.get(abstractRenderContext).timestampUID
  }
}
class GLBackend extends Backend {
  /**
   * @param {Node|Array<Node>} computeGroup - The compute node(s).
   */
  beginCompute(computeGroup) {
    this.last = this.getTimestampUID(computeGroup)
  }
}
const backend = new GLBackend()
const one = new ComputeNode(1)
/** @type {Array<Node>} */
const group = [new ComputeNode(2)]
const context = new RenderContext(3)
backend.updateTimeStampUID(one, 'c')
backend.updateTimeStampUID(context, 'r')
backend.updateTimeStampUID(group, 'g')
backend.beginCompute(one)
const first = backend.last
console.log(first + ' ' + backend.getTimestampUID(context))
backend.beginCompute(group)
console.log(backend.last)
console.log(backend.getTimestampUID(context) + ' ' + first + ' ' + backend.last)
export {}
