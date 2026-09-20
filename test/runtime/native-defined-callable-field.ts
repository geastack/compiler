//! expect: 7
//! expect: 9
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

class Holder {
  id = 0
  run = () => 7
  constructor() {
    Object.defineProperty(this, 'id', { value: 1 })
  }
}
const initial = new Holder()
console.log(initial.run())
const updated = Object.defineProperty(initial, 'run', { value: () => 9 })
console.log(updated.run())
