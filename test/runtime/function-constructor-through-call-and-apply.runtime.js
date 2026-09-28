// @ts-nocheck
//! dynamic-fallback
//! expect: 5 hi:x 3
// `Function.apply(thisArg, list)` and `Function.call(thisArg, ...sources)` are
// `Function(...sources)`: fast-json-stringify's `restore` rebuilds a
// serializer with `Function.apply(null, ['validator', 'serializer', code])`.
const add = Function.apply(null, ['a', 'b', 'return a + b'])
const greet = Function.call(null, 'name', "return 'hi:' + name")
function restore ({ code, validator }) {
  return Function.apply(null, ['validator', code]).apply(null, [validator])
}
console.log(add(2, 3), greet('x'), restore({ code: 'return validator.length', validator: [1, 2, 3] }))
