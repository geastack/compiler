// @ts-nocheck
//! dynamic-fallback
//! expect: ,"a":1,"b":"x","c":null,"d":true
// pino's `asJson`: `let value` is written `obj[key]` (untyped), `null` and a
// stringifier's string, and read under `switch (typeof value)` as a number
// and a boolean -- values the written strings and `null` alone cannot be.
function asString (text) { return JSON.stringify(text) }
function render (obj) {
  let value
  let out = ''
  for (const key in obj) {
    value = obj[key]
    switch (typeof value) {
      case 'number':
        if (Number.isFinite(value) === false) {
          value = null
        }
      case 'boolean':
        break
      case 'string':
        value = asString(value)
        break
      default:
        value = JSON.stringify(value)
    }
    out += ',' + asString(key) + ':' + value
  }
  return out
}
console.log(render(JSON.parse('{"a":1,"b":"x","c":null,"d":true}')))
