// A binary-document serializer's `Timestamp extends LongWithoutOverridesClass`,
// where the base is a `const` annotated with a construct-signature type and
// initialized with the class itself behind `as unknown as`. The assertion
// allocates nothing: the cell holds `Long`'s own constructor, heritage and
// `super()` run `Long`, and reads of the alias see the same class.

class Long {
  low: number
  high: number
  constructor(low: number, high: number) {
    this.low = low
    this.high = high
  }
  toString(): string {
    return `${this.high}:${this.low}`
  }
  compare(other: Long): number {
    return this.high === other.high ? this.low - other.low : this.high - other.high
  }
}

type Kept = 'toString' | 'compare'

type LongWithoutOverrides = new (low: number, high: number) => { [P in Kept]: Long[P] }

const LongWithoutOverridesClass: LongWithoutOverrides = Long as unknown as LongWithoutOverrides

class Timestamp extends LongWithoutOverridesClass {
  declare low: number
  declare high: number
  get t(): number {
    return this.high >>> 0
  }
  get i(): number {
    return this.low >>> 0
  }
}

const ts = new Timestamp(3, 9)
console.log(ts.t, ts.i, ts.toString(), ts instanceof Long, ts instanceof Timestamp)
console.log(ts.compare(new Long(1, 9)), (LongWithoutOverridesClass as unknown) === Long)

//! expect: 9 3 9:3 true true
//! expect: 2 true
