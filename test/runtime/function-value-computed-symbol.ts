// @ts-nocheck
// Real TypeScript refuses `const callback: TaggedCallback = (value) => value`
// on its own, with no `callback[key] = 17` in sight: a plain function LITERAL
// is never assignable to an interface that declares an index signature
// alongside its call signature, because the literal itself states no index
// signature (verified directly against `tsc`; TS2322, "Index signature for
// type 'symbol' is missing"). That is a fact about how object-literal
// assignability works, unrelated to the dynamic own-property behavior this
// program exercises, so checking is disabled the same way other dynamic-
// callable fixtures in this suite do.
//! expect: 17
//! emitted-has: gea::callableDynamicGet
//! emitted-has: gea::callableDynamicSet

interface TaggedCallback {
  (value: number): number
  [key: symbol]: unknown
}

const key = Symbol.for('runtime-test:callable-own-symbol')
const callback: TaggedCallback = (value) => value
callback[key] = 17
console.log(callback[key])
