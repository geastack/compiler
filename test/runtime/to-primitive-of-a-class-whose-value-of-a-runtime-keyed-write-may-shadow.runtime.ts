// `Number(x)` and `BigInt(x)` over a value that is a number or a wrapper
// class run OrdinaryToPrimitive on the wrapper: [[Get]] of `valueOf`, then a
// call with the wrapper as `this`. The wrapper's instances also take writes
// under runtime string keys, so an instance may hold an own `valueOf` that
// shadows the prototype method -- and that own function is the one that runs.
// An own `valueOf` that is not callable, or that answers an object, falls
// through to `toString` (the instance's own, else the prototype's), and when
// neither answers a primitive the conversion is a TypeError.

export {}
class Int32 {
  constructor(readonly value: number) {}
  valueOf(): number {
    return this.value
  }
  toString(): string {
    return String(this.value * 100)
  }
}
function tag(target: Int32, key: string, value: () => number): void {
  // @ts-expect-error -- a runtime-keyed write
  target[key] = value
}
function install(target: any, key: string, value: unknown): void {
  target[key] = value
}
function asNumber(value: number | Int32): number {
  return Number(value)
}
function asBigInt(value: number | bigint | Int32): bigint {
  // @ts-expect-error: an Int32 is coercible to number
  return BigInt(value)
}
const plain = new Int32(7)
const shadowed = new Int32(3)
tag(shadowed, `valueOf${String(Math.random()).slice(0, 0)}`, () => 40)
const labelled = new Int32(5)
tag(labelled, `label${String(Math.random()).slice(0, 0)}`, () => 99)
console.log(asNumber(plain), asNumber(shadowed), asNumber(labelled), asNumber(1.5))
console.log(String(asBigInt(plain)), String(asBigInt(shadowed)), String(asBigInt(2n)), String(asBigInt(6)))
const suffix = String(Math.random()).slice(0, 0)
const notCallable = new Int32(4)
install(notCallable, `valueOf${suffix}`, 17)
const ownString = new Int32(6)
install(ownString, `valueOf${suffix}`, () => ({}))
install(ownString, `toString${suffix}`, () => '12')
const neither = new Int32(8)
install(neither, `valueOf${suffix}`, () => ({}))
install(neither, `toString${suffix}`, () => ({}))
console.log(asNumber(notCallable), asNumber(ownString), String(asBigInt(notCallable)), String(asBigInt(ownString)))
let numberFailure = false
let bigIntFailure = false
try {
  asNumber(neither)
} catch (error) {
  numberFailure = error instanceof TypeError
}
try {
  asBigInt(neither)
} catch (error) {
  bigIntFailure = error instanceof TypeError
}
console.log(numberFailure, bigIntFailure)
//! expect: 7 40 5 1.5
//! expect: 7 40 2 6
//! expect: 400 12 400 12
//! expect: true true
