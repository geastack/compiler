// A database client's `CursorResponse.emptyGetMore`
// serializes `{ ok: 1, cursor: { id: 0n, nextBatch: [] } }`. The empty
// literal is a property of an object literal, so it is stored in that
// literal's own record, whose field is the checker's `never[]`; the array is
// built in that same carrier rather than as a box of unstated elements.
interface Doc {
  [key: string]: any
}

function describe(doc: Doc): string {
  return Object.keys(doc).join(',') + ' ' + JSON.stringify(doc)
}

const plain = { a: 1, b: [] }
//! expect: {"a":1,"b":[]} 0
console.log(JSON.stringify(plain) + ' ' + plain.b.length)
//! expect: ok,cursor {"ok":1,"cursor":{"id":0,"nextBatch":[]}}
console.log(describe({ ok: 1, cursor: { id: 0, nextBatch: [] } }))
