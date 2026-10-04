// @ts-nocheck
//! expect: left:a,right:b true
// A method stated as `@return {Array<Object>}` that forwards another stated
// method's record array settles one census round after its first answer.
// The call, its signature and the const holding it must all take the settled
// records, not the first round's `Object[]`: three's `Node.serialize` reads
// `getSerializeChildren()` (forwarding `_getChildren()`) this way.
class Part {
  constructor(name) {
    this.name = name
    this.left = null
    this.right = null
  }
  /**
   * @returns {Array<Object>} The children.
   */
  _getChildren() {
    const children = []
    if (this.left !== null) children.push({ property: 'left', childNode: this.left })
    if (this.right !== null) children.push({ property: 'right', index: 0, childNode: this.right })
    return children
  }
  /**
   * @return {Array<Object>} The serializable children.
   */
  getSerializeChildren() {
    return this._getChildren()
  }
  serialize() {
    const nodeChildren = this.getSerializeChildren()
    const names = []
    for (const { property, childNode } of nodeChildren) names.push(property + ':' + childNode.name)
    return names.join(',')
  }
}
const root = new Part('root')
root.left = new Part('a')
root.right = new Part('b')
console.log(root.serialize(), new Part('leaf').serialize() === '')
