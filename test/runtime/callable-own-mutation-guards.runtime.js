// @ts-nocheck
// TypeScript's JS-mode assignment-declaration analysis re-types `.call` for
// three of these six forms (direct property assignment, a computed
// assignment with a const string key, and Object.defineProperty) to
// `replacement`'s narrower one-parameter signature, and then refuses
// `direct.call('direct', 1)` as too many arguments. That is a static-analysis
// artifact of TypeScript recognizing those three shapes as declarations, not
// a real restriction: at runtime, all six forms replace the callable's own
// `call` property identically and every call site below passes two runtime
// arguments through it.
//
// `replacement`'s own `${this}:${value}` also disagrees with a first read of
// the original `//! expect:` lines below: called as `x.call(a, b)` after
// `.call` has been overwritten, this is an ORDINARY method call -- `this` is
// `x` itself (the callable object, which coerces to its own source text) and
// `value` is `a`, never the ORIGINAL `Function.prototype.call` convention of
// treating the first argument as a substitute receiver. Verified against real
// Node (`node test/runtime/callable-own-mutation-guards.runtime.js`); the
// previous expectations ("direct:1", "computed:2", ...) were never what this
// program prints and are replaced with substrings of the actual six lines.
//! expect: function direct(value) {
//! expect: }:direct
//! expect: function computed(value) {
//! expect: }:computed
//! expect: function assigned(value) {
//! expect: }:assign
//! expect: function reflected(value) {
//! expect: }:reflect
//! expect: function defined(value) {
//! expect: }:define
//! expect: function definitions(value) {
//! expect: }:defines
//! emitted-has: gea::callableDynamicGet

function original(value) {
  return `original:${value}`
}

function replacement(value) {
  return `${this}:${value}`
}

function direct(value) {
  return original(value)
}
direct.call = replacement
console.log(direct.call('direct', 1))

function computed(value) {
  return original(value)
}
const callKey = 'call'
computed[callKey] = replacement
console.log(computed.call('computed', 2))

function assigned(value) {
  return original(value)
}
Object.assign(assigned, { call: replacement })
console.log(assigned.call('assign', 3))

function reflected(value) {
  return original(value)
}
Reflect.set(reflected, 'call', replacement)
console.log(reflected.call('reflect', 4))

function defined(value) {
  return original(value)
}
Object.defineProperty(defined, 'call', { value: replacement, configurable: true, writable: true })
console.log(defined.call('define', 5))

function definitions(value) {
  return original(value)
}
Object.defineProperties(definitions, {
  call: { value: replacement, configurable: true, writable: true }
})
console.log(definitions.call('defines', 6))
