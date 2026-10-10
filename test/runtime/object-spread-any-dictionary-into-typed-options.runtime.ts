// A database client's bulk builder keeps the pending operation as a
// `Document` and spreads it into the options of the statement it makes:
// `makeDeleteStatement(currentOp.selector, { ...currentOp, limit: 1 })`, whose
// parameter names only the keys it reads. Each run-time key the options type
// names lands in that field through a checked unbox; the explicit key written
// after the spread wins.
interface WireDocument {
  [key: string]: any
}

interface DeleteOptions {
  hint?: string
  comment?: string
  limit?: number
}

function current(): WireDocument {
  return { selector: { a: 1 }, hint: 'a_1', limit: 7 }
}

function makeDeleteStatement(filter: WireDocument, options: DeleteOptions): string {
  return `${Object.keys(filter).join('')}:${options.hint ?? '-'}:${options.comment ?? '-'}:${options.limit ?? '-'}`
}

const currentOp = current()
console.log(makeDeleteStatement(currentOp.selector, { ...currentOp, limit: 1 }))
console.log(makeDeleteStatement(currentOp.selector, { limit: 0, ...currentOp }))
//! expect: a:a_1:-:1
//! expect: a:a_1:-:7
