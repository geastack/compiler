// `x instanceof Error` WHERE ONE ARM OF `x` IS A CLASS EXTENDING Error.
//
// A database client's `BulkWriteError` constructor takes
// `{ message; code } | WriteConcernError | AnyError` (`AnyError = ServiceError |
// Error`) and asks `!(error instanceof Error)`. The `ServiceError` arm is a
// class whose chain links the native Error, so its instance IS an Error
// allocation: the answer is read from that native base, not settled `false`.

class DriverError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

class TimeoutError extends DriverError {}

class ConcernError {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

type Failure = { message: string; code: number } | ConcernError | DriverError | TimeoutError | Error

const describe = (error: Failure): string => {
  if (error instanceof ConcernError) return `concern:${error.message}`
  if (!(error instanceof Error)) return `plain:${error.message}:${error.code}`
  return `error:${error.message}`
}

//! expect: plain:p:1 concern:c error:d error:t error:e
console.log(
  describe({ message: 'p', code: 1 }),
  describe(new ConcernError('c')),
  describe(new DriverError('d', 2)),
  describe(new TimeoutError('t', 3)),
  describe(new Error('e'))
)
