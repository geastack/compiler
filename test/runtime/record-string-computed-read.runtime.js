// @ts-nocheck
//! expect: alpha-value beta-value undefined
//! expect: undefined undefined undefined
//! expect: alpha-value beta-value gamma-value

// A closed data record read with a key whose type is plain `string`.
//
// Its arms are bounded by the RECEIVER, exactly as a numeric key's already
// were: the key can name any field or none, so the read is a switch over the
// record's own fields with a sealed absence arm. What the certificate replaces
// is `gea_readOwnField` -- an OWN-property read over a record that has no
// prototype object in the model -- so a key naming no field answers
// `undefined` on both routes, and a key spelling an `Object.prototype` member
// is just another miss. The second line is the whole point: these are the keys
// a prototype walk would have answered, and this program must not answer them.

const chunks = {
  alpha: 'alpha-value',
  beta: 'beta-value',
  gamma: 'gamma-value'
}

const read = (key) => chunks[key]

console.log(read('alpha'), read('beta'), read('missing'))
console.log(read('toString'), read('hasOwnProperty'), read('constructor'))

// The same read reached through `for...in`, whose key is published as `string`
// by the `for-in-key-is-a-string` rule -- the shape that made this the common
// case rather than an exotic one.
const seen = []
for (const key in chunks) seen.push(chunks[key])
console.log(seen[0], seen[1], seen[2])
