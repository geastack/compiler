function define(seed: number) {
  class C {
    static value = seed
    static {
      this.value++
      console.log('block', this.value)
    }
  }
  return C
}
const A = define(10)
const B = define(20)
console.log('isolated', A.value, B.value, A === B)
A.value = 40
console.log('write', A.value, B.value)
class Base {
  static value = 7
}
class Derived extends Base {}
console.log('inherited', Base.value, Derived.value)
Derived.value = 9
console.log('own', Base.value, Derived.value)
class OptionalBase {
  static value: number | undefined = 7
}
class OptionalDerived extends OptionalBase {}
OptionalDerived.value = undefined
console.log('present-undefined', OptionalBase.value, OptionalDerived.value)
//! expect: block 11
//! expect: block 21
//! expect: isolated 11 21 false
//! expect: write 40 21
//! expect: inherited 7 7
//! expect: own 7 9
//! expect: present-undefined 7 undefined
