// `Object.assign(this, error)` WHERE ONE ARM OF `error` IS A PLAIN `Error`.
//
// A database client's `BulkWriteError` constructor copies the error it wraps onto
// itself. An Error's own `name`, `message` and `stack` are non-enumerable, so
// from a plain Error only the keys added to its own property table are
// copied; one with none copies nothing, and the wrapper keeps its own fields.

class DriverError extends Error {
  code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

class WrappedError extends DriverError {
  label: string
  constructor(error: { message: string; code: number } | DriverError | Error, label: string) {
    super(error.message)
    this.label = label
    Object.assign(this, error)
  }
}

const plain = new Error('plain failure')
const wrappedPlain = new WrappedError(plain, 'a')
//! expect: plain message=plain failure code=undefined label=a keys=code,label
console.log(
  `plain message=${wrappedPlain.message} code=${wrappedPlain.code} label=${wrappedPlain.label} keys=${Object.keys(wrappedPlain).join(',')}`
)

const driver = new DriverError('driver failure', 7)
const wrappedDriver = new WrappedError(driver, 'c')
//! expect: driver message=driver failure code=7 label=c
console.log(`driver message=${wrappedDriver.message} code=${wrappedDriver.code} label=${wrappedDriver.label}`)

const record = new WrappedError({ message: 'record failure', code: 3 }, 'd')
//! expect: record message=record failure code=3 label=d
console.log(`record message=${record.message} code=${record.code} label=${record.label}`)
