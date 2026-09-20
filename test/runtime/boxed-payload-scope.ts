//! expect: ticks=30
//! emitted-has: long long ticks;
// A box strikes what it CARRIES, not the program that contains it
// (`ir/integer-storage.ts`'s `boxedStructs`). `console.log` boxes a string and
// `throw new Error(...)` boxes an Error record under `Tag::Object`; neither can
// pun a numeric member of anything. Reading either as "this program boxes"
// switched off every field, formal and result the integer census could
// otherwise narrow -- in `examples/apps/weather` one unreachable throw cost
// eleven integer flags, held as `Signal<double>` and stepped in software
// floating point on a core with no double FPU.
class Counter {
  ticks = 0
  step(by: number): void {
    this.ticks = (this.ticks + by) % 1000
  }
}
const guard = (value: number): void => {
  if (value > 1000) throw new Error('too many')
}
const main = (): void => {
  const counter = new Counter()
  for (let i = 0; i < 10; i += 1) counter.step(3)
  guard(counter.ticks)
  console.log(`ticks=${counter.ticks}`)
}
main()
