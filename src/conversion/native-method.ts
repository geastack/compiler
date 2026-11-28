import type { FunctionId } from '../identity/ids.js'
import { carriesNativeUndefined, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { ConversionNode, ConversionNodeId } from './algebra.js'

export const NATIVE_UNBOUND_METHOD_MATERIALIZER = 'gea::CallableObject::unboundMethod'

/** A method read is a view of its Function object; only an explicit bind captures the read's object. */
export interface NativeMethodValueRecipe {
  readonly builtin?: 'buffer-slice'
  readonly key: string
  readonly callable: FunctionId | null
  readonly origin: 'prototype' | 'own'
  readonly source: Representation
  readonly target: Representation
  readonly conversion: ConversionNodeId
}

export interface NativeResultNarrowing {
  readonly source: Extract<Representation, { kind: 'class-ref' }>
  readonly target: Extract<Representation, { kind: 'class-ref' }>
}

export interface NativeUnboundMethodContract {
  /** The finite non-receiver frame is admitted independently of native receiver erasure. */
  readonly frameAdaptation?: ConversionNode
  /** A typed public this-frame forwards the logical receiver through the erased native entry. */
  readonly publicAdaptation?: ConversionNode
  readonly receiverRequirement?: 'present-native-brand'
  /** An inherited native self-result is checked against the public result allocation on every call. */
  readonly resultNarrowing?: NativeResultNarrowing
  readonly source: CallableAbi
  readonly target: CallableAbi
  readonly receiver: Representation
  readonly absence: 'undefined'
  readonly identity: 'preserved'
}

/** Native reference absence states pass through; an allocated result delegates to this exact checked recipe. */
export interface NativeMethodResultContract {
  readonly checked: ConversionNode
}

const nativeAbiOf = (value: Representation): CallableAbi | null => {
  switch (value.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return value.abi
    default:
      return null
  }
}

/** Each admitted arm can carry strict undefined/null and authenticate its native allocation before projection. */
export const nativeMethodReceiverAdmitted = (receiver: Representation): boolean =>
  carriesNativeUndefined(receiver) ||
  (receiver.kind === 'tagged-union' && receiver.arms.length > 0 && receiver.arms.every((arm) => carriesNativeUndefined(arm.value)))

const receiverArmsOf = (receiver: Representation): readonly Representation[] =>
  receiver.kind === 'tagged-union' ? receiver.arms.flatMap((arm) => receiverArmsOf(arm.value)) : [receiver]

const suppliedReceiverFits = (supplied: Representation, body: Representation): boolean =>
  representationKey(supplied) === representationKey(body) ||
  (supplied.kind === 'class-ref' &&
    body.kind === 'class-ref' &&
    (supplied.ancestors.includes(body.declaration) || body.ancestors.includes(supplied.declaration)))

// Takes both frames already present: narrowing `from.receiver` through
// `from?.receiver?.kind` leaves a native build holding an optional frame. The
// two results are narrowed as locals for the same reason.
const resultNarrowingOf = (from: CallableAbi, to: CallableAbi): NativeResultNarrowing | null => {
  const receiver = from.receiver
  const source = from.result
  const target = to.result
  return receiver !== null &&
    receiver.kind === 'class-ref' &&
    source.kind === 'class-ref' &&
    target.kind === 'class-ref' &&
    representationKey(source) === representationKey(receiver) &&
    source.ownership === 'shared-refcount' &&
    target.ownership === source.ownership &&
    target.ancestors.includes(source.declaration)
    ? { source, target }
    : null
}

/** A native source entry can authenticate the receiver supplied by the public method frame. */
export const nativeUnboundMethodContractOf = (source: Representation, target: Representation): NativeUnboundMethodContract | null => {
  const from = nativeAbiOf(source)
  const to = nativeAbiOf(target)
  // An explicitly declared any/unknown this is already a dynamic invocation
  // boundary. Only its contextual public nil frame is erased here; ordinary
  // pair classifiers and native nominal receiver admission stay unchanged.
  const dynamicReceiver = from?.receiver?.kind === 'dynamic' && to?.receiver === null
  const resultNarrowing = from !== null && to !== null ? resultNarrowingOf(from, to) : null
  if (
    from === null ||
    to === null ||
    from.receiver === null ||
    (!dynamicReceiver && !nativeMethodReceiverAdmitted(from.receiver)) ||
    (to.receiver !== null && representationKey(to.receiver) === representationKey(from.receiver) && resultNarrowing === null) ||
    (to.receiver !== null &&
      (!nativeMethodReceiverAdmitted(to.receiver) ||
        !receiverArmsOf(to.receiver).some((supplied) =>
          receiverArmsOf(from.receiver!).some((body) => suppliedReceiverFits(supplied, body))
        )))
  )
    return null
  return {
    source: from,
    target: to,
    receiver: from.receiver,
    absence: 'undefined',
    identity: 'preserved',
    ...(resultNarrowing === null ? {} : { resultNarrowing })
  }
}
