// @ts-nocheck
// RequireObjectCoercible runs for an EMPTY object pattern too, and a nullish
// member access throws a real TypeError object, not a string spelling one.
function f({} = null) {
  return 1
}
function g({} = {}) {
  return 2
}
function h({ a }) {
  return a
}
try {
  f()
  console.log('no throw')
} catch (e) {
  console.log(e instanceof TypeError, e.name)
}
//! expect: true TypeError
console.log(g(), g(undefined), h({ a: 3 }))
//! expect: 2 2 3
try {
  h(null)
} catch (e) {
  console.log(e instanceof TypeError, e instanceof Error)
}
//! expect: true true
