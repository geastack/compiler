//! expect: repeated true
//! expect: instances true
//! expect: inherited true
//! expect: override false
//! expect: property 23
//! expect: deleted undefined
//! expect: evaluations false
//! expect: old-evaluation true
//! expect: derived-evaluation true
//! expect: own-evaluation false
//! expect: loop-construction true
//! expect: virtual-call 5
//! expect: read-selection 3

class Base {
  method() {
    return 3
  }
}
class Derived extends Base {}
class Override extends Base {
  method() {
    return 5
  }
}

/** @param {Base & Record<string, any>} object @returns {*} */
function read(object) {
  return object.method
}

const base = new Base()
const derived = new Derived()
console.log('repeated', read(base) === read(base))
console.log('instances', read(base) === read(new Base()))
console.log('inherited', read(base) === read(derived))
console.log('override', read(base) === read(new Override()))
read(base).note = 23
console.log('property', read(derived).note)
delete read(derived).note
console.log('deleted', typeof read(base).note)

function makeClass() {
  class Local extends Base {
    own() {
      return 11
    }
  }
  return Local
}
const First = makeClass()
const first = new First()
const firstMethod = first.own
const Second = makeClass()
const second = new Second()
console.log('evaluations', firstMethod === second.own)
console.log('old-evaluation', firstMethod === new First().own)
console.log('derived-evaluation', read(first) === read(second))

function makeRoot() {
  class Root {
    method() {
      return 13
    }
  }
  class Child extends Root {}
  return new Child().method
}
console.log('own-evaluation', makeRoot() === makeRoot())

let sameInLoop = true
for (let index = 0; index < 3; index++) {
  if (read(new Base()) !== read(base)) sameInLoop = false
}
console.log('loop-construction', sameInLoop)

/** @param {Base} object */
function invoke(object) {
  return object.method()
}
console.log('virtual-call', invoke(new Override()))
console.log('read-selection', read(base).call(new Override()))
