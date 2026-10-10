// `table[s.charCodeAt(i)]` -- a binary-document library's hex and base64 lookup tables -- reads a
// typed array by a code unit that is already an integer; a record cache read
// by a `string | number` key (a database client's on-demand document `getElement`) spells
// an integer index as its digits without building the double's string. Both
// must agree with the plain answers: every ASCII digit, a code unit above the
// ASCII range, and the numbers whose key is NOT a plain digit run.
'use strict'
const nibbles = new Int8Array(256)
for (let c = 48; c <= 57; c++) nibbles[c] = c - 48
for (let c = 65; c <= 70; c++) nibbles[c] = c - 55
for (let c = 97; c <= 102; c++) nibbles[c] = c - 87
nibbles[233] = 77
const hex = (s: string): number => nibbles[s.charCodeAt(0)]! * 1000 + nibbles[s.charCodeAt(1)]! * 10 + nibbles[s.charCodeAt(2)]!
console.log(hex('0aF'), hex('9fe'), hex('é00'), hex('0é0'))

const cache: Record<string, string | undefined> = Object.create(null)
const store = (key: string | number, value: string): void => {
  cache[key] = value
}
const load = (key: string | number): string | undefined => cache[key]
store(0, 'zero')
store(7, 'seven')
store(12345, 'digits')
store(9007199254740991, 'max-safe')
store(9007199254740992, 'two-53')
store(1.5, 'fraction')
store(-3, 'negative')
store(1e21, 'exponent')
store('abc', 'name')
store('a-name-longer-than-the-inline-buffer-of-a-key-view', 'long')
console.log(load(0), load(7), load(12345), load(9007199254740991), load(9007199254740992))
console.log(load(1.5), load(-3), load(1e21), load('abc'), load('a-name-longer-than-the-inline-buffer-of-a-key-view'))
console.log(load(-0), load('0'), load('12345'), load('1.5'), load(2), load('missing'), load(0.1 + 0.2))
store(0.1 + 0.2, 'sum')
store(-1.7976931348623157e308, 'widest')
console.log(load('0.30000000000000004'), load(0.1 + 0.2), load(-1.7976931348623157e308), load('-1.7976931348623157e+308'))
//! expect: 115 9164 77000 770
//! expect: zero seven digits max-safe two-53
//! expect: fraction negative exponent name long
//! expect: zero zero digits fraction undefined undefined undefined
//! expect: sum sum widest widest
export {}
