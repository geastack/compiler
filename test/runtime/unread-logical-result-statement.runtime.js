//! dynamic-fallback
//! expect: {"a":1,"b":2} {"b":3} {}
// A logical expression evaluated only for its effects: its result is never
// read, so its arms need no common carrier -- fastify's error-serializer.
'use strict'
function serialize (obj) {
  let json = '{'
  let addComma = false
  if (obj.a !== undefined) {
    !addComma && (addComma = true) || (json += ',')
    json += '"a":' + obj.a
  }
  if (obj.b !== undefined) {
    !addComma && (addComma = true) || (json += ',')
    json += '"b":' + obj.b
  }
  return json + '}'
}
console.log(serialize({ a: 1, b: 2 }), serialize({ b: 3 }), serialize({}))
