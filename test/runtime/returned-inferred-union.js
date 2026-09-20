// The parameter census infers the input from its callers. The return census
// joins that input with the boolean alternative; the checker alone sees any.
function maybeValue(value, keep) {
  if (keep) return value
  return false
}

//! expect: 17
//! expect: false
console.log(maybeValue(17, true))
console.log(maybeValue(23, false))
