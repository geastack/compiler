// A batch holds its operations as plain documents; a type guard on the batch
// narrows them to update statements, and a callback reads each one through
// the statement interface. The elements are the same document objects.

export {}

type Document = { [key: string]: any }

type SortDirectionForCmd = 1 | -1 | { $meta: string }
type SortForCmd = Map<string, SortDirectionForCmd>
type Hint = string | Document

interface CollationOptions {
  locale: string
  strength?: number
}

interface UpdateStatement {
  q: Document
  u: Document | Document[]
  upsert?: boolean
  multi?: boolean
  collation?: CollationOptions
  arrayFilters?: Document[]
  hint?: Hint
  sort?: SortForCmd
}

const BatchType = { INSERT: 1, UPDATE: 2, DELETE: 3 } as const
type BatchType = (typeof BatchType)[keyof typeof BatchType]

class Batch<T = Document> {
  originalIndexes: number[] = []
  operations: T[] = []
  constructor(readonly batchType: BatchType) {}
}

function isUpdateBatch(batch: Batch): batch is Batch<UpdateStatement> {
  return batch.batchType === BatchType.UPDATE
}

class UpdateOperation {
  statements: UpdateStatement[]
  constructor(statements: UpdateStatement[]) {
    this.statements = statements
  }
  get canRetryWrite(): boolean {
    return this.statements.every((op) => op.multi == null || op.multi === false)
  }
}

function retryable(batch: Batch): boolean {
  if (isUpdateBatch(batch)) {
    const operation = new UpdateOperation(batch.operations)
    return !batch.operations.some((op) => op.multi) && operation.canRetryWrite
  }
  return true
}

const single = new Batch(BatchType.UPDATE)
single.operations.push({ q: { a: 1 }, u: { $set: { b: 2 } } })
const multi = new Batch(BatchType.UPDATE)
multi.operations.push({ q: {}, u: [{ $set: { c: 1 } }], multi: true, hint: 'idx' })
const inserts = new Batch(BatchType.INSERT)
inserts.operations.push({ name: 'x' })
console.log(retryable(single), retryable(multi), retryable(inserts))

//! expect: true false true
