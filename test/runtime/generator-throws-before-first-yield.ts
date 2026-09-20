// A generator whose body throws before it ever yields is still a coroutine:
// the throw surfaces on the first `next()`, not at the call that creates it.
// An elision in an array pattern over a generator steps it once, and a
// defaulted binding element holds the read with its absence replaced.
//! expect: caught 0 after 2 2 1 2
var n = 0
function* g(): Generator<number> {
  throw new Error('x')
}
var it = g()
function f([,] = it): void {}
var line = ''
try {
  f()
  line += 'no throw'
} catch (e) {
  line += 'caught ' + n
}
try {
  it.next()
  line += ' after'
} catch (e) {
  line += ' caught2'
}
function* h(): Generator<number> {
  n = n + 1
  yield 1
  n = n + 1
  yield 2
  n = n + 1
  yield 3
}
var [, b] = h()
var [a, c = 5] = [1, 2]
console.log(line, b, n, a, c)
