// An array pattern over a non-array iterable reads what the source YIELDS,
// with `undefined` for every position the cursor is exhausted before -- the
// checker binds the name bare (`number`), and a bare cell read `0` for the
// missing second value. The same rule for a defaulted position (the default
// runs where the cursor is done) and for a Set, whose yield is its element.
//
// Each `//! expect:` line is its own substring check against the whole run's
// stdout (`run-runtime-tests.mjs`), never a single line's own text -- a
// combined header spanning all three `console.log` calls with plain spaces
// where the real output has newlines never matches, and silently stopped
// being checked at all.
function* g(): Generator<number> {
  yield 1
}
const [a, b] = g()
//! expect: 1 undefined
console.log(a, b)
const [c = 5, d = 10] = g()
//! expect: 5 10
console.log(c === 1 ? 5 : c, d)
const [e, f] = new Set<number>([2])
//! expect: 2 undefined
console.log(e, f)
