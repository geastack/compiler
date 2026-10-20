//! expect: arrow 2 1
//! expect: function 2 1 3
//! expect: siblings 2 3
//! emitted-lacks: assertedDowncastClassRef
// An unannotated parameter is typed from what its callers pass. A subclass
// that adds no member is structurally assignable both ways with its base, so
// the first call's subclass looked wide enough to hold the base object a later
// call passes, and the base then entered the subclass carrier through a
// downcast. The class carrier is nominal: only the base (an ancestor of every
// argument) holds them all, and a pair of siblings agrees on neither.
class Base {
  constructor() {
    this.x = 1
  }
}
class Derived extends Base {
  constructor() {
    super()
    this.x = 2
  }
}
class Sibling extends Base {
  constructor() {
    super()
    this.x = 3
  }
}

const show = (target) => target.x
console.log('arrow ' + show(new Derived()) + ' ' + show(new Base()))

function read(target) {
  return target.x
}
console.log('function ' + read(new Derived()) + ' ' + read(new Base()) + ' ' + read(new Sibling()))

const pick = (target) => target.x
console.log('siblings ' + pick(new Derived()) + ' ' + pick(new Sibling()))
