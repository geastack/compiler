// A database client's `ReadPreference.isValid` as written: the literal's elements are
// MUTABLE static fields holding a frozen enum object's string-literal members,
// the key type is that literal union plus `null`, and the subject is a plain
// `string` asserted into it. The Set is still only asked `.has()`, so it is
// still a membership test over the elements as they read when the literal ran.
'use strict'
const Mode = Object.freeze({
  primary: 'primary',
  primaryPreferred: 'primaryPreferred',
  secondaryPreferred: 'secondaryPreferred',
  nearest: 'nearest'
} as const)
type Mode = (typeof Mode)[keyof typeof Mode]

class Preference {
  public static PRIMARY = Mode.primary
  public static PRIMARY_PREFERRED = Mode.primaryPreferred
  public static SECONDARY_PREFERRED = Mode.secondaryPreferred
  public static NEAREST = Mode.nearest

  static isValid(mode: string): boolean {
    const VALID_MODES = new Set([
      Preference.PRIMARY,
      Preference.PRIMARY_PREFERRED,
      Preference.SECONDARY_PREFERRED,
      Preference.NEAREST,
      null
    ])
    return VALID_MODES.has(mode as Mode)
  }
}

console.log(Preference.isValid('primaryPreferred'), Preference.isValid('secondary'), Preference.isValid('nearest'))
console.log(Preference.isValid('primary'), Preference.isValid(''))
//! expect: true false true
//! expect: true false
export {}
