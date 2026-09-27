// @ts-nocheck
// A stated return (`@return {Array<Object>}`, or an element name the file
// never imports) is only an upper bound, and the return census narrows the
// call to the array of records the body builds. A `const` initialized by
// that call held the checker's statement instead, and an override that
// returns it kept the statement too: one array, two carriers, and no
// conversion between array elements that keeps its identity (three's
// `StructNode._getChildren` over `Node._getChildren`, and
// `WebGPUBindingUtils.createBindingsLayout` over `_createLayoutEntries`).
class TreeNode {
  /** @param {string} name - The name. */
  constructor(name) {
    this.name = name
    this.isTreeNode = true
    this.left = null
    this.right = null
  }
  /**
   * @returns {Array<Object>} The child records.
   */
  _getChildren() {
    const children = []
    if (this.left !== null) children.push({ property: 'left', childNode: this.left })
    if (this.right !== null) children.push({ property: 'right', childNode: this.right })
    return children
  }
  /** @return {string} The names, depth first. */
  walk() {
    let out = this.name
    for (const { childNode } of this._getChildren()) out += '(' + childNode.walk() + ')'
    return out
  }
}
class FlippedNode extends TreeNode {
  _getChildren() {
    const children = super._getChildren()
    children.reverse()
    return children
  }
}
class Layouts {
  /**
   * @param {Array<TreeNode>} nodes - The nodes.
   * @return {number} The entry count.
   */
  count(nodes) {
    const entries = this._entries(nodes)
    let total = 0
    for (const entry of entries) total += entry.binding
    return total + entries.length
  }
  /**
   * @param {Array<TreeNode>} nodes - The nodes.
   * @return {Array<GPUBindGroupLayoutEntry>} The entries.
   */
  _entries(nodes) {
    const entries = []
    let index = 0
    for (const node of nodes) entries.push({ binding: index++, visibility: node.name.length })
    return entries
  }
}
const root = new TreeNode('r')
root.left = new TreeNode('a')
root.right = new FlippedNode('b')
root.right.left = new TreeNode('c')
root.right.right = new TreeNode('d')
console.log(root.walk(), new Layouts().count([root, root.left, root.right]))
//! expect: r(a)(b(d)(c)) 6
