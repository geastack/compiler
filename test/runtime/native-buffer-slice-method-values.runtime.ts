const ordinary = new ArrayBuffer(4)
new Uint8Array(ordinary).set([1, 2, 3, 4])
const other = new ArrayBuffer(3)
new Uint8Array(other).set([7, 8, 9])
const ordinarySlice = ordinary.slice
console.log(Array.from(new Uint8Array(ordinarySlice.call(other, 1))).join(','))

const shared = new SharedArrayBuffer(4)
new Uint8Array(shared).set([5, 6, 7, 8])
const sharedSlice = shared.slice
const copied = sharedSlice.call(shared, 1, 3)
new Uint8Array(shared)[1] = 99
console.log(Array.from(new Uint8Array(copied)).join(','))
console.log(ordinary.slice === other.slice, shared.slice === new SharedArrayBuffer(0).slice, Object.is(ordinarySlice, sharedSlice))

try {
  ordinarySlice(0)
} catch {
  console.log('unbound rejected')
}
try {
  ordinarySlice.call(shared as unknown as ArrayBuffer, 0)
} catch {
  console.log('wrong brand rejected')
}
try {
  sharedSlice.call(undefined as unknown as SharedArrayBuffer, 0)
} catch {
  console.log('undefined rejected')
}

//! expect: 8,9
//! expect: 6,7
//! expect: true true false
//! expect: unbound rejected
//! expect: wrong brand rejected
//! expect: undefined rejected
