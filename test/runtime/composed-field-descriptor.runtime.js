// @ts-nocheck
//! expect: 1 true true true
//! expect: kept true true true
//! expect: undefined
//! expect: 1 kept 2
//! expect: a,label,locked

// `gea_ownFieldDescriptor` used to render one boxing expression per field --
// the very expression `gea_readOwnField` renders for that same field -- so
// every fixed field of every UNRESTRICTED carrier was boxed twice, and the
// descriptor half was half of all reflection boxing in the program.
//
// It is composed from the read hook now: a chain of plain bools decides
// presence and the three attribute bits, and one `gea::Value` per struct
// carries the value. No answer may change, so this asks for every part of a
// descriptor the per-field body used to supply: the value, all three
// attributes, an absent key, a field whose attributes were redefined away from
// the defaults, the values read back through the ordinary route, and the
// enumerable key set.
//
// The computed read is load-bearing: it is what leaves this carrier
// unrestricted, which is exactly the case the composition covers. A carrier
// with a SEALED per-field demand keeps the per-field rendering, because there a
// key can be demanded for `descriptor` and not for `read`.

var record = { a: 1, label: 'kept', locked: 2 }

var readByKey = function (key) {
  return record[key]
}

var describe = function (key) {
  var d = Object.getOwnPropertyDescriptor(record, key)
  return d === undefined ? 'undefined' : d.value + ' ' + d.writable + ' ' + d.enumerable + ' ' + d.configurable
}

console.log(describe('a'))
console.log(describe('label'))
console.log(describe('missing'))

// A field moved off the defaults is covered by
// `static-property-descriptors.runtime.js`, which redefines one through the
// same hooks; redefining an EXISTING fixed field is refused by the emitter for
// its own reasons and is not what this program is about.

// The values themselves still read through the ordinary route, including the
// computed one that made this carrier unrestricted in the first place.
console.log(readByKey('a'), readByKey('label'), readByKey('locked'))

console.log(Object.keys(record).join(','))
