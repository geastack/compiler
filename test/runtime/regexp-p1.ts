//! expect: a+|im|plain|ab|gi|my|true|ab|gi|5|users|2|3

// Fourth field corrected against real node: `ab`, not `/ab/gi`. Clearing
// `@@match` on a genuine RegExp does NOT push `new RegExp(it)` onto the
// ToString path. 22.2.4.1 tests the [[RegExpMatcher]] INTERNAL SLOT before it
// ever consults `patternIsRegExp`, so a real RegExp always contributes its own
// [[OriginalSource]]; `@@match` only decides the question for objects that are
// not RegExps (which is what `regexLike` and `stringLike` above test).
//
// The three capabilities this fixture demanded are now implemented, each in
// the one place that already owned the decision:
//
//  - `regexLike` has a truthy `@@match` and no [[RegExpMatcher]], so 22.2.4.1
//    step 6 reads `.source` and `.flags` off the object. `{[Symbol.match]:
//    true}` widens the member to `boolean`, so nothing proves the branch
//    statically -- both step 6 and step 7 are rendered and the conditional
//    picks one at run time (`emit-prototype-regexp.ts`).
//  - `stringLike` needs ToString of an object with a user-defined `toString`.
//    That is NOT a dynamic boundary: the shape declares the method, its
//    carrier states the exact convention, and OrdinaryToPrimitive's first
//    method name is an ordinary indirect call through the struct member
//    (`emit-tostring.ts`). Boxing the record to reach it would have been the
//    forbidden shortcut.
//  - `fromDisabled` is the fourth field above: the runtime's dynamic
//    constructor tested `IsRegExp` where 22.2.4.1 step 5 tests the internal
//    slot, so a real RegExp with `@@match` cleared took the ToString path and
//    answered `/ab/gi`.

const regexLike = { [Symbol.match]: true, source: 'a+', flags: 'mi' }
const fromRegexLike = new RegExp(regexLike as any)

const stringLike = {
  [Symbol.match]: false,
  source: 'ignored',
  toString() {
    return 'plain'
  }
}
const fromStringLike = new RegExp(stringLike as any)

const original = new RegExp('ab', 'ig')
original.lastIndex = 7
const clone = new RegExp(original)
const overrideClone = new RegExp(original, 'ym')

const disabled: any = /ab/gi
disabled[Symbol.match] = false
const fromDisabled = new RegExp(disabled)

const guarded = /ab/gi
// `source` and `flags` are accessors on RegExp.prototype with no setter, so a
// write to either is rejected. There used to be a `sloppyReadonlyWrite` here
// asserting the silent no-op beside this one, and there is no such contrast to
// draw: this file is an ES module and an ES module is strict IN ITS ENTIRETY
// (11.2.2), so both halves ran under the same strict semantics and the
// "sloppy" one threw at its first call -- killing the program at module
// evaluation, before the single `console.log` below. Every expectation this
// fixture states was therefore unreachable, under any compiler.
//
// The `'use strict'` directive below is likewise redundant for the same
// reason. It is kept only because deleting it would read as a semantic change,
// and it is exactly what made the vanished contrast look deliberate.
function strictReadonlyWrite(key: string): boolean {
  'use strict'
  try {
    ;(guarded as any)[key] = 'mutated'
    return false
  } catch {
    return true
  }
}
const strictRejected = strictReadonlyWrite('source') && strictReadonlyWrite('flags')

const lastIndexKey = 'lastIndex'
;(guarded as any)[lastIndexKey] = 5
const expandoKey = 'route'
;(guarded as any)[expandoKey] = 'users'

const astral = /x/g
const astralMatch = astral.exec('😀x')!

console.log(
  `${fromRegexLike.source}|${fromRegexLike.flags}|${fromStringLike.source}|${fromDisabled.source}|` +
    `${clone.flags}|${overrideClone.flags}|${strictRejected}|${guarded.source}|${guarded.flags}|` +
    `${guarded.lastIndex}|${(guarded as any)[expandoKey]}|${astralMatch.index}|${astral.lastIndex}`
)
