// `sum(node)` takes a nullable class handle and only reads fields off it and
// recurses. The formal must be borrowed -- `const gea::Ref<T>&` -- not copied:
// a by-value `Ref` retains on entry and releases on exit for every node, and
// each of those releases buffers the node as a cycle candidate (and pins its
// block until the next collection). That is the shape behind
// `bench/comparison/fixtures/binary_trees.ts`, which ran SLOWER than node
// while `sum` copied.
//
// Three facts had to line up for the borrow: a data-field read on a class
// instance counts as a borrow-safe operation, a body's calls to itself do not
// block its own proof, and an `optional` over a ref-counted payload borrows
// even though `passingOf` says by-value.
class TreeNode {
  value: number
  left: TreeNode | null
  right: TreeNode | null
  constructor(value: number, left: TreeNode | null, right: TreeNode | null) {
    this.value = value
    this.left = left
    this.right = right
  }
}

function build(depth: number, value: number): TreeNode | null {
  if (depth === 0) return null
  return new TreeNode(value, build(depth - 1, value * 2), build(depth - 1, value * 2 + 1))
}

function sum(node: TreeNode | null): number {
  if (node === null) return 0
  return node.value + sum(node.left) + sum(node.right)
}

const tree = build(12, 1)
console.log(sum(tree), sum(null))
