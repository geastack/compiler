// The absent half of `iterate-absent-source.ts`, which has to be its own
// program because it dies.
//
// ECMA-262 7.4.2 `GetIterator` performs `GetMethod(obj, @@iterator)` and
// `GetMethod` (7.3.11) throws a `TypeError` when the base is `undefined` or
// `null`. So `for (const x of undefined)` is a RUNTIME throw in JavaScript,
// not a loop that runs zero times -- and this compiler's answer to a throw it
// has no representation for is to abort by name.
//
// This is the test that makes the presence assertion load-bearing rather than
// decorative. `gea::Optional<T>` always holds a CONSTRUCTED `T`, so the
// obvious spelling -- `*opt` at the cursor constructor -- compiles perfectly
// and walks a default-constructed, EMPTY container instead: the loop body runs
// zero times, the program prints nothing, and exits 0. That is a silently
// wrong answer where the language says throw, which is the one outcome this
// compiler will not produce. Without this file the difference between the two
// spellings is invisible.
//
// Contrast `for`-`in`, which is deliberately NOT given a presence assertion:
// ECMA-262 14.7.5.5 evaluates an absent enumerate source to a BREAK completion
// and the loop really does run zero times there.

const rows = new Map<string, string[]>()
rows.set('present', ['x'])

//! expect: before-the-walk
console.log('before-the-walk')

// Nothing was ever stored under this key, so `get` answers `undefined`.
const missing = rows.get('absent')
let joined = ''
// @ts-expect-error TS2488: iterating a possibly-absent value is legal JS
for (const row of missing) {
  joined += row
}

// Unreachable: the walk above must die before it gets here. If this line ever
// prints, the presence assertion was dropped and an absent source silently
// iterated an empty container.
console.log('after-the-walk=' + joined)

//! expect-abort
//! emitted-has: requireIterablePresent
