// @ts-nocheck
// A literal whose every element is untyped states nothing about its element,
// so the checker lays it out as `any[]` while the parameter the const is
// passed to states `@param {?Array<string>}`: one array, two carriers, and
// no conversion between array elements that keeps its identity. The literal
// takes the statement and each element converts into it (three's
// `TextureNode.generate`, `const gradSnippet = gradNode ? [ ... ] : null`).
class Part {
  /**
   * @param {string} type - The type.
   * @return {string} The snippet.
   */
  build(type) {
    return 'b' + type
  }
}
class Snippets {
  /**
   * @param {string} head - The head.
   * @param {?Array<string>} grad - The gradient snippets.
   * @return {string} The snippet.
   */
  generate(head, grad) {
    return grad === null ? head : head + '(' + grad.join(',') + ')'
  }
  /**
   * @param {Array<string>} names - The names.
   * @return {number} The name count.
   */
  count(names) {
    return names.length
  }
  build(properties) {
    const { gradNode, levelNode } = properties
    const gradSnippet = gradNode ? [gradNode[0].build('vec2'), gradNode[1].build('vec3')] : null
    const levels = [levelNode.build('f'), levelNode.build('i')]
    const extra = gradSnippet !== null ? this.count(gradSnippet) : 0
    return this.generate('s', gradSnippet) + ':' + this.count(levels) + ':' + extra
  }
}
const snippets = new Snippets()
const bag = {}
bag.gradNode = null
bag.levelNode = new Part()
console.log(snippets.build(bag), snippets.build({ gradNode: [new Part(), new Part()], levelNode: new Part() }))
//! expect: s:2:0 s(bvec2,bvec3):2:2
