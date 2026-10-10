// A database client's `ServerError(message: ErrorDescription)` where
// `interface ErrorDescription extends Document` adds only OPTIONAL keys.
// `BulkWriteError` hands it `{ message; code; writeErrors? } |
// WriteConcernError | AnyError`: a plain record, a class instance or an Error.
// The constructor keeps the very object (`this.errorResponse = message`) and
// copies its enumerable keys onto itself with `for (const name in message)`.
//
// So the slot is the open document itself, holding whichever object it was
// given by identity: a write through the kept reference is seen by the
// caller, and the typed reads of the named keys are checked reads.
interface WireDocument {
  [key: string]: any
}

interface ErrorDescription extends WireDocument {
  message?: string
  errmsg?: string
  errorLabels?: string[]
  errInfo?: WireDocument
}

class WriteConcernError {
  code = 64
  errmsg = 'waiting for replication timed out'
  errInfo: WireDocument = { wtimeout: true }
}

class ServerError {
  errorResponse: ErrorDescription
  copied: WireDocument = {}
  constructor(message: ErrorDescription) {
    this.errorResponse = message
    for (const name in message) {
      if (name !== 'errorLabels' && name !== 'errInfo' && name !== 'message') this.copied[name] = message[name]
    }
  }
  describe(): string {
    const labels = this.errorResponse.errorLabels ?? []
    return `${this.errorResponse.errmsg ?? this.errorResponse.message ?? '-'} labels=${labels.length} copied=${Object.keys(this.copied).join(',')}`
  }
}

function raise(error: { message: string; code: number; writeErrors?: number[] } | WriteConcernError | Error): ServerError {
  return new ServerError(error)
}

const plain = { message: 'bulk failed', code: 65, writeErrors: [1, 2] }
const fromPlain = raise(plain)
console.log(fromPlain.describe(), fromPlain.errorResponse === plain)
fromPlain.errorResponse.errmsg = 'rewritten'
console.log((plain as WireDocument).errmsg)

const concern = new WriteConcernError()
const fromConcern = raise(concern)
console.log(fromConcern.describe(), fromConcern.errorResponse === concern, fromConcern.errorResponse instanceof WriteConcernError)
console.log(fromConcern.errorResponse.errInfo?.wtimeout)

const failure = new Error('socket closed')
const fromError = raise(failure)
console.log(fromError.describe(), fromError.errorResponse === failure)
const literal = new ServerError({ errmsg: 'not primary', code: 10107, errorLabels: ['RetryableWriteError'] })
console.log(literal.describe(), literal.errorResponse.errmsg?.length, literal.errorResponse.errorLabels?.[0])
//! expect: bulk failed labels=0 copied=code,writeErrors true
//! expect: rewritten
//! expect: waiting for replication timed out labels=0 copied=code,errmsg true true
//! expect: true
//! expect: socket closed labels=0 copied= true
//! expect: not primary labels=1 copied=errmsg,code 11 RetryableWriteError
//! emitted-has: gea::dictionary::aliasOf(
