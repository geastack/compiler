// @ts-nocheck
// A computed key read off the class constructor object dispatches over every
// static member the class and its bases declare (test262's cpn family:
// `static [1] = 2; C[String(1)]`).
class C {
  [1] = 2
  static [1] = 2
  static [1e3] = 4
  static m() {
    return 7
  }
}
class D extends C {
  static [0x10] = 16
}
var c = new C()
console.log(c[1], C[1], c[String(1)], C[String(1)], C[String(1e3)], C[1e3])
//! expect: 2 2 2 2 4 4
console.log(D[String(1)], D[String(16)], typeof C[String(2)], C[String('m')]())
//! expect: 2 16 undefined 7
class E {
  static get g() {
    return 9
  }
  static h(a) {
    return a + 1
  }
}
console.log(E[String('g')], E[String('h')](1), E['nam' + 'e'], E[String('length')])
//! expect: 9 2 E 0
