// An array-pattern ELISION over a native iterator cursor still STEPS it:
// ECMA-262 8.6.2 IteratorBindingInitialization's `Elision` production calls
// IteratorStep and discards the result, so `[, x]` resumes a generator once
// before reading the position that follows.

function* g(): Generator<number> {
  yield 1
  yield 2
  yield 3
}
const [, x, , y] = g()
//! expect: 2 undefined
console.log(x, y)

// test262 language/statements/variable/dstr/ary-ptrn-elem-ary-elision-init.js:
// a defaulted, NESTED array-pattern element builds its own generator in the
// default's initializer (the outer source `[]` is exhausted at position 0, so
// `v` is `undefined` and the initializer runs), then the inner pattern `[,]`
// elides over THAT generator -- one resume, never past its first yield.
let calls = 0
let resumedPastYield = false
function* h(): Generator<number> {
  calls += 1
  yield 1
  resumedPastYield = true
}
const [[,] = h()] = []
//! expect: calls=1 resumed=false
console.log('calls=' + calls + ' resumed=' + resumedPastYield)
