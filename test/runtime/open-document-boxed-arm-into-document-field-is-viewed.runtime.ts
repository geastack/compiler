// AN OPEN-DOCUMENT CELL WITH A BOXED ARM, ITS `Array.isArray` READ STORED INTO
// A `Document` FIELD.
//
// A binary-document serializer walks nested values typed `any` and hands each to
// `makeFrame(sourceObject: Document, ...)`, so the cell holds a box beside the
// dictionary, the guard's `any[]` and `Map`. Under `Array.isArray` the read is
// the array arm OR the box (a boxed array passes the guard too). Each arm
// enters the `Document` field as the object it holds, viewed: the array arm
// through `gea::dictionary::aliasOf`, the box through the same view of the
// Array, Map or record it boxes. This once certified by SELECTING the box,
// untested, and later aborted "expected an object" on a boxed array or a
// record boxed by value; neither copies nor aborts now.

interface Doc {
  [key: string]: any
}
interface Frame {
  source: Doc
  target: Doc
  kind: string
  prev: Frame | null
}
function makeFrame(source: Doc, prev: Frame | null): Frame {
  if (Array.isArray(source)) {
    return { source, target: source, kind: 'array', prev }
  }
  if (source instanceof Map) {
    return { source, target: source, kind: 'map', prev }
  }
  return { source, target: source, kind: 'object', prev }
}
function walk(root: Doc): string {
  const out: string[] = []
  let frame: Frame | null = makeFrame(root, null)
  const pending: any[] = []
  for (const key of Object.keys(root)) pending.push(root[key])
  while (frame !== null) {
    out.push(`${frame.kind}:${Object.keys(frame.source).join('|')}`)
    const next: any = pending.shift()
    frame = next !== undefined && typeof next === 'object' ? makeFrame(next, frame) : pending.length > 0 ? makeFrame({}, frame) : null
  }
  return out.join(' ')
}
const root: Doc = { a: [1, 2], b: { c: 3 } }
//! expect: object:a|b array:0|1 object:c
console.log(walk(root))
