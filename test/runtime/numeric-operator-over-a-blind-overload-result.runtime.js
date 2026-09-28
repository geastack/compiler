// @ts-nocheck
//! dynamic-fallback
//! expect: leftover 12 number -4 number 0
//! expect: leftover 12 number -4 number 0
// thread-stream's `nextFlush(stream)`: `Atomics.load` over a view read off a
// parameter nothing types is an overload the checker chose blind -- the
// BigInt one -- so the load is boxed, and so is every numeric operator built
// on it. The checker typed `leftover` `bigint` from that one operand, and
// holding the Number the subtraction produces as a BigInt aborted.
const kImpl = Symbol('kImpl')
function nextFlush (stream) {
  const writeIndex = Atomics.load(stream[kImpl].state, 1)
  const leftover = stream[kImpl].data.length - writeIndex
  const negated = -writeIndex
  const masked = writeIndex & 3
  console.log('leftover', leftover, typeof leftover, negated, typeof negated, masked)
}
const state = new Int32Array(new SharedArrayBuffer(16))
Atomics.store(state, 1, 4)
nextFlush({ [kImpl]: { state, data: new Uint8Array(16) } })
const untyped = JSON.parse('{}')
untyped[kImpl] = { state, data: new Uint8Array(16) }
nextFlush(untyped)
