// @ts-nocheck
//! expect: 12
// `new C(...xs)` through a constructor read back as `any`. A CALL through a
// dynamic callee with a spread takes its whole argument list as one array
// (`spread-into-untyped-callable.runtime.js`); a construction must never be
// handed that array as its one argument -- here the spread fills the
// constructor's own formals, one per element.
const holder = {
  Make: class {
    constructor(a, b) {
      this.s = `${a}${b}`
    }
  }
}
const Make = Reflect.get(holder, 'Make')
const xs = [1, 2]
console.log(new Make(...xs).s)
