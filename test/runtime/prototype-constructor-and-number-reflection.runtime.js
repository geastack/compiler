// @ts-nocheck
// Every builtin prototype owns `constructor` (writable, non-enumerable,
// configurable) even though the instance interface never spells it, and
// Number.prototype is a prototype protocol of its own with spec lengths the
// declaration's optional parameters do not reproduce (toFixed.length is 1).
//! expect: true function Date 7 true false true
//! expect: toFixed 1 false false true
//! expect: true false
var c = Object.getOwnPropertyDescriptor(Date.prototype, 'constructor')
console.log(
  Object.prototype.hasOwnProperty.call(Date.prototype, 'constructor'),
  typeof c.value,
  c.value.name,
  c.value.length,
  c.writable,
  c.enumerable,
  c.configurable
)
var l = Object.getOwnPropertyDescriptor(Number.prototype.toFixed, 'length')
console.log(Number.prototype.toFixed.name, l.value, l.writable, l.enumerable, l.configurable)
console.log(
  Object.prototype.hasOwnProperty.call(Number.prototype, 'toFixed'),
  Object.prototype.propertyIsEnumerable.call(Number.prototype, 'toFixed')
)
