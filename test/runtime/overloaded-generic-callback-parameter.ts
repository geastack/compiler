interface Nd {
  kind: number
  child?: Nd
}
type Visitor = (node: Nd) => Nd | undefined
interface NodeVisitor {
  <TIn extends Nd | undefined, TOut extends Nd>(
    node: TIn,
    visitor: Visitor | undefined,
    test: (node: Nd) => node is TOut
  ): TOut | (TIn & undefined)
  <TIn extends Nd | undefined>(node: TIn, visitor: Visitor | undefined, test?: (node: Nd) => boolean): Nd | (TIn & undefined)
}
interface Leaf extends Nd {
  kind: 7
}
const isLeaf = (node: Nd): node is Leaf => node.kind === 7
function visitNode<TIn extends Nd | undefined, TOut extends Nd>(
  node: TIn,
  visitor: Visitor | undefined,
  test: (node: Nd) => node is TOut
): TOut | (TIn & undefined)
function visitNode<TIn extends Nd | undefined>(
  node: TIn,
  visitor: Visitor | undefined,
  test?: (node: Nd) => boolean
): Nd | (TIn & undefined)
function visitNode<TIn extends Nd | undefined>(node: TIn, visitor: Visitor | undefined, test?: (node: Nd) => boolean): Nd | undefined {
  if (node === undefined) return undefined
  const visited = visitor ? visitor(node) : node
  if (visited && test && !test(visited)) throw new Error('bad')
  return visited
}
function eachChild(node: Nd, visitor: Visitor, nodeVisitor: NodeVisitor = visitNode): Nd | undefined {
  return nodeVisitor(node.child, visitor, isLeaf)
}
const v: Visitor = (n) => (n.kind === 7 ? { kind: 7 } : { kind: n.kind + 1 })
console.log(eachChild({ kind: 1, child: { kind: 7 } }, v)?.kind, eachChild({ kind: 1 }, v))
//! expect: 7 undefined
