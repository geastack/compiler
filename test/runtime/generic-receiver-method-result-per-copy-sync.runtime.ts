// The synchronous form of a database client's `tryOperation`: a function generic over
// `T extends AbstractOperation` declares its result as the conditional
// `ReturnType<T['handleOk']>` and returns `operation.handleOk(reply)`. Each
// copy is instantiated at one concrete operation class, so both the declared
// result and the call's result resolve to that class's `handleOk` result --
// not to an unresolved conditional, not to the base's unfilled `TResult`.
// `handleOk` takes the client's polymorphic-`this` parameter
// (`InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>`), so the member's
// signature is instantiated at the receiver as well.
type Doc = { [key: string]: any }

class Reply {
  constructor(readonly fields: Doc) {}
  toObject(): Doc {
    return this.fields
  }
}

abstract class AbstractOperation<TResult = any> {
  abstract get commandName(): string
  SERVER_COMMAND_RESPONSE_TYPE = Reply
  abstract handleOk(response: InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>): TResult
}

type ResultTypeFromOperation<TOperation extends AbstractOperation> = ReturnType<TOperation['handleOk']>

class RunCommandOperation extends AbstractOperation<void> {
  get commandName(): string {
    return 'runCommand'
  }
  override handleOk(_response: InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>): void {}
}

class CountOperation extends AbstractOperation<number> {
  get commandName(): string {
    return 'count'
  }
  override handleOk(response: InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>): number {
    return response.toObject().n ?? 0
  }
}

class UpdateOperation extends AbstractOperation<Doc> {
  get commandName(): string {
    return 'update'
  }
  override handleOk(response: InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>): Doc {
    return response.toObject()
  }
}

class InsertOperation extends AbstractOperation<{ insertedId: number }> {
  get commandName(): string {
    return 'insert'
  }
  override handleOk(response: InstanceType<typeof this.SERVER_COMMAND_RESPONSE_TYPE>): { insertedId: number } {
    return { insertedId: response.toObject().n }
  }
}

const reply = new Reply({ n: 3, ok: 1 })

function tryOperation<T extends AbstractOperation, TResult = ResultTypeFromOperation<T>>(operation: T): TResult {
  return operation.handleOk(reply)
}

function run<T extends AbstractOperation>(operation: T): ReturnType<T['handleOk']> {
  return operation.handleOk(reply)
}

//! expect: 3 {"n":3,"ok":1} {"insertedId":3} undefined
console.log(
  tryOperation(new CountOperation()),
  JSON.stringify(tryOperation(new UpdateOperation())),
  JSON.stringify(tryOperation(new InsertOperation())),
  tryOperation(new RunCommandOperation())
)
//! expect: 3 {"n":3,"ok":1} {"insertedId":3} undefined
console.log(
  run(new CountOperation()),
  JSON.stringify(run(new UpdateOperation())),
  JSON.stringify(run(new InsertOperation())),
  run(new RunCommandOperation())
)
