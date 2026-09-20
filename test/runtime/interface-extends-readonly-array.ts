//! expect: 1 1,2 2 7 false undefined 4 4 3 1 7 -1 -1
//! emitted-has: extensionFieldsMut
// An interface extending a lib array type is an ARRAY with extra fields, not a
// record carrying the array's generic methods as storage: TypeScript's own
// `NodeArray<T> extends ReadonlyArray<T>, ReadonlyTextRange`. The fields live
// in the runtime array's extension sidecar, so `items.slice() as
// MutableNodeArray<T>` is the same object, the readonly and mutable spellings
// are one carrier, and the result still indexes, iterates and maps as an array.
interface Statement {
  readonly kind: number
}
interface TextRange {
  pos: number
}
interface MutableNodeArray<T extends Statement> extends Array<T>, TextRange {
  hasTrailingComma: boolean
}
interface NodeArray<T extends Statement> extends ReadonlyArray<T> {
  readonly hasTrailingComma: boolean
  readonly pos: number
}
// An optional field (`JSDocArray extends Array<JSDoc> { jsDocCache?: ... }`)
// carries a presence bit: read before any write it is `undefined`, not the
// member's default-constructed value.
interface TagArray extends Array<number> {
  cache?: readonly number[]
}
const cached = (tags: TagArray): number => {
  if (tags.cache === undefined) tags.cache = tags.map((t) => t + 1)
  return tags.cache.length
}
const tags: TagArray = [1, 2, 3]
const before = tags.cache
tags.push(4)
const count = cached(tags)
const make = <T extends Statement>(items: readonly T[], pos: number): NodeArray<T> => {
  const array = items.slice() as MutableNodeArray<T>
  array.hasTrailingComma = false
  array.pos = pos
  return array
}
const first = (statements: NodeArray<Statement>): Statement | undefined => statements[0]
const kinds = (statements: NodeArray<Statement>): string => statements.map((s) => String(s.kind)).join(',')
// A named array iterates as the array it is -- `for...of` and a pattern take
// the native cursor, not a `[Symbol.iterator]` lookup -- and a `readonly T[]
// | undefined` parameter proven present and then `isNodeArray` reads its
// fields through the same handle (tsc's `createNodeArray`).
const total = (statements: NodeArray<Statement>): number => {
  let t = 0
  for (const s of statements) t += s.kind
  return t
}
const isNodeArray = (a: readonly Statement[]): a is NodeArray<Statement> => a.length > 0
const posOf = (items?: readonly Statement[]): number => (items !== undefined && isNodeArray(items) ? items.pos : -1)
const list = make([{ kind: 1 }, { kind: 2 }], 7)
const [head] = list
console.log(
  first(list)?.kind,
  kinds(list),
  list.length,
  list.pos,
  list.hasTrailingComma,
  before,
  count,
  tags.cache?.length,
  total(list),
  head?.kind,
  posOf(list),
  posOf(undefined),
  posOf([])
)
