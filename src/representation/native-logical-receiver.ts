import { carriesNativeUndefined, type Representation } from './model.js'
import { isNativeError } from './prototype-domains.js'

/**
 * The existing erased native call entry's receiver transport, including every wrapper arm.
 * Unsupported carriers have no retained payload in NativeCallReceiver::Other.
 * @semanticCategory generic-primitive
 */
export type NativeLogicalReceiverProtocol =
  | { readonly kind: 'reference' | 'undefined' | 'null' | 'dynamic' }
  | { readonly kind: 'primitive'; readonly number: boolean; readonly string?: true }
  | {
      readonly kind: 'callable'
      readonly representation: Extract<
        Representation,
        {
          kind:
            | 'function'
            | 'function-family'
            | 'function-value-family'
            | 'function-value-dispatch'
            | 'constructor-family'
            | 'constructor-value-dispatch'
            | 'function-and-constructor'
        }
      >
    }
  | { readonly kind: 'optional'; readonly payload: NativeLogicalReceiverProtocol; readonly absence: 'null' | 'undefined' }
  | { readonly kind: 'union'; readonly arms: readonly NativeLogicalReceiverProtocol[] }
  | { readonly kind: 'unsupported'; readonly carrier: Representation['kind'] }

/** One inventory shared by erased receiver admission and native rendering; it grants no new boxing boundary. */
export const nativeLogicalReceiverProtocolOf = (representation: Representation): NativeLogicalReceiverProtocol => {
  if (carriesNativeUndefined(representation) || isNativeError(representation)) return { kind: 'reference' }
  // A shared typed-array view is an object reference like the buffer it views:
  // `NativeCallReceiver::object` retains the view's own allocation and boxes it
  // only when an unknown callee asks, under the same payload type the runtime's
  // typed-array brand reads. A shader uniform's `value.toJSON( meta )` reads its
  // method off a sum whose arms include the typed uniform arrays.
  if (
    (representation.kind === 'typed-array' ||
      representation.kind === 'array-buffer' ||
      representation.kind === 'shared-array-buffer' ||
      representation.kind === 'array-object' ||
      (representation.kind === 'dictionary' && representation.key !== 'symbol')) &&
    representation.ownership === 'shared-refcount'
  )
    return { kind: 'reference' }
  switch (representation.kind) {
    case 'undefined':
    case 'void':
      return { kind: 'undefined' }
    case 'null':
      return { kind: 'null' }
    case 'dynamic':
      return { kind: 'dynamic' }
    case 'scalar':
      return { kind: 'primitive', number: representation.domain === 'number' }
    case 'string':
      return { kind: 'primitive', number: false, string: true }
    case 'symbol':
      return { kind: 'primitive', number: false }
    case 'function':
    case 'function-family':
    case 'function-value-family':
      return { kind: 'callable', representation }
    case 'function-value-dispatch':
      // A recursive wrapper derives from CallableObject, but the existing
      // DynamicCarrier specialization authenticates its exact base type.
      return representation.recursive === undefined
        ? { kind: 'callable', representation }
        : { kind: 'unsupported', carrier: representation.kind }
    case 'constructor-family':
    case 'constructor-value-dispatch':
      // ConstructorObject retains its actual class-evaluation owner. Its
      // present dynamic constructor entry has only a fixed positional frame.
      return representation.abi.receiver === null && representation.abi.restFrom === null
        ? { kind: 'callable', representation }
        : { kind: 'unsupported', carrier: representation.kind }
    case 'function-and-constructor':
      return representation.construct.receiver === null && representation.construct.restFrom === null
        ? { kind: 'callable', representation }
        : { kind: 'unsupported', carrier: representation.kind }
    case 'optional':
      return { kind: 'optional', payload: nativeLogicalReceiverProtocolOf(representation.payload), absence: representation.absence }
    case 'tagged-union':
      return { kind: 'union', arms: representation.arms.map((arm) => nativeLogicalReceiverProtocolOf(arm.value)) }
    default:
      return { kind: 'unsupported', carrier: representation.kind }
  }
}

/** Exact source frames whose retained receiver may reach a declared-any body.
 * Traversal shares the transport inventory; a C++ type cannot recover the
 * receiver/rest frame or an Optional's semantic absence at that boundary.
 */
export const nativeLogicalReceiverCallablePayloadsOf = (representation: Representation): readonly Representation[] => {
  const visit = (protocol: NativeLogicalReceiverProtocol): readonly Representation[] => {
    switch (protocol.kind) {
      case 'callable':
        return [protocol.representation]
      case 'optional':
        return visit(protocol.payload)
      case 'union':
        return protocol.arms.flatMap(visit)
      default:
        return []
    }
  }
  return visit(nativeLogicalReceiverProtocolOf(representation))
}

export const nativeLogicalReceiverProtocolSupported = (protocol: NativeLogicalReceiverProtocol): boolean => {
  switch (protocol.kind) {
    case 'unsupported':
      return false
    case 'optional':
      return nativeLogicalReceiverProtocolSupported(protocol.payload)
    case 'union':
      return protocol.arms.length > 0 && protocol.arms.every(nativeLogicalReceiverProtocolSupported)
    default:
      return true
  }
}
