// A database client names its errors with constant getters rather than by
// assigning `this.name`: `override get name(): string { return 'ServiceError' }`
// on the root and again on every subclass. Held where the slot is typed
// `Error`, the instance is read through the intrinsic Error layout, so the
// name that layout stores must be the most-derived getter's answer.
class ServiceError extends Error {
  constructor(message: string) {
    super(message)
  }
  override get name(): string {
    return 'ServiceError'
  }
}

class NetworkError extends ServiceError {
  override get name(): string {
    return 'NetworkError'
  }
}

class NetworkTimeoutError extends NetworkError {}

function describe(error: Error): string {
  return `${error.name}:${error.message}`
}

const errors: Error[] = [new ServiceError('a'), new NetworkError('b'), new NetworkTimeoutError('c'), new Error('d')]
console.log(errors.map(describe).join(' '))
const timeout = new NetworkTimeoutError('e')
console.log(timeout.name, String(timeout), timeout instanceof NetworkError)
//! expect: ServiceError:a NetworkError:b NetworkError:c Error:d
//! expect: NetworkError NetworkError: e true
