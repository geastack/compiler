//! expect: 7
//! expect: 7
//! expect: 2
//! expect: 2
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

class Wide {
  constructor(
    public data: number[] | Uint32Array,
    public run: () => number
  ) {}
}
class Narrow {
  constructor(
    public data: number[] | Uint16Array,
    public run: () => number
  ) {}
}
function make(wide: boolean) {
  return new (wide ? Wide : Narrow)([1, 2], () => 7)
}
const wide = make(true)
const narrow = make(false)
console.log(wide.run())
console.log(narrow.run())
console.log(wide.data.length)
console.log(narrow.data.length)
