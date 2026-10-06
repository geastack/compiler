//! expect: param=3
//! expect: field=100
//! expect: typed=7
//! expect: param2=7
//! emitted-has: callStable(
//! emitted-has: .call(
// A callee that is the caller's own parameter sits in a slot nothing the callee runs can write, so
// the call skips the environment retain `CallableObject::call` makes (`callStable`). A callee read
// out of a field keeps `call`: the callback below overwrites that very field while it runs, which
// would free the closure mid-call without the retain.
const viaParam = (fn: (n: number) => number, n: number): number => fn(n) + 1
class Holder {
  fn: (n: number) => number = (n) => n
  seed = 0
  run(n: number): number {
    this.seed = n
    return this.fn(n) + this.seed
  }
}
const holder = new Holder()
holder.fn = (n: number): number => {
  holder.fn = (m: number) => m
  holder.seed = 99
  return n
}
const table = new Float64Array(4)
table[2] = 7
const readTable = (): number => table[2] ?? 0
console.log(`param=${viaParam((n) => n + 1, 1)}`)
// A second function through the same parameter, so no census names the callee.
console.log(`param2=${viaParam((n) => n * 2, 3)}`)
console.log(`field=${holder.run(1)}`)
console.log(`typed=${readTable()}`)
