// @ts-nocheck
//! expect: 10,11 null 6 false
// ipaddr's `expandIPv6(string, parts)`: a parameter every caller passes a
// Number and the body later reassigns to an array, so its cell holds either.
// A comparison reads it before the reassignment, which is ToNumber of the
// live arm -- the Number itself, or an array through its string -- not a
// refusal for want of one rule over the whole union.
function expand (string, parts) {
  if (string.split(':').length > parts) return null
  parts = string.split(':').map((part) => parseInt(part, 16))
  return parts
}
function spread (values) {
  let cell = values.length
  const before = cell * 2
  if (before > 4) cell = values
  return [before, cell >= 1]
}
console.log(String(expand('a:b', 8)), expand('a:b:c', 2), ...spread([1, 2, 3]))
