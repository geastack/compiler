// A database client's bulk writer: every batch is allocated as `Batch<Document>`, holds
// update statements pushed as documents, and a type predicate re-reads the
// same batch as `Batch<UpdateStatement>`. No `Batch<UpdateStatement>` is ever
// allocated, so the narrowed read is the stored array under another name.
//
// `Batch<Doc>.operations` is an array of Documents (each statement is held as
// a view of its record), while `UpdateOperation.statements` is declared an
// array of records. Two C++ arrays would need a copy between them, and node
// answers the push below through the operation (`2`) -- a copy would print
// `1`, a silent wrong answer (`array-object-call-argument-aliasing`). So the
// layout joins them (`normalize/shared-array-storage.ts`): the narrowed read
// is laid out as the allocated batch's field, and every construction passing
// that array lays `statements` out the same way -- one carrier, one array.
interface Doc {
  [key: string]: any
}
interface UpdateStatement {
  q: Doc
  u: Doc
  multi?: boolean
}

const BatchType = Object.freeze({ INSERT: 1, UPDATE: 2 } as const)
type BatchType = (typeof BatchType)[keyof typeof BatchType]

class Batch<T = Doc> {
  operations: T[] = []
  constructor(readonly batchType: BatchType) {}
}

// The client's own shape: a declared field written from the parameter, a
// subclass filling it with a fresh one-statement array through `super`, and
// the class value handed to a helper that stamps it (`defineAspects`).
class UpdateOperation {
  statements: UpdateStatement[]
  constructor(statements: UpdateStatement[]) {
    this.statements = statements
  }
  get multi(): boolean {
    return this.statements.some((statement) => statement.multi === true)
  }
}

class UpdateOneOperation extends UpdateOperation {
  constructor(q: Doc, u: Doc) {
    super([makeUpdateStatement(q, u, false)])
  }
}

const aspects = new Map<unknown, string[]>()
function defineAspects(operation: { name: string }, names: string[]): void {
  aspects.set(operation, names)
}
defineAspects(UpdateOperation, ['write'])

function isUpdateBatch(batch: Batch): batch is Batch<UpdateStatement> {
  return batch.batchType === BatchType.UPDATE
}

function makeUpdateStatement(q: Doc, u: Doc, multi: boolean): UpdateStatement {
  return { q, u, multi }
}

function main(): void {
  const batches: Batch[] = []
  const update = new Batch(BatchType.UPDATE)
  const statement = makeUpdateStatement({ a: 1 }, { $set: { b: 2 } }, true)
  update.operations.push(statement)
  batches.push(update)
  const insert = new Batch(BatchType.INSERT)
  insert.operations.push({ c: 3 })
  batches.push(insert)

  for (const batch of batches) {
    if (isUpdateBatch(batch)) {
      const multi = batch.operations.some((op) => op.multi)
      const operation = new UpdateOperation(batch.operations)
      // One array under two names: a write through the batch is a read through the operation.
      batch.operations.push(makeUpdateStatement({ z: 0 }, {}, false))
      console.log(multi, operation.multi, operation.statements.length, operation.statements[0] === statement)
      const one = new UpdateOneOperation({ y: 1 }, { $set: { y: 2 } })
      one.statements.push(statement)
      console.log('one', one.multi, one.statements.length, one.statements[1] === statement, aspects.get(UpdateOperation)?.join(','))
    } else {
      console.log('insert', batch.operations.length)
    }
  }
}
main()
//! expect: true true 2 true
//! expect: one true 2 true write
//! expect: insert 1
