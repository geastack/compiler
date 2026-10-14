//! expect: plain-while 5
//! expect: for-test-only 5
//! expect: for-with-update 5 4
//! expect: empty-statement 5
//! expect: do-while 5
//! expect: and 5 4
//! expect: or 3
//! expect: optional 5
//! expect: nested 3 15
//! expect: labeled 5
//! expect: top-level 5
//! expect: scan 4
// A loop whose body is empty still iterates: all of its work is in its test.
// No operation runs in the test's taken arm, so nothing asked for the arm and
// nothing built the branch; the code after the loop was appended to the
// header, and the test ran exactly once. `while (!it.next().done) {}` then
// drained a single step of a generator (cozy-creek's instance culling lost
// every range it pushed after its first `yield`).
class Counter {
  n = 0
  constructor(readonly limit: number) {}
  step(): boolean {
    this.n++
    return this.n < this.limit
  }
}

function plainWhile(): number {
  const c = new Counter(5)
  while (c.step()) {}
  return c.n
}
console.log(`plain-while ${plainWhile()}`)

function scan(): number {
  const xs = [5, 6, 7, 0, 9]
  let i = 0
  while (xs[i++] !== 0) {}
  return i
}
console.log(`scan ${scan()}`)

function forTestOnly(): number {
  const c = new Counter(5)
  for (; c.step();) {}
  return c.n
}
console.log(`for-test-only ${forTestOnly()}`)

function forWithUpdate(): string {
  const c = new Counter(5)
  let i = 0
  for (i = 0; c.step(); i++) {}
  return `${c.n} ${i}`
}
console.log(`for-with-update ${forWithUpdate()}`)

function emptyStatement(): number {
  const c = new Counter(5)
  while (c.step());
  return c.n
}
console.log(`empty-statement ${emptyStatement()}`)

function doWhile(): number {
  const c = new Counter(5)
  do {} while (c.step())
  return c.n
}
console.log(`do-while ${doWhile()}`)

function both(): string {
  const a = new Counter(5)
  const b = new Counter(9)
  while (a.step() && b.step()) {}
  return `${a.n} ${b.n}`
}
console.log(`and ${both()}`)

function either(): number {
  const a = new Counter(3)
  let calls = 0
  while (a.step() || ++calls < 0) {}
  return a.n
}
console.log(`or ${either()}`)

function optional(c: Counter | undefined): number {
  while (c?.step()) {}
  return c?.n ?? -1
}
console.log(`optional ${optional(new Counter(5))}`)

function nested(): string {
  const outer = new Counter(4)
  let inner = 0
  while (outer.step()) {
    const c = new Counter(6)
    while (c.step()) {}
    inner += c.n - 1
  }
  return `${outer.n - 1} ${inner}`
}
console.log(`nested ${nested()}`)

function labeled(): number {
  const c = new Counter(5)
  spin: while (c.step()) {}
  return c.n
}
console.log(`labeled ${labeled()}`)

const topCounter = new Counter(5)
while (topCounter.step()) {}
console.log(`top-level ${topCounter.n}`)
