//! expect: plain true false 7
//! expect: sealed true true 9
//! expect: inherited true false 3

class Plain {
  value = 7
}
const plain = new Plain()
Object.freeze(plain)
console.log('plain', Object.isFrozen(plain), Reflect.set(plain, 'value', 8), plain.value)
const sealed = new Plain()
Object.seal(sealed)
console.log('sealed', Object.isSealed(sealed), Reflect.set(sealed, 'value', 9), sealed.value)

class Base {
  value = 5
}
class Indexed extends Base {
  [name: string]: number
}
const indexed = new Indexed()
indexed.extra = 3
const base: Base = indexed
Object.freeze(base)
console.log('inherited', Object.isFrozen(base), Reflect.set(base, 'extra', 4), indexed.extra)
