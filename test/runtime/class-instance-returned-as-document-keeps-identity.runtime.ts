// A class instance handed where a database client's `Document` (`{ [key:
// string]: any }`) is declared IS the instance, viewed at another static type:
// `RenameOperation.handleOk(): Document` returns a `Collection`,
// `ValidateCollectionOperation.handleOk` returns its response object, and
// `Topology.lastHello(): Document` returns a `ServerDescription`.
//
// Reads through the document see the instance's CURRENT state -- its own
// fields and its prototype getters -- writes through the document land on the
// instance, and the document narrows back to the very same object. A snapshot
// of the own fields would print `2 1`, `1`, `1`, `false` instead.
interface WireDocument {
  [key: string]: any
}

class CursorResponse {
  private counts: Map<string, number> = new Map([['nInserted', 2]])
  batch = 1
  get insertedCount(): number {
    return this.counts.get('nInserted') ?? 0
  }
  record(inserted: number): void {
    this.counts.set('nInserted', inserted)
  }
}

function asDocument(response: CursorResponse): WireDocument {
  return response
}

const response = new CursorResponse()
const doc = asDocument(response)
console.log(doc.insertedCount, doc.batch)
response.record(9)
response.batch = 5
console.log(doc.insertedCount, doc.batch)
doc.batch = 7
console.log(response.batch)
console.log(doc instanceof CursorResponse, 'batch' in doc, 'missing' in doc)
console.log('same', asDocument(response) === doc)
console.log(Object.keys(doc).join(','), doc.hasOwnProperty('insertedCount'), 'insertedCount' in doc, JSON.stringify(doc))
//! expect: 2 1
//! expect: 9 5
//! expect: 7
//! expect: true true false
//! expect: same true
//! expect: counts,batch false true {"counts":{},"batch":7}
