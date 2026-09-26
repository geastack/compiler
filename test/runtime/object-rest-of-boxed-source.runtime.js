//! dynamic-fallback
//! expect: 1 {"b":2,"c":{"d":3},"e":5} b,c,e {"a":1,"b":2,"c":{"d":3}}
// An object rest over a boxed source into a boxed rest: a fresh ordinary
// object holding every own key but the named ones; the source is untouched.
'use strict'
const src = JSON.parse('{"a":1,"b":2,"c":{"d":3}}')
const { a, ...rest } = src
rest.e = 5
console.log(a, JSON.stringify(rest), Object.keys(rest).join(','), JSON.stringify(src))
