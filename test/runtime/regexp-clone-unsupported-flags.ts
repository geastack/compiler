export {}

// `requireSupportedPatternFlags` refuses only the flag this backend genuinely
// cannot answer: `v`, which needs a UnicodeSets grammar and set-string
// operands. `u` and `u` WITH `i` are implemented (`unicodeIgnoreCaseSource`
// states the simple case folding in the source), so this program pins that
// the refusal still fails closed and that the two accepted flag sets are
// actually IMPLEMENTED rather than merely no longer rejected. A flag that is
// accepted and then ignored would pass a "does it throw" test and be wrong.
const source = /a/

let unicodeSetsFailedClosed = false
try {
  new RegExp(source, 'v')
} catch {
  unicodeSetsFailedClosed = true
}

// U+212A KELVIN SIGN folds to `k` only under `/iu`; `/i` alone leaves it apart.
const unicodeIgnoreCase = new RegExp(/k/, 'ui')
const kelvin = String.fromCharCode(0x212a)

// The whole point of `u`: `.` is one code POINT, so an astral character
// matches whole rather than as its leading surrogate.
const unicodeDot = new RegExp('.', 'u')
const astral = unicodeDot.exec('😀')

console.log(
  `${unicodeSetsFailedClosed}|${unicodeIgnoreCase.test(kelvin)}|${new RegExp(/k/, 'i').test(kelvin)}|${unicodeDot.unicode}|${astral?.[0].length}`
)

//! expect: true|true|false|true|2
