//! expect: A B function 0 2
//! expect: cls X true
//! expect: 3 4 6 D
//! expect: fn x
// `C.name`/`C.length` are the class's own `[[Name]]`/`ExpectedArgumentCount`
// unless a static member shadows them; an anonymous class expression takes
// its NamedEvaluation name (a binding, a destructuring default); a class
// expression's `extends` is a real heritage event; and a defaulted key an
// empty object literal lacks binds the default, whose `.name` is the key.
// JavaScript on purpose: `f([])` against untyped pattern defaults is the
// test262 shape, and only the JS checker types it from the defaults alone.
// `@ts-nocheck` because the checker REPORTS the absent keys (`Property 'fn'
// does not exist on type '{}'`) while still typing the program; the census
// answers those reads itself, which is the point of the test.
// @ts-nocheck
const A = class {}
class B {}
const C = class {
  static name() {
    return 1
  }
}
class P {
  /** @param {number} a @param {number} b @param {number} [c] */
  constructor(a, b, c = 0) {
    this.sum = a + b + c
  }
}
console.log(A.name, B.name, typeof C.name, B.length, P.length)
function f([cls = class {}, xCls = class X {}, checked = class {}]) {
  console.log(cls.name, xCls.name, checked.name === 'checked')
}
f([])
class Base {
  constructor() {
    this.v = 3
  }
  get w() {
    return this.v + 1
  }
}
const D = class extends Base {
  double() {
    return this.v * 2
  }
}
const d = new D()
console.log(d.v, d.w, d.double(), D.name)
const { fn = function () {}, xFn = function x() {} } = {}
console.log(fn.name, xFn.name)
