// A module body that declares any function allocates a closure, and the hoist
// used to refuse every cell read in every loop of such a body: a closure might
// write the cell. So the loop bound `N` was re-read from its global each turn,
// `dense-loops.ts` could not name it at the preheader, and every typed-array
// access paid its bounds and view checks, about 6x slower than the same loop
// in a function. A closure writes only when it runs; a loop that runs no
// other code runs none, so its reads stay put.
//
// The loop counters are block-scoped module bindings no closure names, so they
// are frame locals of the module body (`regionFrameCells`), never globals.
//
// The second loop calls a function that changes its bound, which is exactly
// when the read must stay in the loop: it stops at 3, not 6.
const N: number = 8
let limit: number = 6

// No loop of its own, so any window in this program is the module body's.
function make(): Float64Array {
  return new Float64Array(N * N)
}

const a = make()
for (let i = 0; i < N * N; i++) a[i] = (i * 3) % 7
const c = new Float64Array(N * N)
for (let i = 0; i < N; i++) {
  for (let k = 0; k < N; k++) {
    const aik = a[i * N + k]!
    if (aik === 0) continue
    const iOff = i * N
    for (let j = 0; j < N; j++) c[iOff + j] = c[iOff + j]! + aik * a[k * N + j]!
  }
}
let sum = 0
for (let i = 0; i < N * N; i++) sum += c[i]!

function shrink(): void {
  limit = 3
}
let turns = 0
for (let i = 0; i < limit; i++) {
  turns++
  if (i === 1) shrink()
}

const later: (() => number)[] = []
for (let i = 0; i < 3; i++) later.push(() => i)

console.log(`matmul ${sum} turns ${turns} captured ${later.map((f) => f()).join(',')}`)

//! expect: matmul 4501 turns 3 captured 0,1,2
//! emitted-has: gea_dense_ok_
