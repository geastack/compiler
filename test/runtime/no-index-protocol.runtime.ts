// Fixed fields and dynamic expandos still support reflection and integrity
// operations without pretending the class family has typed index storage.
//! emitted-lacks: gea_readOwnIndex
//! emitted-lacks: gea_ownIndexPresent
//! emitted-lacks: gea_freezeOwnIndex
//! expect: base,child,extra
//! expect: 9
//! expect: true:true
//! expect: true:true
class Base {
  base = 2
}

class Child extends Base {
  child = 3
}

const value = new Child()
Object.defineProperty(value, 'extra', { value: 9, writable: true, enumerable: true, configurable: true })
console.log(Object.keys(value).join(','))
console.log(Object.getOwnPropertyDescriptor(value, 'extra')!.value)
Object.seal(value)
console.log(Object.isSealed(value) + ':' + !Object.isFrozen(value))
Object.freeze(value)
console.log(Object.isFrozen(value) + ':' + Object.isSealed(value))
