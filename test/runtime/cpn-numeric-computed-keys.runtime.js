// @ts-nocheck
//! expect: 2 2 2 2
//! expect: 2 2 2 2
//! expect: 2 2 2 2
class D {
  [1e1]() {
    return 2
  }
  static [1e1]() {
    return 2
  }
}
let d = new D()
console.log(d[1e1](), D[1e1](), d[String(1e1)](), D[String(1e1)]())
let C = class {
  [1] = 2
  static [1] = 2
}
let c = new C()
console.log(c[1], C[1], c[String(1)], C[String(1)])
class E {
  [1] = 2
  static [1] = 2
}
let e = new E()
console.log(e[1], E[1], e[String(1)], E[String(1)])
