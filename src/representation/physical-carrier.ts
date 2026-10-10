import type { AbiParameter, CallableAbi, Ownership, Representation, TaggedUnionArm } from './model.js'

/**
 * Which representations are one physical carrier: two values with equal keys
 * are the same object in the same storage, so converting one into the other is
 * identity at run time.
 *
 * The representation keeps distinctions storage does not: `constructor-family`
 * names the classes its `new` reaches while `constructor-value-dispatch` does
 * not, a `function-family` names its members while a `function-value-dispatch`
 * does not, an Array's interface extension lives in the array's own sidecar,
 * and a `ReadonlyMap` is the mutable map's storage under a narrower carrier.
 * Those facts select operations, not storage, so this key drops them and keeps
 * everything a value's layout depends on.
 *
 * A callable carrier's storage is its frame, not only its signature: a rest
 * packing index, an actual-arguments slot and the presence of a receiver change
 * what the caller builds even where two signatures list the same types, so the
 * frame is part of the key.
 *
 * `null` for a carrier with no physical storage -- `unresolved` anywhere, or a
 * bare `void` outside the result positions that state "carries nothing".
 */
export const physicalCarrierKey = (representation: Representation): string | null => {
  try {
    return carrierKey(representation, null)
  } catch (error) {
    if (error instanceof NoPhysicalCarrier) return null
    throw error
  }
}

/** Whether two carriers share one physical storage, so a value of one already is a value of the other. */
export const samePhysicalCarrier = (source: Representation, target: Representation): boolean => {
  const from = physicalCarrierKey(source)
  return from !== null && from === physicalCarrierKey(target)
}

class NoPhysicalCarrier extends Error {}

const owned = (ownership: Ownership, inner: string): string => `${ownership}(${inner})`

const resultKey = (representation: Representation): string => (representation.kind === 'void' ? 'void' : carrierKey(representation, null))

/** A cursor's completion or resume slot: `undefined` stores nothing, exactly as `void` does. */
const valuelessSlotKey = (representation: Representation): string =>
  representation.kind === 'void' || representation.kind === 'undefined' ? 'void' : carrierKey(representation, null)

/**
 * A view's ArrayBuffer-family parameter keeps its own shared tier even under a
 * stale `owned` passing mode (`passingOf`, model.ts): the bytes have reference
 * identity a by-value copy would break.
 */
const parameterKey = (parameter: AbiParameter): string => {
  const value = parameter.value
  const aliasing =
    value.kind === 'array-buffer' || value.kind === 'shared-array-buffer' || value.kind === 'data-view' || value.kind === 'typed-array'
  if (aliasing && value.ownership === 'shared-refcount' && parameter.ownership === 'owned') return carrierKey(value, null)
  return carrierKey(value, parameter.ownership)
}

const frameKey = (abi: CallableAbi): string => {
  const receiver = abi.receiver === null ? 'none' : carrierKey(abi.receiver, null)
  const parameters = abi.parameters.map(parameterKey).join(',')
  return `frame(${resultKey(abi.result)};receiver:${receiver};(${parameters});rest:${abi.restFrom ?? 'none'};arguments:${abi.argumentsFrame ?? 'none'})`
}

const armKey = (arm: TaggedUnionArm): string =>
  arm.runtimeDiscriminator.kind === 'callable-tag' ? 'function-value' : carrierKey(arm.value, null)

const carrierKey = (representation: Representation, ownership: Ownership | null): string => {
  switch (representation.kind) {
    case 'unresolved':
    case 'void':
      throw new NoPhysicalCarrier()
    case 'scalar':
      return representation.integerWidth === 'int64'
        ? 'int64'
        : representation.integerWidth === 'int32' || representation.domain === 'int32'
          ? 'int32'
          : representation.domain === 'uint32'
            ? 'uint32'
            : representation.domain === 'float64'
              ? 'number'
              : representation.domain
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'callable-identity':
    case 'constructor-identity':
    case 'error-constructor':
    case 'generic-function-set':
    case 'dynamic':
      return representation.kind
    case 'class-ref':
      return owned(ownership ?? representation.ownership, `class:${representation.declaration}`)
    case 'native-handle':
      // A stated host type is the host's own struct, held by value -- the
      // same storage a host-declared native record names when owned.
      return representation.native === null
        ? `native-handle:${representation.protocol}@${representation.version}`
        : owned('owned', `host:${representation.native}`)
    case 'record':
    case 'record-with-index':
      return owned(ownership ?? representation.ownership, `record:${representation.shapeId}`)
    case 'proxy-object':
      return `proxy(${carrierKey(representation.target, null)},${carrierKey(representation.handler, null)})`
    case 'native-record-ref':
      if (representation.recursive) return owned(ownership ?? representation.ownership, `recursive:${representation.recursive.type}`)
      return owned(
        ownership ?? representation.ownership,
        representation.native === null ? `record:${representation.shapeId}` : `host:${representation.native}`
      )
    case 'borrowed-ref':
      return `borrowed(${carrierKey(representation.referent, null)})`
    case 'array-object':
      if (representation.recursive) return owned(ownership ?? representation.ownership, `recursive:${representation.recursive.type}`)
      return owned(ownership ?? representation.ownership, `array(${carrierKey(representation.element, null)})`)
    case 'dense-buffer':
      return `dense(${carrierKey(representation.element, null)})`
    case 'typed-array':
      return owned(
        ownership ?? representation.ownership,
        `typed-array:${representation.element === 'float64' ? 'number' : representation.element}`
      )
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
      return owned(ownership ?? representation.ownership, representation.kind)
    case 'native-sequence':
      return `sequence(${carrierKey(representation.element, null)})`
    case 'iterator':
    case 'async-generator':
      return `${representation.kind}(${carrierKey(representation.element, null)},${valuelessSlotKey(representation.completion)},${valuelessSlotKey(representation.resume)})`
    case 'promise':
      return `promise(${resultKey(representation.value)})`
    case 'keyed-collection': {
      if (representation.recursive) return owned(ownership ?? representation.ownership, `recursive:${representation.recursive.type}`)
      const value = representation.value === null ? '' : `,${carrierKey(representation.value, null)}`
      return owned(ownership ?? representation.ownership, `${representation.family}(${carrierKey(representation.key, null)}${value})`)
    }
    case 'dictionary':
      if (representation.recursive) return owned(ownership ?? representation.ownership, `recursive:${representation.recursive.type}`)
      return owned(ownership ?? representation.ownership, `dictionary:${representation.key}(${carrierKey(representation.value, null)})`)
    case 'function-value-dispatch':
      // A self-mentioning signature is closed by its wrapper, held by value.
      if (representation.recursive) return `recursive:${representation.recursive.type}`
      return `callable(${frameKey(representation.abi)})`
    case 'function':
    case 'function-family':
    case 'function-value-family':
      return `callable(${frameKey(representation.abi)})`
    case 'constructor-family':
    case 'constructor-value-dispatch':
      return `constructor(${frameKey(representation.abi)})`
    case 'function-and-constructor':
      return `callable-constructor(${frameKey(representation.call)},${frameKey(representation.construct)})`
    case 'optional':
      return `optional(${carrierKey(representation.payload, null)})`
    case 'tagged-union':
      return `union(${representation.arms.map(armKey).join(',')})`
  }
}
