// A class instance handed where a database client's `Document` (`{ [key:
// string]: any }`) is declared: `ClientBulkWriteResultsMerger.merge` passes a
// `ClientBulkWriteCursorResponse` to `incrementCounts(document: Document)`,
// which reads `document.insertedCount` -- a PROTOTYPE getter, not an own
// field.
//
// The document is a live view of the instance (`gea::dictionary::aliasOf`),
// so the read runs the getter. A table copied from the instance's own
// enumerable fields -- what a record gets on its way into `Document` -- would
// read `insertedCount` as undefined and add `NaN`.
interface WireDocument {
  [key: string]: any
}

class CursorResponse {
  private fields: Map<string, number> = new Map([['nInserted', 2]])
  get insertedCount(): number {
    return this.fields.get('nInserted') ?? 0
  }
}

class Merger {
  total = 0
  incrementCounts(document: WireDocument): void {
    this.total += document.insertedCount
  }
}

const merger = new Merger()
merger.incrementCounts(new CursorResponse())
console.log('total', merger.total)
//! expect: total 2
