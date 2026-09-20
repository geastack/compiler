// A fluent API can change its phantom type while returning the same instance.
// The resolved return type must not manufacture another runtime class copy.
// In particular, no constructor below creates Chain<number[]>: using `new`
// inside tag would test growing recursive specialization instead of this rule.

class Chain<T> {
  value: number

  constructor(value: number) {
    this.value = value
  }

  describe = (): string => 'chain(' + String(this.value) + ')'

  tag(): Chain<T[]> {
    return this
  }
}

const one = new Chain<number>(3)
// Discarded, like a hono route registration's `Hono<...>` result.
one.tag()

//! expect: describe=chain(3)
console.log('describe=' + one.describe())
//! expect: tagged=chain(3)
console.log('tagged=' + one.tag().describe())
