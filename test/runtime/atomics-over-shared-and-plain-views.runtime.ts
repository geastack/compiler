//! expect: 3 7 3 5 0 not-equal TypeError
// ECMA-262 25.4: the non-waiting Atomics operations work over any integer
// typed array; `wait` needs a shared buffer (a TypeError otherwise) and
// `notify` over an unshared one wakes nobody.
const shared = new Int32Array(new SharedArrayBuffer(16))
const plain = new Int32Array(4)
Atomics.store(shared, 1, 3)
Atomics.store(plain, 1, 3)
const added = Atomics.add(plain, 1, 2)
const exchanged = Atomics.compareExchange(plain, 1, 5, 7)
let waited = 'none'
try {
  Atomics.wait(plain, 0, 0, 0)
  waited = 'returned'
} catch (error) {
  waited = error instanceof TypeError ? 'TypeError' : 'other'
}
console.log(Atomics.load(shared, 1), Atomics.load(plain, 1), added, exchanged, Atomics.notify(plain, 0, 1), Atomics.wait(shared, 0, 1, 0), waited)
