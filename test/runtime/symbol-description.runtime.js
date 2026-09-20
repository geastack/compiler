// @ts-nocheck
//! expect: x [y] [Symbol.iterator] [undefined]
//! expect: true false
function f(name) {
  if (typeof name === 'symbol') return '[' + name.description + ']'
  return name
}
console.log(f('x'), f(Symbol('y')), f(Symbol.iterator), f(Symbol()))
var s = Symbol('z')
console.log(s.description === 'z', Symbol().description !== undefined)
