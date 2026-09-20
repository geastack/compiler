//! expect: 5
//! expect: true false
//! expect: 2

// `new Set(iterable)` over a STRING iterates it by code point (ECMA-262
// 22.1.5.1), so this holds one-character strings -- the form Hono's
// RegExpRouter writes its metacharacter set in.
const metaChars = new Set('.+*[]')
console.log(metaChars.size)
console.log(metaChars.has('*'), metaChars.has('x'))

// An astral code point is ONE element, not two surrogate halves.
const astral = new Set('a\u{1F600}')
console.log(astral.size)
