//! expect: collatz27=111
//! expect: wrap32=735609941
//! expect: wrap64=-7436447035513803000
//! expect: halves=20
//! expect: negmod=-1 negdiv=-3
//! expect: stored=2 -2 0 5
//! expect: stored64=-2 7766279631452242000 0
//! emitted-has: std::int32_t
//! emitted-has: gea::wrappingMultiply<std::int32_t>
//! emitted-has: gea::wrappingMultiply<long long>
//! emitted-has: gea::integerQuotient
// A binding annotated `int` or `i32` (the branded Numbers `@geastack/core`
// declares) is held in that machine integer, not in a double: the program
// accepted integer semantics for it. Arithmetic stays in the integer and wraps
// at the width (`wrap32` overflows int32 on its second turn, `wrap64` int64 on
// its fourth), `/` whose quotient lands only in such a binding truncates, and a
// Number stored into one truncates toward zero and wraps, with NaN as 0 --
// `ToInt32`'s rule. `collatz27` is the recurrence the magnitude census cannot
// bound on its own and that the annotation narrows anyway.
declare const intBrand: unique symbol
type int = number & { readonly [intBrand]?: never }
declare const i32Brand: unique symbol
type i32 = number & { readonly [i32Brand]?: never }

const collatzSteps = (start: number): number => {
  let value: int = start
  let steps = 0
  while (value !== 1) {
    value = value % 2 === 0 ? value / 2 : 3 * value + 1
    steps++
  }
  return steps
}

const wrap32 = (seed: number): number => {
  let hash: i32 = seed
  for (let turn = 0; turn < 4; turn++) hash = hash * 31 + 7
  return hash
}

const wrap64 = (seed: number): number => {
  let hash: int = seed
  for (let turn = 0; turn < 5; turn++) hash = hash * 1000003 + 1
  return hash
}

const halves = (start: number): number => {
  let value: i32 = start
  let count = 0
  while (value !== 0) {
    value = value / 2
    count++
  }
  return count
}

const signed = (start: number): string => {
  const value: i32 = start
  const remainder: i32 = value % 3
  const quotient: i32 = value / 2
  return `negmod=${remainder} negdiv=${quotient}`
}

const stored = (input: number): number => {
  const value: i32 = input
  return value
}

const stored64 = (input: number): number => {
  const value: int = input
  return value
}

console.log(`collatz27=${collatzSteps(27)}`)
console.log(`wrap32=${wrap32(123456789)}`)
console.log(`wrap64=${wrap64(1)}`)
console.log(`halves=${halves(1000000)}`)
console.log(signed(-7))
console.log(`stored=${stored(2.75)} ${stored(-2.75)} ${stored(NaN)} ${stored(4294967301)}`)
console.log(`stored64=${stored64(-2.5)} ${stored64(1e20)} ${stored64(Infinity)}`)
