//! expect: plain: 2 deletes, first limit 1
//! expect: hinted: hint for the delete command is only supported on server 4.4+
//! expect: batch: hint for the delete command is only supported on server 4.4+
//! expect: found: {"q":{"b":2},"limit":0,"hint":"b_1"}

// A database client's delete operation: `this.statements.find((o: Document) =>
// o.hint)`, where `statements` is `DeleteStatement[]` and the callback names
// its parameter `Document`. The element is read as the open document, so
// `find` answers `Document | undefined`, and the call's result is the typed
// `DeleteStatement | undefined` again: a checked adoption of the document as
// the named record, lifted through the optional. Its bulk writer also builds
// the operation from a `Batch<T = Document>` narrowed by a `batch is
// Batch<DeleteStatement>` guard, so the field is carried as an Array of
// documents.

interface Document {
  [key: string]: any
}

interface DeleteStatement {
  q: Document
  limit: number
  hint?: string | Document
}

class DeleteOperation {
  statements: DeleteStatement[]
  constructor(statements: DeleteStatement[]) {
    this.statements = statements
  }

  buildCommandDocument(): Document {
    const command: Document = { delete: 'todos', deletes: this.statements, ordered: true }
    if (this.statements.find((o: Document) => o.hint)) {
      throw new Error('hint for the delete command is only supported on server 4.4+')
    }
    return command
  }

  firstHinted(): DeleteStatement | undefined {
    return this.statements.find((o: Document) => o.hint)
  }
}

class Batch<T = Document> {
  batchType: number
  operations: T[]
  constructor(batchType: number) {
    this.batchType = batchType
    this.operations = []
  }
}

function isDeleteBatch(batch: Batch): batch is Batch<DeleteStatement> {
  return batch.batchType === 3
}

const batch = new Batch(3)
batch.operations.push({ q: { c: 3 }, limit: 1, hint: { c: 1 } })
try {
  if (isDeleteBatch(batch)) new DeleteOperation(batch.operations).buildCommandDocument()
  console.log('batch: unexpected')
} catch (error) {
  console.log('batch: ' + (error as Error).message)
}

const plain = new DeleteOperation([
  { q: { a: 1 }, limit: 1 },
  { q: { b: 2 }, limit: 0 }
])
const built = plain.buildCommandDocument()
console.log('plain: ' + built.deletes.length + ' deletes, first limit ' + built.deletes[0].limit)

const hinted = new DeleteOperation([
  { q: { a: 1 }, limit: 1 },
  { q: { b: 2 }, limit: 0, hint: 'b_1' }
])
try {
  hinted.buildCommandDocument()
  console.log('hinted: unexpected')
} catch (error) {
  console.log('hinted: ' + (error as Error).message)
}
const found = hinted.firstHinted()
console.log('found: ' + (found === undefined ? 'none' : JSON.stringify(found)))

export {}
