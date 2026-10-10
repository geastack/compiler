// A generic's type parameter the checker infers as `any` only because the one
// argument that binds it was erased with `as any` (a database client's
// `executeOperation(client, new InsertOneOperation(...) as TODO_NODE_3286)`).
// The assertion is erased at runtime, so the copy receives the operation class
// itself and must take it natively rather than boxed.
//! expect: insert:2 -> ok(2)
//! expect: find:alpha -> ok(alpha)
//! emitted-lacks: gea::Value::box
//! emitted-lacks: (gea::Value)>

type TODO = any

abstract class Operation {
  abstract describe(): string
  handle(result: string): string {
    return `ok(${result})`
  }
}

class InsertOperation extends Operation {
  constructor(readonly count: number) {
    super()
  }
  describe(): string {
    return `insert:${this.count}`
  }
}

class FindOperation extends Operation {
  constructor(readonly filter: string) {
    super()
  }
  describe(): string {
    return `find:${this.filter}`
  }
}

function execute<T extends Operation, TResult = string>(operation: T): TResult {
  const label = operation.describe()
  const payload = label.slice(label.indexOf(':') + 1)
  return `${label} -> ${operation.handle(payload)}` as TResult
}

function insert(count: number): string {
  return execute(new InsertOperation(count) as TODO)
}

function find(filter: string): string {
  return execute<FindOperation, string>(new FindOperation(filter))
}

console.log(insert(2))
console.log(find('alpha'))
