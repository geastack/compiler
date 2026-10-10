// A binary-document serializer's `Timestamp` constructor takes `low?: bigint |
// Long | { t: number; i: number }` and narrows it with `Long.isLong(low)` and then
// `typeof low === 'object' && 't' in low && 'i' in low`. The read of `low`
// under that guard is exactly the record arm, beside a class arm (`Long`) the
// record cannot be viewed as: the checker's narrowing takes the runtime-checked
// arm projection through the optional, never a reinterpretation of the class.
class Long {
  constructor(
    readonly low: number,
    readonly high: number
  ) {}
  static isLong(value: unknown): value is Long {
    return value instanceof Long
  }
}

function describe(low?: bigint | Long | { t: number; i: number }): string {
  if (low == null) return 'zero'
  if (typeof low === 'bigint') return `big:${low}`
  if (Long.isLong(low)) return `long:${low.low}/${low.high}`
  if (typeof low === 'object' && 't' in low && 'i' in low) {
    const t = Number(low.t)
    const i = Number(low.i)
    return `pair:${t}/${i}`
  }
  return 'other'
}

console.log(describe(), describe(5n), describe(new Long(1, 2)), describe({ t: 3, i: 4 }))
//! expect: zero big:5 long:1/2 pair:3/4
