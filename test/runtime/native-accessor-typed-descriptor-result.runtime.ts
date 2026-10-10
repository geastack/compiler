export {}

function getter(): number[] {
  return [17, 23]
}

const owner = {}
Object.defineProperty(owner, 'entry', { get: getter, configurable: true })
const descriptor = Object.getOwnPropertyDescriptor(owner, 'entry')!
console.log(descriptor.get === getter, descriptor.get!().join(':'))
//! expect: true 17:23
