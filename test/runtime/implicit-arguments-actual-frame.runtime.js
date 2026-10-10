export {}
let effects = 0
/**
 * @param {*} [first]
 * @param {*} [second]
 */
function observe(first, second) {
  effects += 1
  const value = first === undefined ? 'u' : first === null ? 'n' : String(first)
  return arguments.length + ':' + value
}
console.log(observe(), observe(undefined), observe(null), observe(4, 5), effects)
