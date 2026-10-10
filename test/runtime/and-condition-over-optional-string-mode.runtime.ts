// `mode && typeof mode === 'string'` AS AN `if` CONDITION OVER `string | undefined`.
//
// A database client's read-preference `fromOptions` computes
// `const mode = readPreference.mode || readPreference.preference` (both
// optional mode literals, none of them `''`) and tests
// `if (mode && typeof mode === 'string')`. The `&&` keeps its left operand
// only when that is falsy, which for a non-empty literal union is `undefined`
// alone, so the whole expression is `boolean | undefined`; otherwise it yields
// the `typeof` test's boolean.

type Mode = 'primary' | 'secondary' | 'nearest'

interface PreferenceLike {
  mode?: Mode
  preference?: Mode
}

function modeOf(readPreference: PreferenceLike): string {
  const mode = readPreference.mode || readPreference.preference
  if (mode && typeof mode === 'string') {
    return `mode:${mode}`
  }
  return 'none'
}

//! expect: primary=mode:primary preference=mode:nearest missing=none
console.log(`primary=${modeOf({ mode: 'primary' })} preference=${modeOf({ preference: 'nearest' })} missing=${modeOf({})}`)
