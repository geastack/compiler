function alpha() {
  return 1
}
function beta() {
  return 2
}
const arrow = () => 3
/** @param {number} value */
function capture(value) {
  return () => value
}
const first = capture(4)
const second = capture(5)
/** @type {(value: number) => number} */
const widened = alpha
class Material {
  onBeforeCompile() {
    /* shader source */ return 7
  }
  key() {
    return this.onBeforeCompile.toString()
  }
}
let effects = 0
function touch() {
  effects++
  return 1
}
console.log(alpha.toString())
console.log(beta.toString())
console.log(arrow.toString())
console.log(first.toString() === second.toString(), first(), second())
console.log(widened.toString() === alpha.toString(), widened(9))
console.log(new Material().key())
// @ts-expect-error ECMAScript evaluates and ignores extra builtin arguments.
console.log(alpha.toString(touch()) === alpha.toString(), effects)
let mutable = alpha
function replace() {
  mutable = beta
  return 1
}
// @ts-expect-error The builtin evaluates this argument after capturing its receiver.
console.log(mutable.toString(replace()) === alpha.toString(), mutable())
/** @param {number} value */
function scale(value) {
  return value * 2
}
/** @type {(value: number) => number | undefined} */
const maybeScale = scale
console.log(maybeScale.toString() === scale.toString(), maybeScale(3))
