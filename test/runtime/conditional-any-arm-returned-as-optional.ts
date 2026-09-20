// tsc visitorPublic.ts:604, `visitEachChild<T extends Node>`:
//   const fn = (visitEachChildTable as Record<SyntaxKind, VisitEachChildFunction<any> | undefined>)[node.kind]
//   return fn === undefined ? node : fn(node, visitor, ...)
// The conditional merges `T` with a declared `any` into
// `tagged-union(native-record-ref | dynamic)`, and the function returns
// `T | undefined`. 74 rows -- one site, one per instantiation -- asked for a
// `return-conversion` nothing installed. The value converts arm by arm: the
// typed arm is the payload, the dynamic arm is the checked unbox every
// declared-`any` read already performs.
interface SyntaxNode {
  kind: number
  text: string
}
type VisitFn<T extends SyntaxNode> = (node: T) => T
const table: Record<number, VisitFn<any> | undefined> = {
  1: (node: SyntaxNode) => ({ kind: node.kind, text: node.text + '!' })
}
function visitEachChild<T extends SyntaxNode>(node: T | undefined): T | undefined {
  if (node === undefined) return undefined
  const fn = table[node.kind]
  return fn === undefined ? node : fn(node)
}
const a = visitEachChild<SyntaxNode>({ kind: 1, text: 'a' })
const b = visitEachChild<SyntaxNode>({ kind: 2, text: 'b' })
console.log(a?.text, b?.text, visitEachChild<SyntaxNode>(undefined) === undefined ? 'none' : 'some')
//! expect: a! b none
