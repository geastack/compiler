//! expect: base
//! expect: dog
//! expect: pup
//! expect: dog
//! expect: true

class Base {
  speak() {
    return 'base'
  }
}
class Dog extends Base {
  speak() {
    return 'dog'
  }
}
class Pup extends Dog {
  speak() {
    return 'pup'
  }
}

/** @param {Base} receiver @param {string} key */
function invoke(receiver, key) {
  return receiver[key]()
}
/** @param {Dog} receiver @param {string} key */
function read(receiver, key) {
  return receiver[key]
}

const dog = new Dog()
const pup = new Pup()
console.log(invoke(new Base(), 'speak'))
console.log(invoke(dog, 'speak'))
console.log(invoke(pup, 'speak'))
const selected = read(dog, 'speak')
// The read selected Dog.speak. A call-time virtual wrapper incorrectly returns pup.
console.log(selected.call(pup))
console.log(read(dog, 'missing') === undefined)
