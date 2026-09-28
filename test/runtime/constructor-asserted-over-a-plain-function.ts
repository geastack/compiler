//! expect: 1 2 false true
// The cookie package's `NullObject`: a plain function whose `prototype` is
// replaced with `Object.create(null)`, asserted to `{ new (): any }` and then
// constructed for a prototype-free table.
const NullObject = /* @__PURE__ */ (() => {
  const C = function () {}
  C.prototype = Object.create(null)
  return C
})() as unknown as { new (): any }

const table = new NullObject()
table.a = '1'
table['b'] = '2'
console.log(table.a, table.b, 'toString' in table, 'a' in table)
