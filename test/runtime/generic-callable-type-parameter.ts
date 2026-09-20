//! expect: 2,2 0 2
//! emitted-lacks: callAsFunction
// A generic source function passed where the parameter's type is itself a
// generic callable (emitter.ts's `emitNodeList(emit, ...)` over
// `EmitFunction = <T extends Node>(node: T, ...) => void`): the value is one
// closure over the constraint, the parameter reads as that same signature,
// and each call through it converts its argument to the constraint. And a
// generic source function passed where the checker instantiates it in
// context (core.ts's `binarySearch(array, insert, identity, compare)`): the
// copy is the checker's instantiation, keyed on the reference.
interface SyntaxNode {
  readonly kind: number
}
interface Stmt extends SyntaxNode {
  readonly kind: 2
  readonly text: string
}
type EmitFunction = <T extends SyntaxNode>(node: T, rule?: (node: T) => T) => void
const out: string[] = []
function emit<T extends SyntaxNode>(node: T, rule?: (node: T) => T): void {
  const n = rule ? rule(node) : node
  out.push(String(n.kind))
}
function emitList<Child extends SyntaxNode>(emitFn: EmitFunction, children: readonly Child[]): void {
  for (const c of children) emitFn(c)
}
emitList(emit, [{ kind: 2, text: 'x' } as Stmt, { kind: 2, text: 'y' } as Stmt])
function identity<T>(x: T): T {
  return x
}
function search<T, U>(xs: readonly T[], key: (v: T) => U, cmp: (a: U, b: U) => number): number {
  let i = 0
  for (const x of xs) if (cmp(key(x), key(xs[0]!)) > 0) i++
  return i
}
function insertSorted<T>(xs: readonly T[], cmp: (a: T, b: T) => number): number {
  return search(xs, identity, cmp)
}
console.log(
  out.join(','),
  insertSorted([3, 1, 2], (a, b) => a - b),
  insertSorted([1, 3, 2], (a, b) => a - b)
)
