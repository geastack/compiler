//! expect: base 3
//! expect: callable function
import { ProtocolBase } from './_physical-protocol-classes.js'
import type { ProtocolDerived } from './_physical-protocol-classes.js'

function inspect(value: ProtocolDerived, key: string): unknown {
  return (value as unknown as Record<string, unknown>)[key]
}

console.log('base', new ProtocolBase().value)
// Keep the reflective function's native signature, without inventing an
// allocation of the type-only derived class.
console.log('callable', typeof inspect)
