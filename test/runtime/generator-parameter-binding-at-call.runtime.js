// @ts-nocheck
// FunctionDeclarationInstantiation -- parameter defaults, destructuring, and
// the RequireObjectCoercible/GetIterator steps they run -- happens as part of
// [[Call]] (ECMA-262 10.2.1 step 8), before EvaluateGeneratorBody (15.5.2)
// ever creates the suspended generator object. So a thrown default surfaces
// at the CALL that creates the generator, not at its first next(): a plain
// coroutine defers the whole body, including this prefix, behind
// initial_suspend and prints "no throw" here instead.
//! expect: thrown boom | thrown iter | 5
function thrower() {
  throw new Error('boom')
}
class C {
  *method({ x = thrower() } = {}) {}
}
var c = new C()
var line1 = ''
try {
  c.method()
  line1 = 'no throw'
} catch (e) {
  line1 = 'thrown ' + e.message
}

/** @type {() => [number, number]} */
function throwingPair() {
  throw new Error('iter')
}
function* g(a, [b, cc] = throwingPair()) {
  yield a
}
var line2 = ''
try {
  g(1)
  line2 = 'no throw'
} catch (e) {
  line2 = 'thrown ' + e.message
}

var it = (function* (v = 5) {
  yield v
})()
var line3 = it.next().value

console.log(line1 + ' | ' + line2 + ' | ' + line3)
