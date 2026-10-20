class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
  toString(): string {
    return `HttpError(${this.status}): ${this.message}`
  }
}

class NotFound extends HttpError {
  constructor(path: string) {
    super(404, `no route for ${path}`)
  }
}

class PlainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlainError'
  }
}

const overriding: unknown = new HttpError(500, 'boom')
const inherited: unknown = new NotFound('/missing')
const plain: unknown = new PlainError('plain')

//! expect: HttpError(500): boom HttpError(500): boom
console.log(String(overriding), `${overriding}`)
//! expect: HttpError(404): no route for /missing
console.log(String(inherited))
//! expect: PlainError: plain
console.log(String(plain))

let caught: unknown = undefined
try {
  throw overriding
} catch (err) {
  caught = err
}
//! expect: true caught HttpError(500): boom
console.log(caught instanceof HttpError, 'caught', String(caught))
