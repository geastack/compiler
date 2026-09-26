//! dynamic-fallback
//! expect: plain f 3
//! expect: one-arg 1
//! expect: two-arg x
//! expect: undef-first y
//! expect: catch z
//! expect: passthrough 2
// A boxed promise's `then(onFulfilled, onRejected)` runs the handler for the
// settlement that happened, `catch` is `then(undefined, onRejected)`, and a
// non-callable handler passes the settlement through (ECMA-262 27.2.5).
'use strict'
function run (func, label) {
  const result = func()
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    if (label === 'a') result.then((v) => console.log('one-arg', v))
    if (label === 'b') result.then((v) => console.log('no'), (e) => console.log('two-arg', e.message))
    if (label === 'c') result.then(undefined, (e) => console.log('undef-first', e.message))
    if (label === 'd') result.catch((e) => console.log('catch', e.message))
    if (label === 'e') result.then(null, (e) => console.log('no')).then((v) => console.log('passthrough', v))
  } else console.log('plain', label, result)
}
run(() => Promise.resolve(1), 'a')
run(() => Promise.reject(new Error('x')), 'b')
run(() => Promise.reject(new Error('y')), 'c')
run(() => Promise.reject(new Error('z')), 'd')
run(() => Promise.resolve(2), 'e')
run(() => 3, 'f')
