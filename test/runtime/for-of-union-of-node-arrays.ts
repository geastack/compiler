// tsc transformers/utilities.ts:357 / es2017.ts:640: `for (const element of
// name.elements)` where `name: BindingPattern = ObjectBindingPattern |
// ArrayBindingPattern`, so `elements` is `NodeArray<BindingElement> |
// NodeArray<ArrayBindingElement>` -- two named arrays whose element types
// are two members of ONE interface family (everything extends `Node`), so
// the deriver lays both arrays out identically and carries the read as one
// `array-object`. The iteration producer asked about STRUCTURAL identity,
// saw two distinct arms, and minted a `get-method` step no manifest claims:
// `protocol:iterator:get-method:array-object` (19 rows).
interface SyntaxNode {
  kind: string
  pos: number
}
interface Identifier extends SyntaxNode {
  kind: 'identifier'
  text: string
}
interface OmittedExpression extends SyntaxNode {
  kind: 'omitted'
}
interface BindingElement extends SyntaxNode {
  kind: 'binding'
  name: Identifier
}
type ArrayBindingElement = BindingElement | OmittedExpression
interface NodeArray<T> extends ReadonlyArray<T> {
  readonly pos: number
  readonly end: number
}
interface MutableNodeArray<T> extends Array<T> {
  pos: number
  end: number
}
interface ObjectBindingPattern extends SyntaxNode {
  kind: 'object-pattern'
  elements: NodeArray<BindingElement>
}
interface ArrayBindingPattern extends SyntaxNode {
  kind: 'array-pattern'
  elements: NodeArray<ArrayBindingElement>
}
type BindingPattern = ObjectBindingPattern | ArrayBindingPattern
function createNodeArray<T>(elements: readonly T[], pos: number): NodeArray<T> {
  const array = elements.slice() as MutableNodeArray<T>
  array.pos = pos
  array.end = pos + elements.length
  return array
}
function collect(name: BindingPattern): string[] {
  const names: string[] = []
  for (const element of name.elements) {
    if (element.kind !== 'omitted') names.push(element.name.text)
  }
  return names
}
const a: Identifier = { kind: 'identifier', text: 'a', pos: 0 }
const b: Identifier = { kind: 'identifier', text: 'b', pos: 5 }
const object: ObjectBindingPattern = {
  kind: 'object-pattern',
  pos: 0,
  elements: createNodeArray<BindingElement>([{ kind: 'binding', name: a, pos: 0 }], 1)
}
const array: ArrayBindingPattern = {
  kind: 'array-pattern',
  pos: 3,
  elements: createNodeArray<ArrayBindingElement>(
    [
      { kind: 'omitted', pos: 4 },
      { kind: 'binding', name: b, pos: 5 }
    ],
    4
  )
}
console.log(collect(object).join(','), collect(array).join(','), array.elements.pos, array.elements.end)
//! expect: a b 4 6
