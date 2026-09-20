// `for`-`of` over a receiver whose carrier NAMES its layout.
//
// The general iterator protocol -- `receiver[Symbol.iterator]()` called through
// the method the `get-method` step resolved -- was claimed for `class-ref` and
// the structural `record` only. `emitDynamicGetIterator` never looks at the
// receiver's kind (it calls the resolved `function-value-dispatch` operand and
// nothing else), so the render was already general; only the claim was not, and
// 26 of the mongodb probe's obligations were two rows of it per site.
//
// The refinement `record` gets comes with it rather than after it. A `record`
// with no discoverable `@@iterator` FIELD -- an open tuple spread through its
// inherited `Array.prototype[Symbol.iterator]` -- is kept off the claimed key
// and refused by name, because there is no struct member to read. A named shape
// can be missing the member the same way, so it is refined the same way; the
// certify-then-crash that refinement exists to prevent was never specific to
// structural records.
// STATUS: this fixture does NOT pass yet, and it is checked in as the exact
// reproduction of what remains. With the claim above landed it now CERTIFIES
// (it used to be refused by name as `native-record-ref(no-iterator-method)`)
// and refuses one step later, at emission:
//
//   "property": field "sym(...)" is stored as
//   function-value-dispatch(() -> native-record-ref(IterableIterator<number>))
//   and this read publishes
//   function-value-dispatch(() -> record({ next })); no narrowing between those
//   is licensed
//
// Two authorities disagree about one member. The receiver's declared FIELD
// carries the return type the source WROTE DOWN (`IterableIterator<number>`),
// while `producers/protocol.ts`'s `iteratorMethodAndRecordTypes` fabricates the
// synthetic ECMA-262 `{ next(): { value, done } }` shape for the very same
// call. The fabricator is the wrong one -- it exists for sources whose return
// type this compiler cannot see, and here it can.
//
// Citing the checker instead was tried and reverted in the same session, with
// the result measured rather than guessed: `generatorRecordTypeOf` returning
// the resolved type unconditionally (instead of only when it is a `Generator`)
// clears the property disagreement and lands one step further on, at
// `iterator-next` -- because the real `IterableIterator<T>.next()` returns
// `IteratorResult<T, TReturn>`, a TAGGED UNION of
// `{ done: boolean, value: dynamic }` and a named `IteratorReturnResult`, and
// no step of this protocol reads a field off a union today. Reading `value`
// off it is sound only as "the yield arm's value, else a default" (ECMA-262
// never lets a `for`-`of` body observe `value` when `done` is true), and
// reading `done` needs the same per-arm dispatch. That is the actual remaining
// work, and it is a real capability rather than a patch: `gea::TaggedUnion`
// already carries `index()`/`is<I>()`/`get<I>()` to render it with.
//
// What is NOT the answer: licensing the narrowing between the fabricated shape
// and the stated one. That patches the consumer and leaves the two authorities
// disagreeing.
interface NumberBag {
  values: number[]
  [Symbol.iterator](): IterableIterator<number>
}

const bag: NumberBag = {
  values: [3, 4, 5],
  *[Symbol.iterator]() {
    for (const value of this.values) yield value
  }
}

let probe = 0
for (const value of bag) probe += value

export const result = probe

if (probe !== 12) throw new Error('iteration over a named shape computed the wrong result')
