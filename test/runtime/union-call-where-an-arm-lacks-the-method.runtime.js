// @ts-nocheck
//! dynamic-fallback
//! expect: 104 TypeError
// secure-json-parse's `text.charCodeAt(0)` over a string or a Buffer: the
// string arm is String.prototype's own, and a closed record that declares no
// such member holds none, so calling it there throws.
const pick = (s) => (s ? 'hi' : { code: 7 })
const first = (text) => text.charCodeAt(0)
let thrown = ''
try {
  first(pick(JSON.parse('false')))
} catch (e) {
  thrown = e.name
}
console.log(first(pick(JSON.parse('true'))), thrown)
