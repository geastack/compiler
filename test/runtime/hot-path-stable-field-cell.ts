// `count(node)` names each child in a `const` and walks it. The fields are
// written only by the constructor and `node` is borrowed, so each `const`
// names the field for the whole call: no cell, no retain, no release. As a
// copy into the cell it was a retain/release pair per child per node walked,
// a quarter of the binary-trees benchmark at one thread.
class TreeNode {
  readonly left: TreeNode | null
  readonly right: TreeNode | null

  constructor(left: TreeNode | null, right: TreeNode | null) {
    this.left = left
    this.right = right
  }
}

function build(depth: number): TreeNode {
  return depth === 0 ? new TreeNode(null, null) : new TreeNode(build(depth - 1), build(depth - 1))
}

function count(node: TreeNode): number {
  const left = node.left
  const right = node.right
  return 1 + (left === null ? 0 : count(left)) + (right === null ? 0 : count(right))
}

console.log(count(build(12)))
