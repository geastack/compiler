// A type guard narrowing to `Member & { field: Narrower }` -- tsc's
// `node is CallExpression & { expression: Identifier; arguments: [StringLiteral] }`
// idiom -- names the SAME object the family lays out, with a narrower static
// view of fields the family already declares. It is not a new layout: the
// value is the family object, and every read past the guard goes through
// the family's own storage.
interface AstNode {
  readonly kind: number
  parent?: AstNode
}
interface Expression extends AstNode {
  _expressionBrand: any
}
interface Identifier extends Expression {
  readonly text: string
}
interface StringLiteral extends Expression {
  readonly text: string
}
interface CallExpression extends Expression {
  readonly expression: Expression
  readonly args: readonly Expression[]
}
interface BinaryExpression extends Expression {
  readonly left: Expression
  readonly operatorToken: AstNode
  readonly right: Expression
}

const KIND = { identifier: 1, string: 2, call: 3, binary: 4, equals: 5, plus: 6 }

function isIdentifier(node: AstNode): node is Identifier {
  return node.kind === KIND.identifier
}
function isStringLiteral(node: AstNode): node is StringLiteral {
  return node.kind === KIND.string
}
function isRequireCall(node: AstNode): node is CallExpression & { expression: Identifier; args: [StringLiteral] } {
  if (node.kind !== KIND.call) return false
  const call = node as CallExpression
  return isIdentifier(call.expression) && call.expression.text === 'req' && call.args.length === 1 && isStringLiteral(call.args[0]!)
}
type LiteralCall = CallExpression & { readonly args: [StringLiteral & { readonly text: string }] }
function isLiteralCall(node: AstNode): node is LiteralCall {
  return node.kind === KIND.call && (node as CallExpression).args.length === 1 && isStringLiteral((node as CallExpression).args[0]!)
}
function isAssignment(node: AstNode): node is BinaryExpression & { operatorToken: { kind: 5 } } {
  return node.kind === KIND.binary && (node as BinaryExpression).operatorToken.kind === KIND.equals
}

function describe(node: AstNode): string {
  if (isRequireCall(node)) return `require(${node.args[0].text}) via ${node.expression.text}`
  if (isAssignment(node)) return `assign:${node.operatorToken.kind}:${(node.left as Identifier).text}`
  if (isLiteralCall(node)) return `literal-call:${node.args[0].text}`
  return `other:${node.kind}`
}

const req: Identifier = { kind: KIND.identifier, text: 'req', _expressionBrand: undefined }
const fs: StringLiteral = { kind: KIND.string, text: 'fs', _expressionBrand: undefined }
const call: CallExpression = { kind: KIND.call, expression: req, args: [fs], _expressionBrand: undefined }
const x: Identifier = { kind: KIND.identifier, text: 'x', _expressionBrand: undefined }
const assign: BinaryExpression = {
  kind: KIND.binary,
  left: x,
  operatorToken: { kind: KIND.equals },
  right: fs,
  _expressionBrand: undefined
}
const sum: BinaryExpression = { kind: KIND.binary, left: x, operatorToken: { kind: KIND.plus }, right: fs, _expressionBrand: undefined }
const other: CallExpression = { kind: KIND.call, expression: x, args: [fs], _expressionBrand: undefined }
console.log(describe(call), '|', describe(assign), '|', describe(sum), '|', describe(x), '|', describe(other))
