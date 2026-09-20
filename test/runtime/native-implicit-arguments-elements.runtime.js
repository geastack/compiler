//! expect: 7
//! expect: true
//! emitted-lacks: gea::Value::box

class Item {
  /** @param {number} value */
  constructor(value) {
    this.value = value
  }
}

/** @param {Item} first */
function total(first) {
  if (arguments.length > 1) {
    let sum = 0
    for (let i = 0; i < arguments.length; i++) {
      sum += total(arguments[i])
    }
    return sum
  }
  return first.value
}

function absent() {
  return arguments[100] === undefined
}
console.log(total(new Item(3), new Item(4)))
console.log(absent(new Item(1)))
