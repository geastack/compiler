// A record whose layout is SPLIT: named fields in the struct, index-signature
// keys in a `gea::Dictionary`/`gea::NumericDictionary` sidecar beside them
// (`targets/cpp/records.ts`). Both halves are written by the same object
// literal and read back by the same member syntax, and only running the
// program says the two halves stayed apart.
//
// The defect this catches: a CONSTANT key naming no declared field fell
// through every branch of `emitFieldStoreLines` to the generic struct-member
// write and spelled `receiver->gea_slot_0`, a member the struct never declared
// -- caught by clang here, but the same shape with a key that happens to be
// identifier-shaped would have spelled a member that DOES exist on some other
// shape. The read side had routed to the sidecar since it was written, so a
// store that landed anywhere else is a value the read can never find.
//
// Every line below is checked against node's own output for this file.
interface Mixed {
  count: number
  [index: number]: string
}

const m: Mixed = { count: 2, 0: 'zero', 1: 'one' }

//! expect: named=2
console.log('named=' + m.count)

//! expect: indexed=zero,one
console.log('indexed=' + m[0] + ',' + m[1])

// A store after construction lands where the literal's own members landed.
m[2] = 'two'

//! expect: written=two
console.log('written=' + m[2])

// ...and leaves the named half exactly as it was. The two halves are different
// storage, so a store into one that reached the other would show here.
//! expect: still-named=2
console.log('still-named=' + m.count)

// The string-keyed sibling of the same split: `gea::Dictionary<double>` rather
// than `gea::NumericDictionary<std::string>`, reached by the identical path.
interface Styled {
  width: number
  [key: string]: number
}

const s: Styled = { width: 3, height: 4 }

//! expect: styled=3/4
console.log('styled=' + s.width + '/' + s['height'])

// A key written through the sidecar reads back through it, and the named field
// declared beside it is still the struct member -- not a second sidecar entry
// shadowing it.
s['depth'] = 5

//! expect: styled-written=5/3
console.log('styled-written=' + s['depth'] + '/' + s.width)

// A computed PropertyKey union dispatches through the same string-keyed
// sidecar. Numbers use ECMAScript's numeric ToString spelling; string keys
// remain unchanged.
function readStyled(target: Styled, key: string | number): number | undefined {
  return target[key]
}

function writeStyled(target: Styled, key: string | number, value: number): void {
  target[key] = value
}

writeStyled(s, 6, 9)

//! expect: union-key=4/9
console.log('union-key=' + readStyled(s, 'height') + '/' + readStyled(s, 6))
