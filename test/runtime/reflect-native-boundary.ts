const record = { value: 42 }
console.log(Reflect.has(record, 'value'))
//! expect: true
console.log(Reflect.get(record, 'value'))
//! expect: 42
console.log(Reflect.set(record, 'value', 43))
//! expect: true
console.log(Reflect.get(record, 'value'))
//! expect: 43
console.log(Reflect.deleteProperty(record, 'value'))
//! expect: true
console.log(Reflect.has(record, 'value'))
//! expect: false
//! emitted-lacks: gea::Value::box
