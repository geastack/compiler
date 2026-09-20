//! expect: 7
//! expect: 2
//! emitted-lacks: gea::Value::box

class Holder {
  constructor(public run: () => number) {}
}
function select(value: Holder | number[]): number {
  if (value instanceof Holder) return value.run()
  return value.length
}
console.log(select(new Holder(() => 7)))
console.log(select([1, 2]))
