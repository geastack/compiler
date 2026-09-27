// @ts-nocheck
//! expect: 3 null 12 2
// three's GLSLNodeFunction: `let count = Number.parseInt(...)` is a number to the
// checker, and `else count = null` is a checker error it ignores. The cell has
// to hold the `null` the program writes, so it is laid out as a nullable number.
class Input {
  /**
   * @param {string} name - n.
   * @param {?number} [count=null] - c.
   */
  constructor(name, count = null) {
    this.name = name
    this.count = count
  }
}
const parts = ['3', 'x', '12']
const inputs = []
let used = 0
for (let i = 0; i < parts.length; i++) {
  let count = Number.parseInt(parts[i])
  if (Number.isNaN(count) === false) used++
  else count = null
  inputs.push(new Input('p' + i, count))
}
console.log(inputs.map((input) => (input.count === null ? 'null' : String(input.count))).join(' ') + ' ' + used)
