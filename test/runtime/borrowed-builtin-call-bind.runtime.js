// @ts-nocheck
// test262's harness/propertyHelper.js opens by borrowing builtin methods
// through `Function.prototype.call.bind`, so calling e.g. `__push(xs, v)`
// mutates `xs` exactly as `xs.push(v)` would. `Function.prototype.call.bind`
// applied to a builtin `X.prototype.m` is a compile-time known fact -- no
// runtime function object is needed, so the borrowed call lowers per call
// site to the ordinary member call on the receiver's own native carrier.
var __join = Function.prototype.call.bind(Array.prototype.join)
var __push = Function.prototype.call.bind(Array.prototype.push)
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable)
var failures = []
__push(failures, 'a')
__push(failures, 'b')
console.log(__join(failures, '; '), __hasOwnProperty({ a: 1 }, 'a'), __propertyIsEnumerable({ a: 1 }, 'a'))
//! expect: a; b true true
var nums = [1, 2]
var n = __push(nums, 3)
console.log(n, __join(nums, ','), __hasOwnProperty({ a: 1 }, 'b'))
//! expect: 3 1,2,3 false
// The plain, one-hop-shorter forms the `.bind` idiom is built from -- rewritten
// by the identical source transform, with no declaration to track.
console.log(Array.prototype.join.call(nums, '|'), Object.prototype.hasOwnProperty.call({ a: 1 }, 'a'))
//! expect: 1|2|3 true
