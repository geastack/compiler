// A database client's `executeOperation`/`tryOperation`:
// `async function tryOperation<T extends AbstractOperation, TResult =
// ResultTypeFromOperation<T>>(operation: T): Promise<TResult>` ends in
// `return operation.handleOk(result)`. The receiver is typed by the type
// parameter `T`, constrained to the generic base `AbstractOperation` whose own
// `TResult` defaults to `any`. Each copy of the function is instantiated at one
// concrete operation class, so the call's result is that class's `handleOk`
// result -- never the base's unfilled `TResult`, and never `void` (a `void`
// result proves the copy's `return` unreachable for every non-void class).
type Doc = { [key: string]: any }

class Reply {
  constructor(readonly fields: Doc) {}
  toObject(): Doc {
    return this.fields
  }
}

abstract class AbstractOperation<TResult = any> {
  abstract get commandName(): string
  handleOk(response: Reply): TResult {
    return response.toObject() as TResult
  }
  handleError(error: Error): TResult | never {
    throw error
  }
}

type ResultTypeFromOperation<TOperation extends AbstractOperation> = ReturnType<TOperation['handleOk']>

class KillCursorsOperation extends AbstractOperation<void> {
  get commandName(): string {
    return 'killCursors'
  }
}

class EndSessionsOperation extends AbstractOperation<void> {
  get commandName(): string {
    return 'endSessions'
  }
  override handleOk(_response: Reply): void {}
}

class RunCommandOperation<T = Doc> extends AbstractOperation<T> {
  get commandName(): string {
    return 'runCommand'
  }
}

class CountOperation extends AbstractOperation<number> {
  get commandName(): string {
    return 'count'
  }
  override handleOk(response: Reply): number {
    return response.toObject().n ?? 0
  }
}

class UpdateOperation extends AbstractOperation<Doc> {
  get commandName(): string {
    return 'update'
  }
}

class InsertOperation extends AbstractOperation<{ insertedId: number }> {
  get commandName(): string {
    return 'insert'
  }
  override handleOk(response: Reply): { insertedId: number } {
    return { insertedId: response.toObject().n }
  }
}

abstract class CommandOperation<T> extends AbstractOperation<T> {}

class DeleteOperation extends CommandOperation<Doc> {
  get commandName(): string {
    return 'delete'
  }
}

type DeleteResult = { acknowledged: boolean; deletedCount: number }

class DeleteOneOperation extends DeleteOperation {
  override handleOk(response: Reply): DeleteResult {
    const res = super.handleOk(response)
    return { acknowledged: true, deletedCount: res.n }
  }
}

const reply = new Reply({ n: 3, ok: 1 })

async function tryOperation<T extends AbstractOperation, TResult = ResultTypeFromOperation<T>>(operation: T): Promise<TResult> {
  for (let tries = 0; tries < 2; tries++) {
    try {
      try {
        const result = await Promise.resolve(reply)
        return operation.handleOk(result)
      } catch (error) {
        return operation.handleError(error as Error)
      }
    } catch (operationError) {
      if (tries > 0) throw operationError
    }
  }
  throw new Error('no result')
}

async function executeOperation<T extends AbstractOperation, TResult = ResultTypeFromOperation<T>>(operation: T): Promise<TResult> {
  try {
    return await tryOperation(operation)
  } finally {
    console.log('ran', operation.commandName)
  }
}

// The reproduction's bare form: the declared result is `ReturnType` directly.
async function run<T extends AbstractOperation>(operation: T): Promise<ReturnType<T['handleOk']>> {
  return operation.handleOk(reply)
}

async function main(): Promise<void> {
  //! expect: ran killCursors
  await executeOperation(new KillCursorsOperation())
  //! expect: ran endSessions
  //! expect: undefined
  console.log(await executeOperation(new EndSessionsOperation()))
  //! expect: ran runCommand
  await executeOperation(new RunCommandOperation())
  //! expect: ran runCommand
  //! expect: {"n":3,"ok":1}
  console.log(JSON.stringify(await executeOperation(new RunCommandOperation())))
  //! expect: ran count
  //! expect: 3
  console.log(await executeOperation(new CountOperation()))
  //! expect: ran update
  //! expect: {"n":3,"ok":1}
  console.log(JSON.stringify(await executeOperation(new UpdateOperation())))
  //! expect: ran insert
  //! expect: {"insertedId":3}
  console.log(JSON.stringify(await executeOperation(new InsertOperation())))
  //! expect: ran delete
  //! expect: {"acknowledged":true,"deletedCount":3}
  console.log(JSON.stringify(await executeOperation(new DeleteOneOperation())))
  //! expect: 3 {"insertedId":3} {"acknowledged":true,"deletedCount":3} undefined
  console.log(
    await run(new CountOperation()),
    JSON.stringify(await run(new InsertOperation())),
    JSON.stringify(await run(new DeleteOneOperation())),
    await run(new EndSessionsOperation())
  )
}

main()
