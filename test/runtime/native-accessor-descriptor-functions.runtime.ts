export {}

function getter(): any {
  return 17
}

function setter(value: any): void {
  void value
}

const owner = {}
const restored = {}
Object.defineProperty(owner, 'entry', { get: getter, set: setter, configurable: true })
const descriptor = Object.getOwnPropertyDescriptor(owner, 'entry')!
Object.defineProperty(restored, 'copy', descriptor)
console.log(descriptor.get === getter, descriptor.set === setter)
//! expect: true true
