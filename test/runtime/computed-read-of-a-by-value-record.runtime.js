// @ts-nocheck
//! expect: a%40b%2Fc undefined
// fast-uri's `host.replace(re, (ch) => HOST_DELIMS[ch])`: a computed read off
// a record literal held by value consults its own fields.
const HOST_DELIMS = { '@': '%40', '/': '%2F', '?': '%3F', '#': '%23', ':': '%3A' }
const re = /[@/?#:]/g
console.log('a@b/c'.replace(re, (ch) => HOST_DELIMS[ch]), HOST_DELIMS[JSON.parse('"x"')])
