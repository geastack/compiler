// A class extending `Error`, stored where the slot is typed `Error`: the
// database client returns its `ServiceError` subclasses from functions declared
// `: Error` and passes them as an options bag's `cause`. The instance IS an
// Error -- the store is an upcast, and the subclass's identity, message and
// own fields survive it.
class ServiceError extends Error {
  code: number
  constructor(message: string, code: number) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

class NetworkError extends ServiceError {
  constructor(message: string) {
    super(message, 6)
    this.name = 'NetworkError'
  }
}

function classify(error: Error): Error {
  if (!(error instanceof ServiceError)) return error
  return error.code > 5 ? new ServiceError(`wrapped ${error.message}`, 1) : error
}

interface Options {
  cause?: Error
}

const plain = new Error('boom')
const network = new NetworkError('socket closed')
const options: Options = { cause: network }
const classified = classify(network)
console.log(classify(plain) === plain, classified.message, classified instanceof ServiceError, classified.name)
console.log(options.cause === network, options.cause instanceof NetworkError, options.cause?.message)
//! expect: true wrapped socket closed true ServiceError
//! expect: true true socket closed
