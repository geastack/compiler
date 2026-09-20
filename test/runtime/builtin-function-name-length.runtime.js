// @ts-nocheck
// A BUILTIN function as the reflection receiver -- the shape of test262's
// thousands of `name.js`/`length.js` cases (`verifyProperty(Array.from,
// "name", { value: "from", writable: false, enumerable: false,
// configurable: true })`): ECMA-262 10.2.4 SetFunctionLength and 10.2.9
// SetFunctionName give both members {writable: false, enumerable: false,
// configurable: true}, answered from the host table without boxing the
// function.
var d = Object.getOwnPropertyDescriptor(Array.from, 'name')
var l = Object.getOwnPropertyDescriptor(Array.from, 'length')
console.log(d.value, d.writable, d.enumerable, d.configurable, l.value, Array.from.name, Array.from.length)
//! expect: from false false true 1 from 1
