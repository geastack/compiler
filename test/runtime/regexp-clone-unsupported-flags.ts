export {}

// `u` is no longer among the unsupported flags: 568a30b5c landed Unicode
// RegExp sources, and `requireSupportedPatternFlags` now refuses only the two
// this backend genuinely cannot answer -- `v`, which needs a UnicodeSets
// grammar and set-string operands, and `u` WITH `i`, which needs the
// ECMAScript simple-case-folding table. This program pins all three: that the
// two refusals still fail closed, and that the one that stopped refusing is
// actually IMPLEMENTED rather than merely no longer rejected. A flag that is
// accepted and then ignored would pass a "does it throw" test and be wrong.
const source = /a/

let unicodeSetsFailedClosed = false
try {
  new RegExp(source, 'v')
} catch {
  unicodeSetsFailedClosed = true
}

let unicodeIgnoreCaseFailedClosed = false
try {
  new RegExp(source, 'ui')
} catch {
  unicodeIgnoreCaseFailedClosed = true
}

// The whole point of `u`: `.` is one code POINT, so an astral character
// matches whole rather than as its leading surrogate.
const unicodeDot = new RegExp('.', 'u')
const astral = unicodeDot.exec('😀')

console.log(`${unicodeSetsFailedClosed}|${unicodeIgnoreCaseFailedClosed}|${unicodeDot.unicode}|${astral?.[0].length}`)

//! expect: true|true|true|2
