// @ts-nocheck
//! expect: 1 undefined
//! expect: 2 4
//! expect: object false object true
//! expect: undefined undefined
//! expect: function 3 2
//! expect: undefined

// The native field table's read hook groups its plain data fields by the
// carrier they box into, so a struct spends one `gea::Value` construction per
// carrier rather than one per field. This program pins the three carriers whose
// recipe is a CONDITIONAL rather than a tag and a cast -- the shapes the first
// grouping pass had to leave alone:
//
//   * an OPTIONAL payload, whose recipe boxes the value or `undefined`. Two
//     such fields in one group must not answer each other's presence: `left`
//     holds a number where `right` holds nothing, on the same instance.
//   * a UNION of `undefined | null | object`, whose recipe boxes one of three
//     arms. All three arms are exercised across two instances, so a group that
//     picked an arm once for the whole chain would be caught. The arms are
//     told apart by `typeof` and an identity compare rather than by text: a
//     record literal has no prototype object in the model, so asking one for
//     a string is a `Cannot convert object to primitive value` throw and not
//     the fact under test.
//   * a CALLABLE, whose recipe is not a tag at all but a choice among
//     `gea::Value::box`, `boxCallable` and `boxMethod`. Two callable fields
//     sharing a signature share a group, and each must still come back as its
//     own function. Both subtract, deliberately: `by + 1` over a dynamic
//     operand answers a `gea::Value` where `by - 1` answers a `double`, so
//     adding in one of them would spell two representations and split the
//     group this line exists to exercise.
//
// The trailing miss is the other half of grouping: a name no branch matched
// must leave the slot empty and fall out of the block, never answer the last
// field the chain happened to look at.

class Slot {
  constructor(n) {
    this.left = n > 0 ? n : undefined
    this.right = n > 1 ? n * 2 : undefined
    this.map = n > 2 ? undefined : n > 0 ? { tag: 'm' } : null
    this.other = n > 2 ? undefined : n > 1 ? { tag: 'o' } : null
    this.grow = (by) => by - 1
    this.shrink = (by) => by - 2
  }
}

const read = (slot, key) => slot[key]

const a = new Slot(1)
const b = new Slot(2)
const c = new Slot(3)

console.log(String(read(a, 'left')), String(read(a, 'right')))
console.log(String(read(b, 'left')), String(read(b, 'right')))
console.log(typeof read(a, 'map'), read(a, 'map') === null, typeof read(a, 'other'), read(a, 'other') === null)
console.log(typeof read(c, 'map'), typeof read(c, 'other'))
console.log(typeof read(a, 'grow'), read(a, 'grow')(4), read(a, 'shrink')(4))
console.log(String(read(a, 'missing')))
