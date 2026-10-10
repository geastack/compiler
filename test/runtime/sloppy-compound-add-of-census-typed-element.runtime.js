//! expect: 6 3
//! emitted-lacks: gea::dynamicToPrimitive

// Without `strictNullChecks` (and with `noImplicitAny` off) the checker types
// `values` and every element read out of it as `any`; the census types them
// from the callers as `number[]` and `number`. `total += value` must add two
// native doubles, not box `value` into a dynamic `+`.
function sum(values) {
  let total = 0
  for (const value of values) total += value
  return total
}

class Holder {
  constructor(data) {
    this.data = data
  }

  total() {
    let total = 0
    for (const value of this.data) total += value
    return total
  }
}

console.log(sum([1, 2, 3]), new Holder([1, 2]).total())
