//! dynamic-fallback
//! expect: 0 -1 1 -1 "a" "b" false true
// ajv's generated `return false; break;` leaves a statement after a return
// that the language never evaluates, and pino's `cond ? f : _asString` reads a
// function declaration written further down. Both are censused in evaluation
// order: nothing after an abrupt completion, function declarations on entry.
'use strict'
function firstBelow (x) {
  for (let i = 0; i < 3; i++) {
    if (x > i) {
      return i
      break
    }
  }
  return -1
}
function positive (x) {
  if (x > 0) {
    return 1
    console.log('dead')
  }
  return -1
}
const nodeMajor = Number('22.1'.split('.')[0])
const asString = nodeMajor >= 25 ? (str) => JSON.stringify(str) : _asString
function _asString (str) {
  return '"' + str + '"'
}
function unique (data) {
  const seen = {}
  for (let i = data.length; i--;) {
    if (typeof seen[data[i]] === 'number') {
      return false
      break
    }
    seen[data[i]] = i
  }
  return true
}
console.log(firstBelow(1), firstBelow(-5), positive(3), positive(-3), asString('a'), _asString('b'), unique(['a', 'a']), unique(['a', 'b']))
