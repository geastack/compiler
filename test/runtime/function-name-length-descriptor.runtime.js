// @ts-nocheck
// A user function's own `name` and `length` (ECMA-262 10.2.9 SetFunctionName,
// 10.2.10 SetFunctionLength) read directly and through
// `Object.getOwnPropertyDescriptor`, the shape test262's `verifyProperty`
// checks on every `fn-name-*` and `length` case.
function f(x, y) {}
var g = function (a) {}
var h = () => {}
console.log(f.name, f.length, g.name, g.length, h.name, h.length)
//! expect: f 2 g 1 h 0
var fd = Object.getOwnPropertyDescriptor(f, 'name')
var fl = Object.getOwnPropertyDescriptor(f, 'length')
console.log(fd.value, fd.writable, fd.enumerable, fd.configurable, fl.value, fl.writable, fl.configurable)
//! expect: f false false true 2 false true
// A function reflected on but never read directly: the descriptor must
// answer from the function's own declaration, not from a metadata slot only
// a direct `.name` read happens to populate.
function k(p, q, r) {}
var kd = Object.getOwnPropertyDescriptor(k, 'name')
var kl = Object.getOwnPropertyDescriptor(k, 'length')
console.log(kd.value, kl.value)
//! expect: k 3
