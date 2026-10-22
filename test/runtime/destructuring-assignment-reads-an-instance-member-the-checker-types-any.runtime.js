// @ts-nocheck
// A destructuring assignment out of a class instance whose member the checker
// types `any` -- a JavaScript field assigned from an unannotated constructor
// parameter. The extraction asked the checker for the member's type, read
// `any` as no answer, and typed the read `undefined` as if the instance lacked
// the key; storing that into a number field became a branch the compiler
// proved unreachable, which threw on the first run.
class Spec {
  constructor(title, width) {
    this.title = title
    this.width = width
  }
}

class Panel {
  constructor() {
    this.title = 'none'
    this.width = 0
  }
  take(spec) {
    ;({ title: this.title, width: this.width } = spec)
    return this
  }
}

const third = new Spec('c', 5)
const panel = new Panel().take(third)
console.log(panel.title, panel.width + 1)
let width = 0
;({ width } = third)
console.log(width * 2)
//! expect: c 6
//! expect: 10
export {}
