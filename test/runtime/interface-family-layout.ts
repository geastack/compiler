//! expect: 3 id:x lit:7 true 3 undefined 3 x 4 false true
// Interfaces an `extends` graph connects are VIEWS of one object, and the
// layout follows the object: tsc's `Identifier`, `Statement`, `SourceFile` are
// 300 views of what `function Node(kind, pos, end)` allocates, written through
// one view and read through another. One struct for the family keeps identity
// across views (`stmt.expression === ident`), makes every `Identifier -> SyntaxNode`
// pass an identity rather than a conversion nothing could install, and carries
// a field only some views declare behind a presence bit.
interface TextRange {
  pos: number
  end: number
}
interface SyntaxNode extends TextRange {
  kind: number
  parent?: SyntaxNode
}
interface Expression extends SyntaxNode {
  precedence?: number
}
interface Identifier extends Expression {
  kind: 1
  text: string
}
interface Literal extends Expression {
  kind: 2
  value: number
}
interface Statement extends SyntaxNode {
  kind: 3
  expression: Expression
}
const isIdentifier = (n: SyntaxNode): n is Identifier => n.kind === 1
const describe = (n: SyntaxNode): string => (isIdentifier(n) ? `id:${n.text}` : n.kind === 2 ? `lit:${(n as Literal).value}` : 'other')
const span = (r: TextRange): number => r.end - r.pos
const same = (a: SyntaxNode, b: SyntaxNode): boolean => a === b
const ident: Identifier = { pos: 0, end: 1, kind: 1, text: 'x' }
const lit: Literal = { pos: 2, end: 3, kind: 2, value: 7 }
const stmt: Statement = { pos: 0, end: 3, kind: 3, expression: ident }
const nodes: SyntaxNode[] = [ident, lit, stmt]
const first = nodes[0]
const before = ident.parent?.kind
ident.parent = stmt
console.log(
  nodes.length,
  describe(ident),
  describe(lit),
  same(stmt.expression, ident),
  span(stmt),
  before,
  ident.parent?.kind,
  first !== undefined && isIdentifier(first) ? first.text : '-',
  span({ pos: 1, end: 5 }),
  'text' in lit,
  'text' in ident
)
