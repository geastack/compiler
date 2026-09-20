// AN OBJECT LITERAL'S KEY ORDER COMES FROM THE LITERAL, NOT FROM THE CHECKER.
//
// `{ ...base, ...extra }` creates `base`'s keys first, then `extra`'s, and a
// key both objects carry keeps the position its FIRST insertion gave it.
// TypeScript's property table for that type reports `a2,a1` while the runtime
// creates `a1,a2`: the checker's property order is an authority on the TYPE and
// not on enumeration. Reading it as enumeration order produced a silent wrong
// answer -- it compiled, it ran, and `Object.keys` returned the wrong sequence
// with no refusal and no violation anywhere.
//
// It also cost a duplicate C++ struct. Member order is part of the structural
// interning key, so the same two members in two orders are two shapes with no
// conversion between them: `spreadThenOwn` below interned separately from `e2`
// before the fix and interns with it after.
//
// The three cases are the three ways a spread can meet an own key. Verified
// against node, which is the reference for enumeration order:
//
//   two            a1,a2      (spread, then a spread that rewrites both)
//   spreadThenOwn  k2,k1      (spread, then an own key the spread already set)
//
// The third way -- an own key FIRST and a spread that overwrites it after,
// `{ m1: 'z', ...e3 }` -- is verified the same way and is NOT in this file:
// TypeScript reports TS2783 ("specified more than once") for it, which this
// compiler records as a root diagnostic and refuses the certificate over. A
// fixture that cannot certify pins nothing. Before the fix it gave `m2,m1`
// against node's `m1,m2`; after, `m1,m2`.
//
// ⛔ Do NOT fix this by canonicalising member order in the interning key. The
// order is genuinely READ -- `targets/cpp/records.ts` writes the member list
// out as the object's `gea_ownFieldKeys` -- so sorting it changes `Object.keys`
// for every program in the corpus. The order belongs in the key and has to be
// correct at the source.

const b1 = { a1: 'x', a2: 1 }
const e1 = { a2: 2, a1: 'y' }
const two = { ...b1, ...e1 }

const e2 = { k2: 2, k1: 'y' }
const spreadThenOwn = { ...e2, k1: 'z' }

const plain = { p1: 'a', p2: 1, p3: 2 }

export const order = (): string =>
  Object.keys(two).join(',') + '|' + Object.keys(spreadThenOwn).join(',') + '|' + Object.keys(plain).join(',')

// Called at module scope so the bodies above are emitted rather than shaken
// away; see `ambient-global-guard.ts` for why a fixture that only declares
// proves nothing.
export const probe = order()
