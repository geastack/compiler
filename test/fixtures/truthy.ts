// `ToBoolean`, which is what a condition actually tests.
//
// None of these guards is a boolean, and each has a different answer: an empty
// string is false and a non-empty one true; `0` and `NaN` are false and every
// other number true; an absent optional is false. C++'s own `if (x)` gets two
// of these wrong -- `NaN` converts to `true`, and `std::string` does not
// convert at all -- so the rule has to be written per carrier rather than
// borrowed from the target language.

const name: string = 'gea'
const count: number = 0

export const named: number = name ? 1 : 2
export const counted: number = count ? 3 : 4

export function describe(label: string, size: number, tag?: string): string {
  if (label) {
    return size ? label : 'empty'
  }
  // An optional parameter arrives as an optional carrier, and an absent one is
  // false -- so is a present-but-empty string, which is the case a bare
  // presence check would get wrong.
  return tag ? label : 'none'
}

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = describe('a', named + counted, undefined)
