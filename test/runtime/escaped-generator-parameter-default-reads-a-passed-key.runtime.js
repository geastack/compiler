// @ts-nocheck
// A classic script's top-level `var` is a global-object property, which a
// closed script scope leaves open, so `method`'s parameter is refused as
// escaping. Its defaulted key must still read what each caller actually
// passes -- through a direct call, an `any` alias, and `globalThis` -- and fall
// back to the default only when the key is absent. A parameter whose field was
// typed `undefined` from the `{}` default alone would print `7 | 7 | 7`.
//! expect: 7 | 5 | 6
class C {
  *method({ x = 7 } = {}) {
    yield x
  }
}
var c = new C()
var a = c.method().next().value
var alias = /** @type {any} */ (c)
var b = alias.method({ x: 5 }).next().value
var d = globalThis.c.method({ x: 6 }).next().value
console.log(a + ' | ' + b + ' | ' + d)
