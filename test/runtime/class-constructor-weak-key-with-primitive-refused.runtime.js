// @ts-nocheck
//! expect-refusal: has no reference identity
// A weak key must be an object (ECMA-262 24.3/24.4), and this runtime keys a
// weak collection by object identity. A class object has one; a union that
// also admits a string does not, so the WeakMap is refused rather than
// keyed by a value with no identity.
class Light {}

/** @type {WeakMap<typeof Light | string, number>} */
const byClass = new WeakMap()
byClass.set(Light, 1)
console.log(byClass.get(Light))
