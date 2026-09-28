// @ts-nocheck
//! dynamic-fallback
//! expect: a false
//! expect: b true c
//! expect: d false
// avvio's `new Error(plugin.name, current.name)` passes a string where the
// options object goes; only an Object with a `cause` installs one.
function fail (name, other) {
  return new Error(name, other)
}
const e = fail('a', 'b')
console.log(e.message, 'cause' in e)
const withCause = new Error('b', JSON.parse('{"cause":"c"}'))
console.log(withCause.message, 'cause' in withCause, withCause.cause)
const without = new Error('d', JSON.parse('{"other":1}'))
console.log(without.message, 'cause' in without)
