//! expect: 1 2
// An array pattern over a UNION of fixed-arity tuples. Every arm's shape is
// closed and known at compile time, so the position read needs no iterator --
// `ir/lower-destructuring.ts`'s `isTupleUnionCarrier` reads position `i` off
// whichever arm is live. The producer's gate said otherwise
// (`hasNativeIterationCursor` knew a lone tuple and a union of arrays, not a
// union of tuples), so the pattern minted the general iterator protocol and
// its element steps then read position 0 of the ITERATOR RECORD instead of
// the tuple.
type Pair = [number, string] | [number, boolean]

const pairs: Pair[] = [
  [1, 'a'],
  [2, true]
]
const firsts = pairs.map(([first]) => first)
console.log(firsts[0], firsts[1])
