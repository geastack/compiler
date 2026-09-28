// @ts-nocheck
//! dynamic-fallback
//! expect: 7 5 7 0 timed-out TypeError TypeError TypeError number
// thread-stream's `waitDiff(state, index, ...)`: a helper no counted caller
// types, so its view, index and value arrive dynamic. ValidateIntegerTypedArray
// is the runtime's own check, the index and value are ToNumber'd as ToIndex
// and ToIntegerOrInfinity begin, and the result is the Number every integer
// view yields -- never the BigInt the checker's first overload names.
function poke (view, index, value) {
  Atomics.store(view, index, value)
  return Atomics.load(view, index)
}
function bump (view, index) {
  return Atomics.add(view, index, 2)
}
function wake (view, index) {
  return Atomics.notify(view, index)
}
function settle (view, index, expected) {
  return Atomics.wait(view, index, expected, 0)
}
const helpers = { poke, bump, wake, settle }
const call = (name, ...args) => helpers[name](...args)
const shared = new Int32Array(new SharedArrayBuffer(16))
const small = new Uint16Array(4)
const out = [
  call('poke', shared, '1', 7),
  call('poke', small, 2, '5'),
  call('bump', shared, 1),
  call('wake', shared, 0),
  call('settle', shared, 0, 0)
]
const attempt = (name, view) => {
  try {
    call(name, view, 0, 0)
    return 'none'
  } catch (error) {
    return error.name
  }
}
out.push(attempt('poke', new Uint8ClampedArray(4)), attempt('poke', {}), attempt('settle', small))
out.push(typeof call('poke', shared, 3, 1))
console.log(out.join(' '))
