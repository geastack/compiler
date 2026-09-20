//! expect: a=1 orig=none
//! expect: b=2 orig=1
//! expect: c=3 orig=1
//! expect: same=true differ=false
//! emitted-lacks: callAsFunction
//! emitted-has: case 1: { return gea_body_fn_decl_
// A const holding one of two GENERIC functions, chosen at runtime, called
// through the binding directly and from inside a generic that captures it --
// TypeScript's own `setOriginal = flags & NoOriginalNode ? identity :
// setOriginalNode` in nodeFactory.ts. The checker's declared type for the
// binding reduces to `typeof setOriginalNode` (identity's type is a subtype),
// so a compiler trusting it would run setOriginalNode on the identity branch
// and set `original` where the program does not.
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
const keep = Date.now() > 0 ? identity : setOriginalNode
const set = Date.now() < 0 ? identity : setOriginalNode
function update<T extends SyntaxNode>(updated: T, original: T): T {
  set(updated, original)
  return updated
}
const root: SyntaxNode = { kind: 1 }
const a = keep({ kind: 1 } as SyntaxNode, root)
const b = set({ kind: 2 } as SyntaxNode, root)
const c = update({ kind: 3 } as SyntaxNode, root)
console.log(`a=${a.kind} orig=${a.original ? a.original.kind : 'none'}`)
console.log(`b=${b.kind} orig=${b.original ? b.original.kind : 'none'}`)
console.log(`c=${c.kind} orig=${c.original ? c.original.kind : 'none'}`)
console.log(`same=${set === set} differ=${keep === set}`)
