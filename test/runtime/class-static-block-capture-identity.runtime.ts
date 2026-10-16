// Each definition captures its lexical value and its own evaluated constructor.
function define(label: string) {
  class C {
    static read: () => string
    static { const captured = label; this.read = () => captured; console.log(label, this === C) }
  }
  return C
}
const A = define('a')
const B = define('b')
console.log(A.read(), B.read(), A === B)
//! expect: a true
//! expect: b true
//! expect: a b false
