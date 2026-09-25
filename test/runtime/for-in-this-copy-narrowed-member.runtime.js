// @ts-nocheck
// three's `NodeMaterial.copy`: `for ( const property in this )` copies each
// member `source` holds. `source[ property ]` types as
// `Counter[Extract<keyof this, string>]`, an indexed access deferred only on
// its index (the object is a plain class), and the `=== undefined` test
// narrows it to `X & ({} | null)`: a union of two intersections over that
// access, whose member set is the class's own members.
//! expect: 4 3 b true
class Counter {
  constructor() {
    this.a = 1
    this.b = 2
    this.name = 'a'
    this.enabled = false
  }

  /** @param {Counter} source */
  copy(source) {
    for (const property in this) {
      if (source[property] === undefined) continue
      const value = source[property]
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') this[property] = value
    }
    return this
  }
}

const a = new Counter()
const b = new Counter()
b.a = 4
b.b = 3
b.name = 'b'
b.enabled = true
a.copy(b)
console.log(a.a, a.b, a.name, a.enabled)
