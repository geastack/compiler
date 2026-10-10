// A record erased into `any` still inherits Object.prototype.toString
// (ECMA-262 20.1.3.6): a database client's `prepareDirection` stringifies whatever
// direction it was handed with `${direction}` before testing it, and a
// `{ $meta }` record there must read "[object Object]", not throw.
class Plain {
  x = 1
}
const stringify = (value: any): string => `${value}`
console.log(stringify({ $meta: 'textScore' }))
console.log(stringify(new Plain()))
console.log(stringify(['a', -1] as const))

//! expect: [object Object]
//! expect: [object Object]
//! expect: a,-1
