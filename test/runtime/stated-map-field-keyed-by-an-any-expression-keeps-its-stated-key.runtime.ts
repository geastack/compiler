// A database client's bulk-write results merger declares `writeErrors: Map<number,
// BulkWriteError>`, allocates it with a bare `new Map()`, and keys it by
// `document.idx + this.currentBatchOffset` over an `any` server document. The
// `any` key states nothing, so the field's own annotation types the Map and
// the call converts the dynamic key into it.
interface Failure {
  code: number
  message: string
}
class Merger {
  offset = 2
  writeErrors: Map<number, Failure>
  constructor() {
    this.writeErrors = new Map()
  }
  merge(documents: any[]): void {
    for (const document of documents) {
      this.writeErrors.set(document.idx + this.offset, { code: document.code, message: document.errmsg })
    }
  }
}
const merger = new Merger()
merger.merge(JSON.parse('[{"idx":0,"code":11000,"errmsg":"dup"},{"idx":3,"code":2,"errmsg":"bad"}]'))
//! expect: 2:11000:dup 5:2:bad
console.log([...merger.writeErrors.entries()].map(([k, v]) => k + ':' + v.code + ':' + v.message).join(' '))
