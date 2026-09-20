// @ts-nocheck
// Static property descriptors over a record literal, an array, and a user
// function -- every receiver `objectDescriptorReturnTypeAt` (structural.ts)
// mints a native descriptor record for, read back through
// `Object.getOwnPropertyDescriptor`, `getOwnPropertyNames`, `defineProperty`
// and `propertyIsEnumerable`, with the sidecar-defined non-writable,
// non-configurable "b" refusing its delete and its write.
//
// The rejections are observed through `rejects` rather than as a returned
// `false` / an unchanged value: `module: ESNext` makes this an ES module, and
// an ES module is strict in its entirety (ECMA-262 11.2.2), so a delete of a
// non-configurable property and a store to a non-writable one both THROW.
// Real `node` running this file's own emitted module confirms it.
function rejects(action) {
  try {
    action()
    return 'missing'
  } catch (error) {
    return error.name
  }
}
var o = { a: 1 }
var d = Object.getOwnPropertyDescriptor(o, 'a')
console.log(d.value, d.writable, d.enumerable, d.configurable, typeof Object.getOwnPropertyDescriptor(o, 'zz'))
//! expect: 1 true true true undefined
var names = Object.getOwnPropertyNames(d)
console.log(names.length, names.join(','), Object.prototype.hasOwnProperty.call(d, 'value'))
// Own-key ORDER of the descriptor read back is FromPropertyDescriptor's
// creation order (value, writable, enumerable, configurable), which is what
// node prints. This line was `known-wrong` while the descriptor record came
// back in the ambient interface's declaration order; the composed descriptor
// record now keeps creation order, so it is pinned as correct.
//! expect: 4 value,writable,enumerable,configurable true
Object.defineProperty(o, 'b', { value: 2, writable: false, enumerable: false, configurable: false })
console.log(
  o.b,
  Object.keys(o).join(','),
  rejects(function () {
    delete o.b
  }),
  o.b,
  Object.getOwnPropertyDescriptor(o, 'b').writable
)
//! expect: 2 a TypeError 2 false
console.log(
  rejects(function () {
    o.b = 5
  }),
  o.b
)
//! expect: TypeError 2
var arr = [1, 2]
var ld = Object.getOwnPropertyDescriptor(arr, 'length')
var i0 = Object.getOwnPropertyDescriptor(arr, '0')
console.log(ld.value, ld.writable, ld.enumerable, ld.configurable, i0.value, i0.enumerable)
//! expect: 2 true false false 1 true
function f(x, y) {}
var fd = Object.getOwnPropertyDescriptor(f, 'name')
var fl = Object.getOwnPropertyDescriptor(f, 'length')
console.log(fd.value, fd.writable, fd.enumerable, fd.configurable, fl.value, fl.writable, fl.configurable)
//! expect: f false false true 2 false true
var enumerated = []
for (var k in o) enumerated.push(k)
console.log(enumerated.join(','), Object.prototype.propertyIsEnumerable.call(o, 'a'), Object.prototype.propertyIsEnumerable.call(o, 'b'))
//! expect: a true false
function describe(obj, key) {
  var x = Object.getOwnPropertyDescriptor(obj, key)
  return x === undefined ? 'absent' : [x.value, x.writable, x.enumerable, x.configurable].join('/')
}
console.log(describe(o, 'a'), describe(o, 'b'), describe(o, 'c'), describe(arr, 'length'))
//! expect: 1/true/true/true 2/false/false/false absent 2/true/false/false
