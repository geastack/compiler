//! dynamic-fallback
//! expect: true true false 2 1 true
// ajv's generated validators declare `var valid0` in both arms of every
// property check. Every declaration of one `var` name is one binding, so the
// write in the arm that ran is the one the read after the `if` sees.
'use strict'
function check (data) {
  let errors = 0
  if (data.id !== undefined) {
    const before = errors
    if (typeof data.id !== 'string') errors++
    var valid0 = before === errors
  } else {
    var valid0 = true
  }
  return valid0
}
function pick (x) {
  if (x) { var v = 1 } else { var v = 2 }
  var v
  return v
}
function carried (x) {
  var kept = true
  if (x) { var kept }
  return kept
}
console.log(check({}), check({ id: 's' }), check({ id: 1 }), pick(0), pick(1), carried(1))
