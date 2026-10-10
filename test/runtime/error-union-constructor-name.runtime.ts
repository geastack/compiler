// `x.constructor.name` over `CompiledError | Error` (a database client's
// `errorStrictEqual`): the constructor a value's prototype chain names, per
// ECMA-262 -- the class's own name for a compiled subclass (and its
// subclasses), the intrinsic constructor's name for a native error.

class ServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceError'
  }
}
class NetworkError extends ServiceError {}
class ServerError extends ServiceError {
  code = 11000
}

type AnyError = ServiceError | Error

function constructorNameOf(error: AnyError): string {
  return error.constructor.name
}

// A bare `Error` slot can hold a compiled subclass too: the name is still the allocating class's.
function plainConstructorNameOf(error: Error): string {
  return error.constructor.name
}

function errorStrictEqual(lhs?: AnyError | null, rhs?: AnyError | null): boolean {
  if (lhs === rhs) return true
  if (!lhs || !rhs) return lhs === rhs
  if (lhs.constructor.name !== rhs.constructor.name) return false
  return lhs.message === rhs.message
}

const errors: AnyError[] = [
  new ServiceError('a'),
  new NetworkError('b'),
  new ServerError('c'),
  new Error('d'),
  new TypeError('e'),
  new RangeError('f')
]
console.log(errors.map(constructorNameOf).join(' '))
console.log([new ServerError('p'), new SyntaxError('q'), new Error('r')].map(plainConstructorNameOf).join(' '))
console.log(
  errorStrictEqual(new ServiceError('x'), new ServiceError('x')),
  errorStrictEqual(new ServiceError('x'), new NetworkError('x')),
  errorStrictEqual(new ServiceError('x'), new Error('x')),
  errorStrictEqual(new TypeError('x'), new TypeError('x')),
  errorStrictEqual(new TypeError('x'), new RangeError('x')),
  errorStrictEqual(null, undefined),
  errorStrictEqual(new ServerError('x'), new ServerError('y'))
)

//! expect: ServiceError NetworkError ServerError Error TypeError RangeError
//! expect: ServerError SyntaxError Error
//! expect: true false false true false false false
