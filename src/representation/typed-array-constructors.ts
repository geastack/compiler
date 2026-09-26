import type { Representation, TypedArrayElementDomain } from './model.js'

/**
 * The standard TypedArray constructor interfaces, keyed by name, to the element
 * domain each one builds -- the one table every stage asks.
 *
 * Hardcoded because these are core ECMAScript (`lib.es5.d.ts`), not something
 * a host installs. `semantics/host-protocols.ts` reads it to name an ambient
 * VALUE's constructor type, `projection/instance-test.ts` to test membership,
 * and the C++ target to render a constructor as a value.
 *
 * `Uint8ClampedArray` is admitted with its siblings: its write rule has a
 * verified implementation and a carrier of its own to hold it (ECMA-262
 * 7.1.11 `ToUint8Clamp`, specialized on `gea::ClampedUint8`). See
 * `TypedArrayElementDomain`.
 */
export const typedArrayConstructorDomains: ReadonlyMap<string, TypedArrayElementDomain> = new Map([
  ['Int8ArrayConstructor', 'int8'],
  ['Uint8ArrayConstructor', 'uint8'],
  ['Uint8ClampedArrayConstructor', 'uint8-clamped'],
  ['Int16ArrayConstructor', 'int16'],
  ['Uint16ArrayConstructor', 'uint16'],
  ['Int32ArrayConstructor', 'int32'],
  ['Uint32ArrayConstructor', 'uint32'],
  ['Float32ArrayConstructor', 'float32'],
  ['Float64ArrayConstructor', 'float64']
])

const identities: ReadonlyMap<string, number> = new Map(
  [...typedArrayConstructorDomains.keys()].map((protocol, index) => [protocol, index])
)

/**
 * The runtime identity a typed-array constructor carries as a value: its
 * position in the table above, so every one of the nine is a distinct
 * `NativeHandle` id and `===`/Map keys compare the constructor the program
 * named. `null` for any other protocol.
 */
export const typedArrayConstructorIdentityOf = (protocol: string): number | null => identities.get(protocol) ?? null

/**
 * A compiler-owned handle to one of the constructors above -- the carrier whose
 * id is that identity. A plugin-stated carrier (`native !== null`) is its own
 * C++ type and says nothing about ids, so it is not one.
 */
export const isTypedArrayConstructorHandle = (representation: Representation): boolean =>
  representation.kind === 'native-handle' && representation.native === null && identities.has(representation.protocol)
