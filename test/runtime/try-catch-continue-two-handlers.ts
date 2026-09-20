// Two catch handlers in one loop body whose `continue`s land on the SAME
// latch. With two jumps into it the latch is entry-dominated by neither
// handler, so it belongs to the ordinary per-block loop and both handlers
// reach it by an ordinary `goto` out of their braces -- the case the
// single-handler fixture beside this one cannot exercise, and the one that
// proves the ownership cut is a dominance question rather than "whatever the
// handler can reach".
//! expect: abc
let seen = ''
for (let k = 0; k < 3; k++) {
  try {
    if (k === 0) {
      throw new Error('first')
    }
  } catch (e) {
    seen += 'a'
    continue
  }
  try {
    if (k === 1) {
      throw new Error('second')
    }
  } catch (e) {
    seen += 'b'
    continue
  }
  seen += 'c'
  break
}
console.log(seen)
