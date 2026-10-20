class ParseFailure extends Error {
  status: number
  constructor(status: number, message: string, name = 'Error') {
    super(message)
    this.name = name
    this.status = status
  }
}

class EntityTooLarge extends ParseFailure {
  constructor(limit: number) {
    super(413, `request entity too large: ${limit}`, 'PayloadTooLargeError')
  }
}

function fail(): never {
  throw new ParseFailure(400, 'bad body', 'SyntaxError')
}

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : `other:${String(err)}`)

let caught: unknown = undefined
try {
  fail()
} catch (err) {
  caught = err
}

//! expect: true true SyntaxError: bad body SyntaxError: bad body
console.log(caught instanceof Error, caught instanceof ParseFailure, describe(caught), String(caught))

const deep: unknown = new EntityTooLarge(1024)
//! expect: true true true PayloadTooLargeError: request entity too large: 1024
console.log(deep instanceof Error, deep instanceof ParseFailure, deep instanceof EntityTooLarge, String(deep))

const plain: unknown = new Error('plain')
const typed: unknown = new TypeError('typed')
const record: unknown = { name: 'Error', message: 'shaped like one' }
//! expect: Error: plain TypeError: typed false other:[object Object]
console.log(describe(plain), describe(typed), record instanceof Error, describe(record))
