// A user type guard narrowing a PRIMITIVE field to a class: a binary-document
// serializer's `Timestamp.fromExtendedJSON` reads `doc.$timestamp.i` (declared
// `number`) under `Long.isLong(...)`, whose `value is Long` makes the checker
// type the read `number & Long`. No number is a Long, so the guard answers false and
// the branch is dead; the live `: doc.$timestamp.i` arm is what runs.
class Long {
  readonly low: number
  readonly __isLong__ = true
  constructor(low: number) {
    this.low = low
  }
  static isLong(value: unknown): value is Long {
    return value != null && typeof value === 'object' && '__isLong__' in value && value.__isLong__ === true
  }
  getLowBitsUnsigned(): number {
    return this.low >>> 0
  }
}
interface Extended {
  $timestamp: { t: number; i: number }
}
function fromExtendedJSON(doc: Extended): number {
  const i = Long.isLong(doc.$timestamp.i) ? doc.$timestamp.i.getLowBitsUnsigned() : doc.$timestamp.i
  const t = Long.isLong(doc.$timestamp.t) ? doc.$timestamp.t.getLowBitsUnsigned() : doc.$timestamp.t
  return t * 1000 + i
}
console.log(fromExtendedJSON({ $timestamp: { t: 3, i: 7 } }), Long.isLong(new Long(-1)), new Long(-1).getLowBitsUnsigned())
//! expect: 3007 true 4294967295
