//! expect: counted=12
//! expect: widened=9.5
//! expect: integers=9
//! emitted-lacks: gea::TaggedUnion
// A callback that returns `0` on one path and an `int` on another is inferred
// as `0 | int`: two Number members, so one Number carrier, not a sum of a
// `double` arm and an `int64_t` arm no runtime test could tell apart (and no
// `+` reduces). `number` among the members joins them to `number`; members
// that are all declared integers join to the widest of them.
declare const intBrand: unique symbol
type int = number & { readonly [intBrand]?: never }
declare const i32Brand: unique symbol
type i32 = number & { readonly [i32Brand]?: never }

const reduce = <U>(count: number, fn: (index: number) => U, combine: (left: U, right: U) => U, identity: U): U => {
  let result = identity
  for (let index = 0; index < count; index++) result = combine(result, fn(index))
  return result
}

const doubled = (value: number): int => {
  const result: int = value * 2
  return result
}

const counted = reduce(
  4,
  (index) => {
    if (index === 0) return 0
    return doubled(index)
  },
  (a, b) => a + b,
  0
)
console.log(`counted=${counted}`)

const widened = reduce(
  3,
  (index): number | int => (index === 1 ? 1.5 : doubled(index + 1)),
  (a, b) => a + b,
  0
)
console.log(`widened=${widened}`)

const narrow = (value: number): i32 => {
  const result: i32 = value
  return result
}
const integers = reduce(
  3,
  (index) => (index === 1 ? narrow(index) : doubled(index)),
  (a, b) => a + b,
  narrow(4)
)
console.log(`integers=${integers}`)
