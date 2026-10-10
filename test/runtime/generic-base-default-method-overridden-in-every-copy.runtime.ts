// A database client's abstract `Operation<TResult>` base has a default
// `handleOk` that returns the server's reply document `as TResult`:
//
//   handleOk(response: ServerResponse): TResult {
//     return response.toObject(this.wireOptions) as TResult
//   }
//
// Every operation whose TResult is not a document (`CountOperation`'s
// `number`, `CreateIndexesOperation`'s `string[]`, ...) overrides it, and only
// the document-typed ones call `super.handleOk`. So the copies of the default
// at `number` and `string[]` never run -- and in them `as TResult` would put a
// dictionary where a number is declared, which has no native conversion. The
// copies at the document type do run (inherited, and through `super`).
class Reply {
  toObject(): Record<string, any> {
    return { n: 3, ok: 1 }
  }
}

abstract class Operation<TResult> {
  handleOk(response: Reply): TResult {
    return response.toObject() as TResult
  }
}

abstract class CommandOperation<T> extends Operation<T> {
  abstract commandName(): string
}

class CountOperation extends CommandOperation<number> {
  commandName(): string {
    return 'count'
  }
  override handleOk(response: Reply): number {
    return response.toObject().n ?? 0
  }
}

class KeysOperation extends CommandOperation<string[]> {
  commandName(): string {
    return 'keys'
  }
  override handleOk(response: Reply): string[] {
    return Object.keys(response.toObject())
  }
}

class RawOperation extends CommandOperation<Record<string, any>> {
  commandName(): string {
    return 'raw'
  }
}

class WrappedOperation extends CommandOperation<Record<string, any>> {
  commandName(): string {
    return 'wrapped'
  }
  override handleOk(response: Reply): Record<string, any> {
    const result = super.handleOk(response)
    result['wrapped'] = true
    return result
  }
}

const reply = new Reply()
//! expect: 3 n,ok {"n":3,"ok":1} {"n":3,"ok":1,"wrapped":true}
console.log(
  new CountOperation().handleOk(reply) +
    ' ' +
    new KeysOperation().handleOk(reply).join(',') +
    ' ' +
    JSON.stringify(new RawOperation().handleOk(reply)) +
    ' ' +
    JSON.stringify(new WrappedOperation().handleOk(reply))
)
