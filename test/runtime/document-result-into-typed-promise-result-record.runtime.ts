// A database client's `collection.insertOne` runs `executeOperation(client, new
// InsertOneOperation(...) as any)` typed `Promise<InsertOneResult>`, and
// `tryOperation` returns `operation.handleOk(result)` -- whose override
// returns a `Document` literal `{ acknowledged, insertedId }`. The document
// settles the typed promise as the result record, as in JS.
type Document = { [key: string]: any }

interface InsertResult {
  acknowledged: boolean
  insertedId: number
}

abstract class AbstractOperation<TResult = any> {
  handleOk(response: Document): TResult {
    return response as TResult
  }
}

class InsertOperation extends AbstractOperation<Document> {
  constructor(readonly id: number) {
    super()
  }
  override handleOk(response: Document): Document {
    return { acknowledged: response.ok === 1, insertedId: this.id }
  }
}

type ResultOf<T extends AbstractOperation> = ReturnType<T['handleOk']>

async function tryOperation<T extends AbstractOperation, TResult = ResultOf<T>>(operation: T): Promise<TResult> {
  return operation.handleOk({ ok: 1, n: 1 })
}

async function executeOperation<T extends AbstractOperation, TResult = ResultOf<T>>(operation: T): Promise<TResult> {
  if (!(operation instanceof AbstractOperation)) throw new TypeError('not an operation')
  return await tryOperation(operation)
}

async function insertOne(id: number): Promise<InsertResult> {
  return await executeOperation(new InsertOperation(id) as any)
}

const result = await insertOne(7)
console.log(result.acknowledged, result.insertedId, Object.keys(result).sort().join(','))

//! expect: true 7 acknowledged,insertedId

// The same settlement from an `any` the body returns directly.
const settle = async (value: any): Promise<InsertResult> => value
const documentValue: Document = { acknowledged: false, insertedId: 9 }
const settled = await settle(documentValue)
console.log(settled.acknowledged, settled.insertedId)

//! expect: false 9
