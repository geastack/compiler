// tsc: `interface NodeArray<T extends Node> extends ReadonlyArray<T>,
// ReadonlyTextRange` declares no field mentioning `T`; its layout is the
// array built from the `ReadonlyArray<T>` heritage. The layout-relevance
// walk read only fields, folded `T`, and keyed EVERY instantiation to one
// anchor -- `NodeArray<any>` -- whose body carried whichever element the
// first instantiation had. Iterating a `NodeArray<ArrayBindingElement>` then
// read its elements as the `BindingElement`s of the `NodeArray<BindingElement>`
// interned before it, stopped only by the emitter's cursor-element guard.
//
// The union `ObjectBindingPattern | ArrayBindingPattern` iterated through
// `name.elements` is deliberately NOT here: two arrays over different
// elements are two carriers, their union is a tagged union, and its
// `get-iterator` refuses by name until a discriminated walk exists.
interface TextRange {
  pos: number
}
interface MutableNodeArray<T> extends Array<T>, TextRange {
  hasTrailingComma: boolean
}
interface NodeArray<T> extends ReadonlyArray<T> {
  readonly hasTrailingComma: boolean
  readonly pos: number
}
interface BindingElement {
  readonly kind: 'binding'
  readonly label: string
}
interface OmittedExpression {
  readonly kind: 'omitted'
}
type ArrayBindingElement = BindingElement | OmittedExpression
interface ObjectBindingPattern {
  readonly elements: NodeArray<BindingElement>
}
interface ArrayBindingPattern {
  readonly elements: NodeArray<ArrayBindingElement>
}
const nodeArrayOf = <T>(items: readonly T[], pos: number): NodeArray<T> => {
  const array = items.slice() as MutableNodeArray<T>
  array.hasTrailingComma = false
  array.pos = pos
  return array
}

const objectPattern: ObjectBindingPattern = {
  elements: nodeArrayOf<BindingElement>(
    [
      { kind: 'binding', label: 'a' },
      { kind: 'binding', label: 'b' }
    ],
    7
  )
}
const arrayPattern: ArrayBindingPattern = {
  elements: nodeArrayOf<ArrayBindingElement>([{ kind: 'binding', label: 'c' }, { kind: 'omitted' }, { kind: 'binding', label: 'd' }], 9)
}

let objectLabels = ''
for (const element of objectPattern.elements) objectLabels += element.label
let arrayLabels = ''
for (const element of arrayPattern.elements) arrayLabels += element.kind === 'binding' ? element.label : '_'
console.log(objectLabels, arrayLabels, objectPattern.elements.pos, arrayPattern.elements.pos, arrayPattern.elements.length)
//! expect: ab c_d 7 9 3
