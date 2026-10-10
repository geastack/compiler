//! expect: plain:boom
//! expect: response:from-field
//! expect: response:from-expando
//! expect: message:true stack-less-cause:false

// An HTTP framework's default error handler: `err: Error | HTTPResponseError`, where
// `interface HTTPResponseError extends Error { getResponse: () => ... }`, and
// `'getResponse' in err` picks the arm. Both arms are carried as the native
// `Error`, so `in` asks the allocation: its own fields (a compiled subclass's
// field hooks), its dynamic-property sidecar, then its prototype chain.

interface HTTPResponseError extends Error {
  getResponse: () => string
}

class ResponseError extends Error {
  getResponse = (): string => 'from-field'
}

const describe = (err: Error | HTTPResponseError): string => {
  if ('getResponse' in err) return `response:${err.getResponse()}`
  return `plain:${err.message}`
}

console.log(describe(new Error('boom')))
console.log(describe(new ResponseError('ignored')))
const expando = new Error('expando') as HTTPResponseError
expando.getResponse = (): string => 'from-expando'
console.log(describe(expando))
const plain: Error = new Error('x')
console.log(`message:${'message' in plain} stack-less-cause:${'cause' in plain}`)
