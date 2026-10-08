// @ts-nocheck
//! expect-refusal: no ToNumber is installed for optional(
// A Date beneath an absence still has no ToNumber: its own `@@toPrimitive`
// answers the timestamp for hint "number", which no conversion here
// computes, and its printable string is the wrong primitive. The optional
// wrapper must not let the object conversion accept it.
/** @param {number|Date|undefined} value */
function scale(value) {
  return value * 2
}
console.log(scale(3), scale(undefined), scale(new Date(5)))
