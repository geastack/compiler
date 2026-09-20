//! dynamic-fallback
//! expect: rest called 9
//! expect: empty-rest bare 0
//! expect: fixed 7

// `Function.prototype.call` on a callee the program declared `Function` -- a
// BOXED callee -- fills ECMA-262's flat argument list, not the underlying
// callable's physical convention. `projection/callee.ts`'s `DeferredCallee`
// states which of the two through `frame`, and this file is the pin for both
// halves of what filling the wrong one did.
//
// The this-argument must arrive by IDENTITY. Converting it into the callee's
// own receiver carrier is, for a record, a field-by-field copy, and `Routed`'s
// `this.label = label` then wrote to that copy while the caller's `receiver`
// was never touched -- a silent wrong answer, which is why `rest` below reads
// the caller's object back rather than the call's own result.
//
// The rest slot must be packed EXACTLY ONCE, by the callee's own thunk. The
// call site packing against the physical convention as well handed the thunk
// one packed array where a `double` was declared, and the program aborted at
// `DynamicCallableCarrier<double>::in`. `.call` SPREADS -- `empty-rest` pins
// the zero-argument tail of that same rest slot, which is where an off-by-one
// in either packer shows up as a `default` label or a non-zero total.
//
// Verified against real node (ESM): `rest called 9`, `empty-rest bare 0`,
// `fixed 7`.
//
// The field order of `receiver` below is NOT decoration: it matches the order
// `Routed`'s own `this` writes establish. `structuralShapeKey`'s `object` arm
// keys on the member SEQUENCE, so the same three members written in another
// order are a second structural type and a second C++ struct, and the
// conversion between them is the identity-destroying copy this file exists to
// catch. See a finding of 2026-09-08.

/**
 * @param {string=} label
 * @param {...number} values
 */
function Routed(label = 'default', ...values) {
  this.label = label
  this.total = 0
  for (const value of values) this.total += value
  return `ignored:${label}`
}
Routed.prototype.kind = 'route'

const receiver = { label: '', total: 0, kind: 'route' }
/** @type {Function} */
const routedFn = Routed
routedFn.call(receiver, 'called', 4, 5)
console.log('rest', receiver.label, receiver.total)

const empty = { label: '', total: 0, kind: 'route' }
routedFn.call(empty, 'bare')
console.log('empty-rest', empty.label, empty.total)

/** @param {number} a @param {number} b */
function addFixed(a, b) {
  return a + b
}
/** @type {Function} */
const fixedFn = addFixed
console.log('fixed', fixedFn.call(null, 3, 4))
