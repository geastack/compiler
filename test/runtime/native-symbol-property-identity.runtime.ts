// @ts-nocheck
//! expect: keys true true true
//! expect: reads 2 8 true true
//! expect: mixed 3 text
//! expect: order true true
//! expect: enumerable 1 true
//! expect: numeric 2 n
//! expect: present true false
//! expect: deleted true false true true
//! expect: surviving true
//! expect: numeric-present true false
//! expect: well-known-present true
//! expect: tags [object Sample] [object Object] [object Object]
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

function make(value: number) {
  const key = Symbol('same description')
  const object = { visible: value, [key]: value + 1 }
  return { object, key }
}
const first = make(1)
const second = make(7)
console.log(
  'keys',
  Reflect.ownKeys(first.object)[1] === first.key,
  Reflect.ownKeys(second.object)[1] === second.key,
  first.key !== second.key
)
console.log(
  'reads',
  first.object[first.key],
  second.object[second.key],
  first.object[second.key] === undefined,
  second.object[first.key] === undefined
)
const numberKey = Symbol('number')
const textKey = Symbol('text')
const mixed = { [textKey]: 'text', [numberKey]: 3 }
console.log('mixed', mixed[numberKey], mixed[textKey])
console.log('order', Reflect.ownKeys(mixed)[0] === textKey, Reflect.ownKeys(mixed)[1] === numberKey)
const wellKnown = { visible: 1, [Symbol.toStringTag]: 'Sample' }
console.log('enumerable', Object.keys(wellKnown).length, Reflect.ownKeys(wellKnown)[1] === Symbol.toStringTag)

let numericKey: number = 4
const numeric = { label: 'n', [numericKey]: 2 }
console.log('numeric', numeric[numericKey], numeric.label)
console.log('present', first.key in first.object, second.key in first.object)
console.log(
  'deleted',
  delete first.object[first.key],
  first.key in first.object,
  first.object[first.key] === undefined,
  delete first.object[first.key]
)
console.log('surviving', Reflect.ownKeys(first.object).length === 1)
console.log('numeric-present', numericKey in numeric, numericKey + 1 in numeric)
console.log('well-known-present', Symbol.toStringTag in wellKnown)
const nonStringTag = { visible: 1, [Symbol.toStringTag]: 7 }
console.log(
  'tags',
  Object.prototype.toString.call(wellKnown),
  Object.prototype.toString.call(nonStringTag),
  Object.prototype.toString.call(first.object)
)
