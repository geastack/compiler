// The refusal of JSON.stringify over a changed Date.prototype.toJSON asks for
// that one key: a program that defines another key on Date.prototype still
// writes its Dates through 21.4.4.37.
export {}

Object.defineProperty(Date.prototype, 'foo', { value: 1 })
//! expect: {"d":"1970-01-01T00:00:00.000Z"}
console.log(JSON.stringify({ d: new Date(0) } as any))
