//! expect: read 1 2
//! expect: keys true true
//! expect: descriptor 2 true true true
//! expect: ordered true true true true
//! expect: write true 7.5
//! expect: presence true true
//! expect: deletion true false true false true
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class ReflectBase {
  value = 1
}
class ReflectChild extends ReflectBase {
  detail = 2
}
const target = new ReflectChild()
const value = Reflect.get(target, 'value') as number
const detail = Reflect.get(target, 'detail') as number
console.log('read', value, detail)
Reflect.ownKeys(target)
const keys = Reflect.ownKeys(target)
console.log('keys', keys[0] === 'value', keys[1] === 'detail')
const descriptor = Object.getOwnPropertyDescriptor(target, 'detail') as {
  value: number
  writable: boolean
  enumerable: boolean
  configurable: boolean
}
console.log('descriptor', descriptor.value, descriptor.writable, descriptor.enumerable, descriptor.configurable)
const symbolKey = Symbol('keys')
const keyed = { 10: 10, 2: 2, visible: 1, [symbolKey]: 3 }
const orderedKeys = Reflect.ownKeys(keyed)
console.log('ordered', orderedKeys[0] === '2', orderedKeys[1] === '10', orderedKeys[2] === 'visible', orderedKeys[3] === symbolKey)
console.log('write', Reflect.set(target, 'value', 7.5), target.value)
console.log('presence', Reflect.has(target, 'value'), Reflect.has(target, 'detail'))
console.log(
  'deletion',
  Reflect.deleteProperty(target, 'value'),
  Reflect.has(target, 'value'),
  Reflect.deleteProperty(target, 'detail'),
  Reflect.has(target, 'detail'),
  Reflect.deleteProperty(target, 'missing')
)
