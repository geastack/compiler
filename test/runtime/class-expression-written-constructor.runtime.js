// @ts-nocheck
//! expect: 5
//! expect: 14
let C = class {
  y = 4
  constructor() {
    this.y = this.y + 1
  }
  m() {
    return this.y
  }
}
let c = new C()
console.log(c.m())
let B = class {
  constructor(v) {
    this.v = v
  }
}
let E = class extends B {
  constructor() {
    super(7)
  }
  get w() {
    return this.v * 2
  }
}
console.log(new E().w)
