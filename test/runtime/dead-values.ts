//! expect: total=9
//! expect: label=b
//! emitted-lacks: "never read"
//! emitted-lacks: CallableObject<double(double)>{&
//! emitted-lacks: .call(
// Whatever the program never reads renders nothing (`ir/dead-values.ts`): a
// field read no expression consumes, a literal spelled once and dropped, and
// the function object of a callee that is only ever called by name.
class Box {
  value = 0
  label = 'b'
}
const main = (): void => {
  const box = new Box()
  box.value = 3
  box.value
  ;('never read')
  const total = ((n: number): number => n * 2)(box.value) + 3
  console.log(`total=${total}`)
  console.log(`label=${box.label}`)
}
main()
