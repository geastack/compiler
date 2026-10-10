// A CLASS EXTENDING `Error`, HANDED TO AN `Error | null | undefined` SLOT.
//
// A database client calls every `(err?: AnyError)` callback, and `onError(error)`, with
// its own `NetworkError`/`ServiceRuntimeError` subclasses. A bare `Error`
// slot already takes the pointer upcast (`nativeRecordBaseTransportKind`), but
// the union had no home for the class: the pair fell through to the boxed
// assertion, which boxed `Ref<DriverError>` and aborted on every call with "a
// dynamic value admitted by no union arm". The `Error` arm is that same
// upcast, and the instance keeps its identity: `instanceof` and the subclass
// field read back through it.

class DriverError extends Error {
  code = 7
}

class NetworkError extends DriverError {}

function describe(error?: Error | null): string {
  if (error === undefined) return 'none'
  if (error === null) return 'null'
  return `${error.name}:${error.message}:${error instanceof DriverError ? error.code : '-'}:${error instanceof NetworkError}`
}

const lost = new NetworkError('lost')
const kept: (Error | null)[] = [lost]
console.log(describe(new DriverError('boom')))
console.log(describe(lost))
console.log(describe(null))
console.log(describe())
console.log(kept[0] === lost)
//! expect: Error:boom:7:false
//! expect: Error:lost:7:true
//! expect: null
//! expect: none
//! expect: true
