// @ts-nocheck
//! expect: found 5
//! expect: none
//! expect: late 7 8
// three's `RangeNode.getConstNode` exactly: a cell initialized to `null` and
// written only inside a callback. The checker saw the initializer and not the
// callback, so it reads `output` as `null` at the test and `never` after it;
// the cell holds an instance by then. The read is the cell's own carrier.
class TreeNode {
  /** @param {number} value */
  constructor(value) {
    this.value = value
    this.isConstNode = false
  }
  /** @param {(node: TreeNode) => void} callback */
  traverse(callback) {
    callback(this)
  }
  bump() {
    return this.value + 1
  }
}
class ConstTreeNode extends TreeNode {
  /** @param {number} value */
  constructor(value) {
    super(value)
    this.isConstNode = true
  }
}
/**
 * @param {TreeNode} node
 * @returns {TreeNode|null}
 */
function getConstNode(node) {
  let output = null
  node.traverse((n) => {
    if (n.isConstNode === true) output = n
  })
  if (output === null) return null
  return output
}
const found = getConstNode(new ConstTreeNode(5))
console.log(found === null ? 'none' : 'found ' + found.value)
console.log(getConstNode(new TreeNode(1)) === null ? 'none' : 'found')
let late = null
const fill = () => {
  late = new ConstTreeNode(7)
}
fill()
if (late !== null) console.log('late ' + late.value + ' ' + late.bump())
