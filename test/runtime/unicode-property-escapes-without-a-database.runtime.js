// @ts-nocheck
//! expect: false true true
//! expect: true false
//! expect: a-b
// fast-uri's `/\P{ASCII}/u`: the binary properties that are fixed code-point
// ranges need no Unicode Character Database.
const nonAscii = /\P{ASCII}/u
console.log(nonAscii.test('host.example'), nonAscii.test('héte'), nonAscii.test('\u{1F600}'))
console.log(/^[\p{ASCII_Hex_Digit}]+$/u.test('C0ffee'), /^\p{ASCII}+$/u.test('café'))
console.log('aéb'.replace(/[^\p{ASCII}]/gu, '-'))
