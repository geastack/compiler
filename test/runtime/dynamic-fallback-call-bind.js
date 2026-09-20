// @ts-nocheck
var __join = Function.prototype.call.bind(Array.prototype.join)
var __push = Function.prototype.call.bind(Array.prototype.push)
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable)
var failures = []
__push(failures, 'a')
__push(failures, 'b')
console.log(__join(failures, '; '), __hasOwnProperty({ a: 1 }, 'a'), __propertyIsEnumerable({ a: 1 }, 'a'))
