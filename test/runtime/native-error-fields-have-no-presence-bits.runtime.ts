//! expect: name:NodeNotImplementedError code:ERR_X
//! expect: stack:at main
//! expect: cause:boom
//! expect: frozen:true

// node-compat's `nodeNotImplemented` writes `error.name` on a plain `new
// Error(...)`, and a database client's server description reads `this.error?.stack`
// through a `class ServiceError extends Error`. Both members belong to the
// native `gea::runtime::Error`, which has no presence bit or attribute triple
// for them -- only `cause` carries one -- so neither the store's
// writability guard nor the read's presence test may name generated-struct
// members. The program freezes an object, which is what arms those guards.

interface NotImplementedError extends Error {
  code: string
}

function notImplemented(member: string): NotImplementedError {
  const error = new Error('ERR_X: ' + member) as NotImplementedError
  error.name = 'NodeNotImplementedError'
  error.code = 'ERR_X'
  return error
}

class ServiceError extends Error {
  code?: number
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

class Description {
  error: ServiceError | null
  constructor(error: ServiceError | null) {
    this.error = error
  }
  stackText(): string {
    const stack = this.error?.stack
    return typeof stack === 'string' ? stack : 'none'
  }
}

const settings = Object.freeze({ strict: true })
const failure = notImplemented('fs.watch')
console.log('name:' + failure.name + ' code:' + failure.code)
const described = new Description(new ServiceError('down', { cause: 'boom' }))
// The runtime captures no stack trace, so the program writes the one it reads.
described.error!.stack = 'at main'
console.log('stack:' + described.stackText())
console.log('cause:' + String(described.error?.cause))
console.log('frozen:' + Object.isFrozen(settings))
