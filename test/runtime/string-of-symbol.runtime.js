// @ts-nocheck
//! expect: Symbol(x) Symbol(Symbol.iterator) Symbol()
//! expect: a Symbol(b)
//! emitted-lacks: gea::Value
var s = Symbol('x')
var it = Symbol.iterator
var e = Symbol()
console.log(String(s), String(it), String(e))
function describe(k) {
  return String(k)
}
console.log(describe('a'), describe(Symbol('b')))
