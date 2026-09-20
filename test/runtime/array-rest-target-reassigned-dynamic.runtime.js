//! expect: x y
//
// `restAssignmentArrayShapeAt` (structural.ts) answers a bare rest-capture
// identifier's own type from every REST-destructuring write reaching it --
// `r` in `[a, ...r] = [1, 2, 3]` -- and used to silently skip any OTHER kind
// of write to the same symbol rather than checking whether one existed. A
// later plain reassignment from a genuinely dynamic value (`JSON.parse`,
// here) was invisible to it, so the cell still placed as
// `array-object(scalar(number))` from the ONE write this authority
// understood, and the store from the dynamic value read back through
// `gea::detail::unboxDynamicArray<double>` -- a fail-open unbox that
// aborted (`gea: a dynamic call argument read a dynamic property whose
// value is not of the declared type`, SIGABRT) the moment the parsed JSON
// held strings instead of numbers. Certified clean, compiled clean, crashed.
//
// Fixed by refusing outright the moment ANY write this authority cannot
// itself vouch for as a rest capture exists, sending the cell fully dynamic
// instead of narrowly (and wrongly) typed -- see that function's own updated
// header comment.
var a, r
;[a, ...r] = [1, 2, 3]
r = JSON.parse('["x","y"]')
console.log(r[0], r[1])
