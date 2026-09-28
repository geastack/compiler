// @ts-nocheck
//! dynamic-fallback
//! expect: 3 5 12
// thread-stream's `Atomics.load(stream[kImpl].state, WRITE_INDEX)`: the view
// is a field read through an untyped receiver, so the checker picks the first
// declared overload; the field's own `Int32Array` selects the number one.
const kImpl = Symbol('impl')
class Stream {
  constructor () {
    this[kImpl] = {}
    this[kImpl].state = new Int32Array(new SharedArrayBuffer(8))
  }
}
function write (stream, n) {
  const current = Atomics.load(stream[kImpl].state, 1)
  let offset = current
  offset += n
  Atomics.store(stream[kImpl].state, 1, offset)
  return offset
}
function nextFlush (stream) {
  const writeIndex = Atomics.load(stream[kImpl].state, 1)
  const leftover = 12 - writeIndex
  return write(stream, leftover)
}
const s = new Stream()
write(s, 3)
console.log(Atomics.load(s[kImpl].state, 1), write(s, 2), nextFlush(s))
