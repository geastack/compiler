//! expect: 8 5
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

/** @returns {number} */
function consume(value) {
  if (typeof value === 'number') return value + 1
  return value.length
}

/** @returns {number} */
function relay(input) {
  const alias = input
  return consume(alias)
}

console.log(relay(7), relay('seven'))
