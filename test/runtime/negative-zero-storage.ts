//! expect: reciprocal class=-Infinity|local=-Infinity|record=-Infinity|parameter=-Infinity
//! expect: sameValue class=true|local=true|record=true|parameter=true
//! expect: plusZero 1/x=Infinity|is(-0)=false

// `-0` is a value a narrowed slot cannot carry.
//
// ECMA-262 distinguishes the two zeroes: `Object.is(-0, 0)` is false and
// `1 / -0` is `-Infinity`. Two's complement does not -- a `long long` has one
// zero -- so the integer-storage census must refuse a negative zero the same
// way it refuses a non-integral value. It did not: `-0` is an integer by every
// arithmetic test (`Number.isSafeInteger(-0)` is true, `-0 === 0`), so it
// passed the lattice and every carrier below took `long long` and answered
// `+0`.
//
// The hole was one place -- the unary-negation case in `narrowableIntegersOf`
// -- and therefore identical for all four kinds of storage the census settles.
// A class field is where it was first seen (writing
// `class-field-default-value-initializer.ts`, which needed a non-default
// numeric to prove a store survives and chose `-0`); the local, the record
// field and the formal are here because one predicate answers for all of them
// and a fix at that predicate must be pinned at each.
//
// `plusZero` is the other side of the refusal: `+0` must still narrow and must
// still answer `Infinity`, so a fix that simply stopped narrowing zero would
// not pass this file either.

class Holder {
  value = -0
}

const local = -0

interface Point {
  z: number
}
const record: Point = { z: -0 }

const throughParameter = (n: number): number => n

const readings: number[] = [new Holder().value, local, record.z, throughParameter(-0)]
const labels: string[] = ['class', 'local', 'record', 'parameter']

let reciprocals = ''
let sameValues = ''
for (let at = 0; at < labels.length; at = at + 1) {
  const label = labels[at]!
  const reading: number = readings[at]!
  reciprocals = reciprocals + (at === 0 ? '' : '|') + label + '=' + String(1 / reading)
  sameValues = sameValues + (at === 0 ? '' : '|') + label + '=' + String(Object.is(reading, -0))
}

console.log('reciprocal ' + reciprocals)
console.log('sameValue ' + sameValues)

const plusZero = 0
console.log('plusZero 1/x=' + String(1 / plusZero) + '|is(-0)=' + String(Object.is(plusZero, -0)))
