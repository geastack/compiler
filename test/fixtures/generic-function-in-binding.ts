// A binding that holds one of two generic functions, called through the binding.
interface SyntaxNode {
  readonly kind: number
  original?: SyntaxNode
}
function identity<T>(x: T): T {
  return x
}
function setOriginalNode<T extends SyntaxNode>(node: T, original: SyntaxNode | undefined): T {
  node.original = original
  return node
}
const flags = 1
const setOriginal = flags & 2 ? identity : setOriginalNode
const a: SyntaxNode = { kind: 1 }
const b = setOriginal({ kind: 2 } as SyntaxNode, a)
console.log(b.kind, b.original?.kind)
