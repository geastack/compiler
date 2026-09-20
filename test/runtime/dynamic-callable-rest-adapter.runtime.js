//! dynamic-fallback
//! expect: a:b:c
//! expect: ctx/4/5
// `recoverRest`/`recoverMethodRest` each have exactly one call site whose
// argument's own signature already matches the `@returns` annotation, so the
// compiler recovers BOTH natively at compile time -- the whole point of
// "recovery" -- rather than emitting a `gea::Value`-boxed dynamic Function and
// a `DynamicCarrier<CallableObject<...>>::inWithRest`/`inWithReceiverAndRest`
// runtime adapter over it. The original `inWithRest<0>`/`inWithReceiverAndRest<1>`
// pins asserted the SLOWER of two correct answers; pinning the absence of any
// dynamic Function box here asserts the invariant that actually matters
// (no ABI-recovery boxing survived to run at all), without hardcoding which
// of the two legal recovery strategies the compiler happens to choose.
//! emitted-lacks: gea::Value::box(gea::Value::Tag::Function

/** @param {*} value @returns {(...parts: string[]) => string} */
function recoverRest(value) {
  return value
}

/** @param {...string} parts */
function joinParts(...parts) {
  return parts.join(':')
}

const joined = recoverRest(joinParts)
console.log(joined('a', 'b', 'c'))

/** @typedef {{ label: string }} Receiver */
/** @param {*} value @returns {function(this: Receiver, ...number): string} */
function recoverMethodRest(value) {
  return value
}

/** @this {Receiver} @param {...number} values */
function formatValues(...values) {
  return `${this.label}/${values.join('/')}`
}

const formatted = recoverMethodRest(formatValues)
console.log(formatted.call({ label: 'ctx' }, 4, 5))
