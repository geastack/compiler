// @ts-nocheck
// ECMA-262 10.2.2 step 13: a derived constructor that never calls super()
// throws a ReferenceError on completion, and one returning a primitive throws
// a TypeError. Ordinary derived construction and `return this` are untouched.
class B {
  constructor(x) {
    this.x = x
  }
}
class NoSuper extends B {
  constructor() {}
}
class PrimitiveReturn extends B {
  constructor() {
    super(1)
    return 'x'
  }
}
class Fine extends B {
  constructor() {
    super(5)
    this.y = 2
  }
}
class Self {
  constructor() {
    this.z = 1
    return this
  }
}
try {
  new NoSuper()
  console.log('no throw')
} catch (e) {
  console.log(e instanceof ReferenceError, e.name)
}
//! expect: true ReferenceError
try {
  new PrimitiveReturn()
  console.log('no throw')
} catch (e) {
  console.log(e instanceof TypeError, e.name)
}
//! expect: true TypeError
var d = new Fine()
var s = new Self()
console.log(d.x, d.y, s.z, d instanceof B)
//! expect: 5 2 1 true
