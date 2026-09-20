//! dynamic-fallback
//! expect: object default 5 route true owned
//! expect: called 9 route true
//! expect: plain 4
//! expect: string:two
//! expect: number:3

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

// Only Routed owns a dynamic Function-property table. Alias identity, its
// expando, and its current prototype must all remain attached to that object.
Routed.prototype.kind = 'route'
Routed.extra = 'owned'
const Alias = Routed
const first = new Alias(undefined, 2, 3)
console.log(typeof first, first.label, first.total, first.kind, Alias === Routed, Alias.extra)

const receiver = { kind: 'route', label: '', total: 0 }
// `Routed` carries BOTH a call signature (its explicit `return`) and an
// inferred construct signature (from `this.x =` plus `new Alias(...)` above),
// which makes it "overloaded" from `Function.prototype.call`'s generic
// `this: (this: T, ...args: A) => R` inference: TypeScript tries to line the
// construct signature's return type (`Routed`) up against `R` and refuses --
// confirmed with a minimal reduction with NO JSDoc annotations at all, so this
// is inherent to any "callable used as a JS constructor function" pattern, not
// this fixture's own phrasing. Widening the callee's own static type to plain
// `Function` for this one invocation is the only workaround that type-checks
// without changing `receiver`'s shape or `Routed`'s own declared type.
/** @type {Function} */
const routedFn = Routed
routedFn.call(receiver, 'called', 4, 5)
console.log(receiver.label, receiver.total, receiver.kind, Alias === Routed)

// This declaration has the same physical parameter frame but no mutable
// Function-object state. It must not borrow Routed's identity-keyed fallback.
/**
 * @param {string=} label
 * @param {...number} values
 */
function Plain(label = 'default', ...values) {
  this.label = label
  this.total = 0
  for (const value of values) this.total += value
  return `ignored:${label}`
}
const plain = new Plain('plain', 4)
console.log(plain.label, plain.total)

/** @param {string|number} value */
function classify(value) {
  return typeof value === 'string' ? `string:${value}` : `number:${value}`
}
classify.prototype.kind = 'mutable'
console.log(classify('two'))
console.log(classify(3))
