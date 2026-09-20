interface AstNode {
  kind: number
  parent?: AstNode
  doc?: string
}
interface Ident extends AstNode {
  text: string
}
interface Lit extends AstNode {
  value: number
}
interface BlockNode extends AstNode {
  statements: AstNode[]
}
type HasDoc = Ident | Lit
function hasDoc(node: AstNode): node is HasDoc {
  return node.kind === 1 || node.kind === 2
}
function preserve<T extends AstNode>(updated: T, original: AstNode): T {
  if (hasDoc(updated) && hasDoc(original)) {
    updated.doc = original.doc
  }
  return updated
}
function cast<TOut extends TIn, TIn = any>(value: TIn | undefined, test: (value: TIn) => value is TOut): TOut {
  if (value !== undefined && test(value)) return value
  throw new Error('bad cast')
}
const isIdentifier = (node: AstNode): node is Ident => node.kind === 1
const id: Ident = { kind: 1, text: 'x', doc: 'first' }
const lit: Lit = { kind: 2, value: 3 }
const block: BlockNode = { kind: 3, statements: [id, lit] }
const kept = preserve(lit, id)
const named = cast<Ident, AstNode>(block.statements[0], isIdentifier)
console.log(kept.doc, kept.value, preserve(block, id).doc, named.text)
//! expect: first 3 undefined x
