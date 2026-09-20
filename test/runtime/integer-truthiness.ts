//! expect: on=yes
//! expect: off=no
//! emitted-has: long long visible;
//! emitted-lacks: visible)) == (
// A `long long` has no NaN, so the NaN half of ToBoolean is a tautology there
// -- and gcc rejects `(v) == (v)` outright under `-Werror=tautological-compare`
// (`emit-presence.ts`'s `booleanTestText`). Five `if (store.flag)` sites in
// `examples/apps/weather` failed to compile the moment the integer census
// narrowed those flags.
class Flags {
  visible = 0
  step(by: number): void {
    this.visible = (this.visible + by) % 2
  }
}
const main = (): void => {
  const flags = new Flags()
  flags.step(1)
  console.log(`on=${flags.visible ? 'yes' : 'no'}`)
  flags.step(1)
  console.log(`off=${!flags.visible ? 'no' : 'yes'}`)
}
main()
