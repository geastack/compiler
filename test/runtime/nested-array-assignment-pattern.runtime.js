// @ts-nocheck
// A NESTED array-literal ASSIGNMENT pattern whose inner element's checker
// type is not a tuple used to refuse certification entirely:
// `var row = [1, [2, 3]]; var a, b, c; [a, [b, c]] = row` raised
// `runtime-helper:destructuring:array-pattern:optional is missing` at both
// inner positions and never minted a certificate. `// @ts-nocheck` is load
// -bearing here, not decorative: under this project's `noUncheckedIndexedAccess`,
// destructuring a non-tuple array's element adds `| undefined` to the type TS
// itself reports for the pattern, which real tsc then refuses outright before
// geatsc's own semantics ever run. `// @ts-nocheck` suppresses that
// reporting without changing what the checker APIs geatsc reads return -- the
// same reason the task's own repro needed it, and why this is a `.runtime.js`
// file rather than a plain `.ts` one (see `borrowed-builtin-call-bind.runtime.js`
// for the same convention).
//
// Root cause was three gaps stacked on top of each other:
//
//   1. `producers/destructuring.ts`'s `extractedArrayAssignmentTypeOf` only
//      knew how to type a nested pattern's own positions when the enclosing
//      position's structural shape was directly `tuple` or `array`. Here it
//      is `union` (`row`'s element is `number|number[]`, since `row` itself
//      has no tuple type), so the nested `[b, c]` pattern fell through to the
//      identifier's own bound type -- `any` for an untyped `var` -- instead
//      of the union's sole array/tuple-shaped member. Fixed by
//      `soleArrayPatternCapableMember`/`flattenedUnionMembers`: when the
//      enclosing shape is a union, recurse into whichever single member is
//      itself array- or tuple-shaped.
//
//   2. Even once typed, the nested pattern's SOURCE resolves to
//      `Optional<TaggedUnion<number, ArrayObject<number>>>` (position 1 of
//      `row`, read through the shared iterator-record step) -- and nothing
//      published a representation for the array-pattern's source step that
//      accounted for either the `Optional` wrapper or a tagged-union with a
//      non-iterable arm. `representation/publish.ts`'s new `patternSourceArmOf`
//      override unwraps the `Optional` and, when a tagged-union has exactly
//      one array/tuple-capable arm, publishes that arm directly -- mirroring
//      the existing `patternSourceSnapshotOf` override for a `Set`/`string`
//      source.
//
//   3. Publishing the narrower representation only makes the TYPE line up;
//      the VALUE still has to be unwrapped and arm-checked at runtime. Two
//      new IR compute forms close this: `require-iterable-present`
//      (`gea::detail::requireIterablePresent`, already used by the general
//      for-of protocol for an absent optional) and `require-tagged-union-arm`
//      (a new `.is<N>()` guard plus `.get<N>()`, aborting via the new
//      `gea::detail::refuseTaggedUnionArmMismatch` runtime helper on a
//      mismatch -- which cannot happen for a checker-sound program, but a
//      guard that can never fire is still cheaper than one that is silently
//      absent). `ir/lower-destructuring.ts`'s `lowerArrayPatternSource` emits
//      both, in ECMA-262 GetIterator order: presence, then shape.
//
// `a` (the pattern's own OUTER, non-nested position) is untouched by any of
// this -- it reads position 0 of `row` exactly as it did before, and its own
// checker type is still the genuine union `number|number[]`, so it stays a
// `TaggedUnion<number, ArrayObject<number>>` rather than narrowing to a bare
// number. Adding it to `b + c` (both now plain narrowed `number`s, thanks to
// fix #1) mixes a `tagged-union` carrier with a `scalar` one, which is a
// SEPARATE, pre-existing requirement of `+`'s own mixed-carrier dispatch
// (`targets/cpp/emit.ts`) -- unrelated to destructuring, and reproduces
// identically for the single-level, non-nested sibling pattern
// (`[a, b] = row; a + 1`) that already compiled before this fix. That is why
// this file needs `--dynamic-fallback`, and why the directive travels with
// the file rather than being papered over by writing `b + c` instead of
// `a + b + c` -- this IS the task's own exact repro.
//! dynamic-fallback
var row = [1, [2, 3]]
var a, b, c
;[a, [b, c]] = row
//! expect: 6
console.log(a + b + c)

// The same fix without the pre-existing `+`-over-union wrinkle: a nested
// pattern over a plain array-of-arrays (no tagged-union arm to pick, only the
// `Optional` wrapper to unwrap) exercises `require-iterable-present` alone.
// `[, [b2, c2]]` also pins that a leading elision is not itself an
// obligation.
var rows = [
  [1, 2],
  [3, 4]
]
var b2, c2
;[, [b2, c2]] = rows
//! expect: 7
console.log(b2 + c2)

// A LITERAL source (`[1, [2, 3]]` typed directly as a tuple by the checker)
// was never broken -- this is the regression guard for that sibling path,
// which must stay on the plain tuple carrier and never touch either new IR
// form.
var d, e, f
;[d, [e, f]] = [1, [2, 3]]
//! expect: 6
console.log(d + e + f)

// The defect reproduced identically for a `for...of` loop head, not just a
// plain `=` assignment (`arrayAssignmentSourceInfo` and
// `contributeArrayAssignmentPattern` serve both the same way) -- two
// iterations agreeing into the same cells, over a source with no tuple type.
var g, h
var pairs = [
  [1, [2, 3]],
  [4, [5, 6]]
]
for (const pair of pairs) {
  ;[, [g, h]] = pair
  //! expect: 5
  //! expect: 11
  console.log(g + h)
}

// Shape pin: both new IR forms actually fire, not merely happen to have
// somewhere else to go. The bare `requireIterablePresent` (no arm guard
// beside it) is `rows`' plain-array nested read; the guarded
// `.is<1>() ... refuseTaggedUnionArmMismatch` pair is `row`'s tagged-union
// one. Losing either line back to silence is the regression this file
// exists to catch.
//! emitted-has: gea::detail::requireIterablePresent
//! emitted-has: gea::detail::refuseTaggedUnionArmMismatch
