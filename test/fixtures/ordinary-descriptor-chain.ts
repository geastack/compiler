import type {} from '@geastack/core'

// Descriptor lookup must not execute an accessor. The prototype chain is
// authored ordinary data; the census must not confuse this read with a write
// through an unknown receiver.
const parent = {
  get value(): number {
    throw new Error('getter must not run')
  }
}
const target = Object.create(parent)
let found = false
for (let current = target; current; current = Object.getPrototypeOf(current)) {
  const descriptor = Object.getOwnPropertyDescriptor(current, 'value')
  if (descriptor) {
    found = typeof descriptor.get === 'function'
    break
  }
}
console.log(String(Object.hasOwn(target, 'value')) + ':' + String(found))
