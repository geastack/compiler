// @ts-nocheck
//! expect: a:plain
//! expect: b:x
//! expect: c:plain d:y
// three's `ShaderNodeProxy( NodeClass, scope = null, factor = null, settings =
// null )`: no tag, so the checker types `settings` by its default alone, as
// `null`, and calls the `settings !== null` branch unreachable. The callers
// pass objects; the parameter holds them.
function describe(value, settings = null) {
  if (settings !== null) return value + ':' + settings.label
  return value + ':plain'
}
console.log(describe('a'))
console.log(describe('b', { label: 'x' }))
const proxy = function (settings = null) {
  return (value) => (settings !== null ? value + ':' + settings.label : value + ':plain')
}
const table = [proxy(), proxy({ label: 'y' })]
console.log(table[0]('c') + ' ' + table[1]('d'))
