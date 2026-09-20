// @ts-nocheck
// `Date.prototype` read as a VALUE is a host protocol of its own
// (`Date.prototype@1`), namespace-shaped: its members are the instance
// methods, each read as a reflectable callable carrying the builtin's own
// `name`/`length` facts (10.2.10), and the Math sidecar answers own-property
// questions over it -- the shape of every test262 `built-ins/*/prototype/*/
// {name,length,prop-desc}.js` case.
//! expect: getTime false false true 0
//! expect: function true false true
//! expect: true false
//! expect: length 0 false false true
var d = Object.getOwnPropertyDescriptor(Date.prototype.getTime, 'name')
console.log(d.value, d.writable, d.enumerable, d.configurable, Date.prototype.getTime.length)
var p = Object.getOwnPropertyDescriptor(Date.prototype, 'getTime')
console.log(typeof p.value, p.writable, p.enumerable, p.configurable)
console.log(Object.prototype.hasOwnProperty.call(Date.prototype, 'getTime'), Object.prototype.hasOwnProperty.call(Date.prototype, 'nope'))
var l = Object.getOwnPropertyDescriptor(Date.prototype.getTime, 'length')
console.log('length', l.value, l.writable, l.enumerable, l.configurable)
