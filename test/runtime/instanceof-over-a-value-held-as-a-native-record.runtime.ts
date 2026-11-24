interface Options {
  expires?: Date
  pattern?: RegExp
}

function expiry(options: Options): string {
  const expires = options.expires
  if (expires === undefined) return 'none'
  if (!(expires instanceof Date) || isNaN(expires.valueOf())) return 'invalid'
  return expires.toUTCString()
}

function matcher(options: Options): string {
  const pattern = options.pattern
  if (pattern === undefined) return 'none'
  if (!(pattern instanceof RegExp)) return 'not a pattern'
  return pattern.source
}

function isDate(value: Date): boolean {
  return value instanceof Date
}

function isRegExp(value: RegExp): boolean {
  return value instanceof RegExp
}

console.log(expiry({ expires: new Date(0) }))
console.log(expiry({ expires: new Date(NaN) }))
console.log(expiry({}))
console.log(isDate(new Date(5)))
console.log(matcher({ pattern: /a+b/ }))
console.log(matcher({}))
console.log(isRegExp(new RegExp('x', 'g')))
//! expect: Thu, 01 Jan 1970 00:00:00 GMT
//! expect: invalid
//! expect: none
//! expect: true
//! expect: a+b
//! expect: none
//! expect: true
export {}
