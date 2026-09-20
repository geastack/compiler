// tsc transformers: `for (const element of name.elements)` where `elements`
// is a `NodeArray<T>` -- an interface extending `ReadonlyArray<T>` with its
// own fields (`pos`, `end`, `hasTrailingComma`), built exactly as
// `factory/nodeFactory.ts`'s `createNodeArray` builds one: `elements.slice()
// as MutableNodeArray<T>` and field writes. The carrier is `array-object`;
// iterating it asked for
// `runtime-helper:protocol:iterator:get-method:array-object` (19 rows).
interface Item {
  name: string
  omitted: boolean
}
interface NodeArray<T> extends ReadonlyArray<T> {
  readonly pos: number
  readonly end: number
  readonly hasTrailingComma: boolean
}
interface MutableNodeArray<T> extends Array<T> {
  pos: number
  end: number
  hasTrailingComma: boolean
}
function createNodeArray<T>(elements: readonly T[], pos: number): NodeArray<T> {
  const array = elements.slice() as MutableNodeArray<T>
  array.pos = pos
  array.end = pos + elements.length
  array.hasTrailingComma = false
  return array
}
function collect(elements: NodeArray<Item>): string[] {
  const names: string[] = []
  for (const element of elements) {
    if (!element.omitted) names.push(element.name)
  }
  return names
}
const elements = createNodeArray<Item>(
  [
    { name: 'a', omitted: false },
    { name: 'b', omitted: true },
    { name: 'c', omitted: false }
  ],
  7
)
console.log(collect(elements).join(','), elements.pos, elements.end, elements.length)
//! expect: a,c 7 10 3
