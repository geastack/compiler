//! expect: alpha,beta
//! expect: other
//! expect: empty
//! expect: empty
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

/** @returns {string} */
function keys(value) {
  let result = ''
  for (const key in value) result += (result ? ',' : '') + key
  return result || 'empty'
}

console.log(keys({ alpha: 1, beta: 2 }))
console.log(keys({ other: true }))
console.log(keys(null))
console.log(keys(undefined))
