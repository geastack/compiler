//! expect: total 20
// A FUNCTION LITERAL whose contextual type is a UNION, pinned on its own.
//
// `rest-parameter-union-of-tuples.ts` was refused for this and not for its rest
// parameter: `() => ({ onOpen: () => 7 })` against `Make | Ctx | Events |
// number` inferred an ANONYMOUS record for the arrow's result while the arm
// names `Events` -- the same shape under two identities. A value only widens
// into a union by already BEING one of its arms, so certification refused both
// the widening of the callable into the tagged union and the store of the
// body's `Events` into the arrow's own record slot. The identical arrow written
// `(): Events => ...` always certified, which is what named the arrow's RESULT
// as the one slot in disagreement.
//
// Written with no rest parameter, no assertion and no destructuring on purpose:
// the rest-parameter fixture merely exposed this, and none of those three is
// part of the defect.
interface Ctx {
  readonly path: string
}
interface Events {
  readonly onOpen: (c: Ctx) => number
}
type Make = (c: Ctx) => Events

const here: Ctx = { path: '/made' }
const entries: (Make | Ctx | Events | number)[] = [() => ({ onOpen: () => 7 }), { path: '/direct' }, { onOpen: () => 4 }, 2]

let total = 0
for (const entry of entries) {
  if (typeof entry === 'number') total = total + entry
  else if (typeof entry === 'function') total = total + entry(here).onOpen(here)
  else if ('onOpen' in entry) total = total + entry.onOpen(here)
  else total = total + entry.path.length
}
console.log('total', total)
