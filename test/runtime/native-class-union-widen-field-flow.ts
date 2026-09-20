//! expect: 7
//! expect: 9
//! expect: true
//! expect: true
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

class Base {
  constructor(public run: () => number) {}
}
class First extends Base {}
class Second extends Base {}
function make(first: boolean, run: () => number): Base {
  return new (first ? First : Second)(run)
}
console.log(make(true, () => 7).run())
console.log(make(false, () => 9).run())
console.log(make(true, () => 7) instanceof First)
console.log(make(false, () => 9) instanceof Second)
