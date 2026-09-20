// A REST target of an array-destructuring ASSIGNMENT into a bare, previously
// untyped `var`/`let` (`var a, r; [a, ...r] = [1, 2, 3]`) used to lower `r`'s
// global to a boxed `gea::Value`: `local-bindings.ts`'s `identifierWritesOf`
// can recover a real backing expression for every OTHER destructured position
// (the array-literal element at the same index), but a rest target has no
// single sub-expression that states "the remaining elements" and no public
// checker API synthesizes a `T[]` `ts.Type` to ask about instead.
// `structural.ts`'s `restAssignmentArrayShapeAt` closes the gap at the
// structural level: a rest capture over an `array`-shaped source is that same
// array shape, so this interns the source's own resolved carrier directly,
// mirroring how `arrayPatternRestTypeAt` already does this one node shape
// over (a `var [x, ...rest] = ...` DECLARATION pattern rather than an
// assignment into a pre-declared bare cell).
//
// Each `//! expect:` line is its own substring check against the whole run's
// stdout (`run-runtime-tests.mjs`), never a single line's own text.
var a, r
;[a, ...r] = [1, 2, 3]
//! expect: 1 2 2 3
console.log(a, r.length, r[0], r[1])

// The element carrier generalizes past `number` -- the whole point of fixing
// this at the structural level rather than special-casing one primitive.
var s, t
;[s, ...t] = ['x', 'y']
//! expect: 1 y
console.log(t.length, t[0])

// A rest target fed by a NON-LITERAL source (a `for...of` loop body) --
// `local-bindings.ts`'s own bare-position recovery requires a literal source
// to index into, but `restAssignmentArrayShapeAt` asks only for the source's
// own resolved shape, so it answers here where the bare-position sibling fix
// cannot. Two agreeing rest writes (one per iteration) into the SAME cell,
// both over a `number[]` source -- the multi-write agreement path.
var head, tail
const rows: number[][] = [
  [1, 2, 3],
  [4, 5, 6]
]
for (const row of rows) {
  ;[head, ...tail] = row
  //! expect: 1 2 2 3
  //! expect: 4 2 5 6
  console.log(head, tail.length, tail[0], tail[1])
}

// `gea_global_decl` is this compiler's own naming scheme for a module-level
// cell; asserting the shape by name pins that the rest targets above landed
// as a native array carrier rather than a boxed `gea::Value` -- the defect
// this file exists to catch a regression of. (`head`, the bare non-rest
// position read out of the `for...of` loop above, is a SEPARATE, pre-existing
// gap -- its own evidence recovery needs a literal source to index into,
// which a loop variable is not -- and stays boxed; not this fix's to close.)
//! emitted-has: gea::Ref<gea::ArrayObject<double>> gea_global_decl
//! emitted-has: gea::Ref<gea::ArrayObject<std::string>> gea_global_decl
