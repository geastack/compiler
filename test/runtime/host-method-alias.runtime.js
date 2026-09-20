// @ts-nocheck
//! expect: true false 3
//! emitted-lacks: gea::Value
var __isArray = Array.isArray
var __max = Math.max
function check(v) {
  return __isArray(v)
}
console.log(check([1]), check(2), __max(1, 3))
