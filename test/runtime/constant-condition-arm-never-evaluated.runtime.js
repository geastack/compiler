//! dynamic-fallback
//! expect: 2 f one c early 2
//! expect: 45 0
// A constant condition decides statically which arm runs: the ruled-out arm
// of an `if`, and the body of a `while`/`for` whose test is constant-falsy,
// are never evaluated, and a constant-truthy test is an unconditional loop.
'use strict'
let hits = 0
function side (v) { hits++; return v }
function f (x) {
  if (false) {
    console.log('dead')
    return 1
  }
  if (0) side(0)
  if ('') side(0); else side(1)
  if (1) { if (null) return -1 } else return -2
  return x + 1
}
const a = 'f'
const b = 'one'
const c = side('c')
function g () { if (true) return 'early'; side('late'); return 'late' }
console.log(f(1), a, b, c, g(), hits)
{
let m = 0
while (false) { m += 100 }
for (let k = (m += 7, 0); 0; k++) { m += 1000 }
let q = 0
while (true) { if (++q > 3) break; m += 10 }
while (1) { if (q-- < 2) break; m += 1 }
outer: for (;;) { for (let j = 0; j < 3; j++) { if (j === 1) { m += 3; break outer } m += 2 } }
console.log(m, q)
}
