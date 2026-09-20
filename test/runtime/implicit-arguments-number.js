// A declaration-less rest slot must use the same number element in the
// signature, caller pack, arguments reference and indexed body read.
function total() {
  let result = 0
  for (let i = 0; i < arguments.length; i++) result += arguments[i]
  return result
}
//! expect: 6 0 9
console.log(total(1, 2, 3), total(), total(9))
//! emitted-lacks: gea::Value
//! emitted-lacks: Value::box
//! emitted-lacks: unbox

/** @param {number} first */
function inspect(first) {
  console.log(first, arguments.length, arguments[0], arguments[1])
}
//! expect: 4 2 4 5
inspect(4, 5)
//! expect: 9 1 9 undefined
inspect(9)

/** @returns {number | undefined} */
function selected() {
  if (arguments.length > 1) return selected(arguments[0])
  return arguments[0]
}
//! expect: recursive=7
console.log('recursive=' + selected(7, 8))
/** @returns {number | undefined} */
function absent() {
  if (arguments.length > 1) return absent(arguments[100])
  return arguments[0]
}
//! expect: recursive-absent=undefined
console.log('recursive-absent=' + absent(7, 8))
