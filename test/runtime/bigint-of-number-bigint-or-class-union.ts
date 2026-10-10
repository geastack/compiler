// ECMA-262 21.2.1.1: `BigInt(value)` is ToPrimitive(value, number) and then
// NumberToBigInt or ToBigInt. A database client's server-connection-id parser
// hands it a `number | bigint | Double`, where a binary-document serializer's
// `Double.prototype.valueOf` answers
// the wrapped number; each arm converts without boxing the union.

class Wrapped {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value
  }
}

function toId(id: number | bigint | Wrapped): bigint {
  // @ts-expect-error: a Wrapped is coercible to number
  return BigInt(id)
}

//! expect: number=42 bigint=9007199254740993 wrapped=7
console.log('number=' + toId(42) + ' bigint=' + toId(9007199254740993n) + ' wrapped=' + toId(new Wrapped(7)))
let fraction = 'no throw'
try {
  toId(new Wrapped(1.5))
} catch (error) {
  fraction = error instanceof RangeError ? 'RangeError' : 'other'
}
//! expect: fraction=RangeError
console.log('fraction=' + fraction)
