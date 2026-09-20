// A bare identifier reused as a for-of/for-in loop's own head -- declared
// OUTSIDE the loop with no `var`/`let`/`const` of its own, unlike `for (const
// v of xs)` (already native via `local-bindings.ts`'s `forOfElementType`) and
// unlike a literal pattern head (`for-of-literal-pattern-head.ts`, already
// native via `forOfPatternElementTypeAt`) -- boxed on TWO separate axes before
// this fix:
//
//  - `value-flow.ts` records this write as an 'iteration-binding' edge with
//    `value: null`; `local-bindings.ts`'s `identifierWritesOf` had no case
//    for it, so the census found no evidence and the cell stayed `any`
//    (`forOfBareIdentifierElementTypeAt` is the fix).
//  - even once the census answers `double`, nothing ever STORED the loop's
//    per-iteration value into the identifier's cell: `census.ts` classified
//    this identifier as an ordinary value READ (`isValueReference`'s default
//    rule), and no producer modelled the write ECMA-262's `PutValue` performs
//    here. `gating.ts` already reserved the correct once-per-iteration scope
//    for it (its own comment names "a bare assignment target" as a shape
//    `node.initializer` can take) -- there was simply no producer publishing
//    into it. `isForOfLoopHeadWriteTarget` (census.ts) routes the identifier
//    to the `binding` family, and `contributeForOfLoopHeadWrite`
//    (producers/bindings.ts) is the producer, modelled as a `write`
//    `BindingOperation` resolved by SYMBOL (never minting a fresh
//    declaration) so the store lands in the same cell `var v` itself owns.
//
// Left deliberately unannotated -- an explicit type would answer the census
// on its own and never exercise either fix.

var xs = [1, 2, 3]
var sum = 0
var v
for (v of xs) {
  sum += v
}
//! expect: 6
//! emitted-has: double gea_global_decl
//! emitted-lacks: gea::Value
console.log(sum)

var dictionary: { [key: string]: number } = { a: 1, b: 2, c: 3 }
var keys = ''
var k
for (k in dictionary) {
  keys += k
}
//! expect: abc
console.log(keys)
