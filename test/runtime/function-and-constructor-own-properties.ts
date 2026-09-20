//! expect: facts:Factory:1:object:7
//! expect: expando:undefined
//! emitted-has: gea::callableDynamicGet
//! emitted-has: gea::CallableConstructorObject

function Factory(this: { value: number }, value: number): number {
  this.value = value
  return value
}

// A static expando read is allowed, but a `prototype` write remains refused:
// native construction has no mutable-prototype dispatch to pretend otherwise.
type FactoryWithDefault = typeof Factory & (new (value: number) => { value: number }) & { default?: number }
const reflected = Factory as FactoryWithDefault
const instance = new reflected(7)
console.log(`facts:${Factory.name}:${Factory.length}:${typeof Factory.prototype}:${instance.value}`)
console.log(`expando:${typeof reflected.default}`)
