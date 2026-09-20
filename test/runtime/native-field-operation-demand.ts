//! expect: retained,child
//! expect: 41
//! expect: 7
//! emitted-lacks: gea::Value::box

class Child {
  value = 7
}
class Fields {
  removable?: number = 13
  retained = 41
  child = new Child()
}
const fields = new Fields()
delete fields.removable
console.log(Object.keys(fields).join(','))
console.log(fields.retained)
console.log(fields.child.value)
