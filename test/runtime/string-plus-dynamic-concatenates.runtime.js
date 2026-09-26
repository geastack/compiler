// @ts-nocheck
//! expect: float1 float2.5 floattrue floatnull
//! expect: 1vec xvec
// TSL's `ConvertType` returns `( value ) => ...` over its own string `type`.
// The arrow escapes, so `value` is dynamic, and `type + value` is a `+` with
// one string side: ECMA-262 13.15.3 concatenates whenever either primitive
// is a String, whatever the dynamic side turns out to hold.
const ConvertType = function (type) {
  return (value) => type + value
}
const float = new ConvertType('float')
console.log([float(1), float(2.5), float(true), float(null)].join(' '))
const suffix = function (tail) {
  return (value) => value + tail
}
const vec = suffix('vec')
console.log(vec(1), vec('x'))
