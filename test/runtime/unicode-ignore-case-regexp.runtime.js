//! expect: true URN Example true true
//! expect: true false true true false true
//! expect: true false true false ABC He_o
//! expect: true true
// `i` with `u` matches by simple case folding (ECMA-262 Canonicalize), across
// literals, classes, ranges and the word class, and captures keep the input's
// own text. fast-uri's `/^[\da-f]{2}$/iu`.
'use strict'
const urn = /^([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-./:;=@]|%[\da-f]{2})+)$/iu.exec('URN:Example') || []
console.log(/^[\da-f]{2}$/iu.test('Af'), urn[1], urn[2], /k/iu.test('K'), /\w/iu.test('ſ'))
console.log(/[a-z]/iu.test('K'), /[^a-z]/iu.test('K'), /σ/iu.test('ς'), /ß/iu.test('ẞ'), /i/iu.test('İ'), /ǆ/iu.test('ǅ'))
console.log(/[A-Z]/iu.test('ſ'), /\W/iu.test('ſ'), /^\u{10400}$/iu.test('\u{10428}'), /straße/iu.test('STRASSE'), ('xABCy'.match(/(abc)/iu) || [])[1], 'Hello'.replace(/L+/giu, '_'))
console.log(/😀/iu.test('😀'), /^[😀-😂]$/iu.test('😁'))
