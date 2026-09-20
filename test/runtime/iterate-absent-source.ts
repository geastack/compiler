// A `for`-`of` over a source that may be ABSENT.
//
// `Map.get` answers `V | undefined` (ECMA-262 24.1.3.6), and three.js iterates
// one directly -- `WebGLShaderCache.remove` does `for ( const shaderStage of
// this.materialCache.get( material ) )`. JavaScript's answer for the absent
// case is not "iterate nothing": ECMA-262 7.4.2 `GetIterator` performs
// `GetMethod(obj, @@iterator)`, and `GetMethod` on `undefined` throws a
// `TypeError`. So absence is a RUNTIME refusal, and the walk over a present
// payload is byte-for-byte the walk over a bare `V`.
//
// That is why the compiler routes such a source down the native cursor path
// (`producers/shared.ts`'s `presentIterationArm`) instead of demanding an
// `@@iterator` lookup it has no representation for. Before it did, every one
// of these refused at preflight on an unclaimed
// `protocol:iterator:get-method:optional` -- six of the three.js app's 84 unmet
// obligations, all of them this one shape.
//
// The absent half is `iterate-absent-source-aborts.ts`: it aborts, so it
// cannot share a program with anything that has to print.

const rows = new Map<string, string[]>()
rows.set('a', ['x', 'y', 'z'])

// The present payload. `gea::Optional<ArrayObject<...>>` always holds a
// CONSTRUCTED payload, so a bare `*opt` here would compile and quietly walk a
// default-constructed empty array for an absent source -- a wrong answer, not
// a crash. The presence assertion is what makes that impossible, and it must
// be in the emitted C++ rather than assumed.
//! emitted-has: requireIterablePresent
const present = rows.get('a')
let joined = ''
// `@ts-expect-error`, not a cast and not a `!`: TypeScript rejects iterating a
// possibly-absent value (TS2488) while JavaScript accepts the program and
// throws only if the value really is absent -- and three.js, being JS with no
// checkJs, writes exactly this. Suppressing the report leaves the TYPE alone,
// which is the whole point: a `!` or an `as` would hand the compiler a bare
// payload and test nothing. The directive also fails if the error ever stops
// being reported, so this stays honest about which language accepts what.
// @ts-expect-error TS2488: iterating a possibly-absent value is legal JS
for (const row of present) {
  joined += row
}
//! expect: joined=xyz
console.log('joined=' + joined)

// The same source through a Set, whose cursor is a different constructor over
// the same one presence assertion.
const tags = new Map<string, Set<string>>()
tags.set('k', new Set<string>(['p', 'q']))
const seen = tags.get('k')
let count = 0
// @ts-expect-error TS2488: iterating a possibly-absent value is legal JS
for (const tag of seen) {
  count += tag.length
}
//! expect: count=2
console.log('count=' + count)

// No dynamic `@@iterator` lookup was minted for either loop: the whole point
// is that the payload's own native cursor serves an absent source too.
//! emitted-lacks: Symbol.iterator
