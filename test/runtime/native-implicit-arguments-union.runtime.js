//! expect: 7seven
//! expect: 9nine
//! emitted-lacks: gea::Value
//! emitted-lacks: gea::Value::box
//! emitted-lacks: gea::Value::unbox

/**
 * @param {number} number
 * @param {string} text
 */
function joined(number, text) {
  let result = ''
  for (let i = 0; i < arguments.length; i++) {
    const item = arguments[i]
    result += String(item)
  }
  return result
}

console.log(joined(7, 'seven'))
console.log(joined(9, 'nine'))
