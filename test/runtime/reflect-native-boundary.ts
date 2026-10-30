const record = { value: 42 }
console.log(Reflect.has(record, 'value'))
//! expect: true
console.log(Reflect.get(record, 'value'))
//! expect: 42
console.log(Reflect.set(record, 'value', 43))
//! expect: true
console.log(Reflect.get(record, 'value'))
//! expect: 43
// A required field's deletion is refused (reflect-delete-of-a-required-record-field-is-refused.runtime.ts).
const noted: { note?: string } = { note: 'kept' }
console.log(Reflect.deleteProperty(noted, 'note'))
//! expect: true
console.log(Reflect.has(noted, 'note'))
//! expect: false
//! emitted-lacks: gea::Value::box
