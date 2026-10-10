// A database client's `tryOperation(operation)` over bulk writes' `UpdateOperation |
// DeleteOperation` union (`runBatch` here): `operation.handleOk(reply)` reads
// a method off each class arm. `AbstractOperation<TResult>.handleOk` is one body per class copy
// -- `void` for `AbstractOperation<void>`, a document for `Command<Document>`
// -- and `DeleteOperation` inherits it while `DeleteOneOperation` overrides
// it. Each arm must materialize the copy the read publishes (the document
// one), not the class's first same-key copy (the `void` one).
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
}

class KillOperation extends AbstractOperation<void> {
  get commandName(): string {
    return 'kill'
  }
}

class DropOperation extends AbstractOperation<void> {
  get commandName(): string {
    return 'drop'
  }
  override handleOk(_response: Reply): void {
    // nothing to report
  }
}

abstract class CommandOperation<T> extends AbstractOperation<T> {}

class CountOperation extends CommandOperation<number> {
  get commandName(): string {
    return 'count'
  }
  override handleOk(response: Reply): number {
    return response.toObject().n ?? 0
  }
}

class InsertOperation extends CommandOperation<Doc> {
  get commandName(): string {
    return 'insert'
  }
  override handleOk(response: Reply): Doc {
    const res = super.handleOk(response)
    return { inserted: res.n }
  }
}

class UpdateOperation extends CommandOperation<Doc> {
  get commandName(): string {
    return 'update'
  }
}

class DeleteOperation extends CommandOperation<Doc> {
  get commandName(): string {
    return 'delete'
  }
}

class DeleteOneOperation extends DeleteOperation {
  override handleOk(response: Reply): Doc {
    const res = super.handleOk(response)
    return { acknowledged: true, deletedCount: res.n }
  }
}

// Each operation class is run once on its own, so every copy of the base's
// `handleOk` exists: the `void` one (Kill), the `number` one, the document one.
const reply = new Reply({ n: 3, ok: 1 })
new KillOperation().handleOk(reply)
//! expect: undefined 3 {"inserted":3} {"acknowledged":true,"deletedCount":3}
console.log(
  new DropOperation().handleOk(reply),
  new CountOperation().handleOk(reply),
  JSON.stringify(new InsertOperation().handleOk(reply)),
  JSON.stringify(new DeleteOneOperation().handleOk(reply))
)

// The bulk writer's batch operation: one of two classes, neither of which
// overrides `handleOk` itself, one of which has a subclass that does.
function runBatch(operation: UpdateOperation | DeleteOperation): Doc {
  return operation.handleOk(reply)
}
//! expect: update {"n":3,"ok":1}
//! expect: delete {"n":3,"ok":1}
//! expect: delete {"acknowledged":true,"deletedCount":3}
for (const kind of ['update', 'delete', 'deleteOne']) {
  const operation = kind === 'update' ? new UpdateOperation() : kind === 'delete' ? new DeleteOperation() : new DeleteOneOperation()
  console.log(operation.commandName, JSON.stringify(runBatch(operation)))
}
