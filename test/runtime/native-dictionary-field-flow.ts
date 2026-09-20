//! expect: true
//! expect: 7
//! expect: true
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox
//! emitted-lacks: gea_cpp_value

type Slot = { value: number; needsUpdate?: boolean }
const values: Record<string, Slot> = {}
function read(key: string): Slot | undefined {
  return values[key]
}
console.log(read('item') === undefined)
values.item = { value: 7 }
console.log(read('item')?.value)
delete values.item
console.log(read('item') === undefined)
