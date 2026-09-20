// @ts-nocheck
//! expect: false 0  true
//! expect: undefined false
//! expect: 1 two true 4.5
//! expect: base-only derived
//! expect: undefined

// `gea_readOwnField` rendered `gea::Value::box(Tag::X, static_cast<T>(member))`
// once per field -- the same two-token recipe every time, differing only in
// which member it named. They are grouped by the carrier they box into now, so
// each distinct `(tag, type)` pair needs one construction site instead of one
// per field.
//
// The grouping introduces exactly two ways to be wrong, and this program is
// both of them.
//
// FALSY VALUES. The group selects a member into a local and then asks whether
// it selected one. If that question were asked of the VALUE, a `false`, a `0`
// and an empty string would each read as "no such field". It is asked of
// `std::optional`'s own emptiness instead.
//
// PRESENCE. A key that IS this struct's own but is not present must answer
// `undefined` immediately -- never fall through to a base that happens to
// declare the same name, which would answer the base's value instead.

class Base {
  constructor() {
    this.shared = 'base-only'
    this.tag = 'base'
  }
}

class Falsy extends Base {
  constructor() {
    super()
    this.no = false
    this.zero = 0
    this.empty = ''
    this.yes = true
    this.one = 1
    this.two = 'two'
    this.ratio = 4.5
    this.tag = 'derived'
  }
}

const value = new Falsy()

// The computed read is what leaves this carrier unrestricted, which is the
// case the grouped chain answers.
const readByKey = (key) => value[key]

console.log(readByKey('no'), readByKey('zero'), readByKey('empty'), readByKey('yes'))

// A key of this struct that is gone answers `undefined`, and the boolean group
// still answers a real `false` for its sibling.
delete value.no
console.log(readByKey('no'), readByKey('yes') === false ? 'wrong' : readByKey('yes') && false)

// Several groups in one carrier: number, string and double each box once, and
// which group holds a key must not depend on the order they were emitted in.
console.log(readByKey('one'), readByKey('two'), readByKey('yes'), readByKey('ratio'))

// A base field still reaches the base's own chain, and a derived field of the
// same name still shadows it.
console.log(readByKey('shared'), readByKey('tag'))

console.log(readByKey('missing'))
