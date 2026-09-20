import type { CallableAbi, Representation } from '../representation/model.js'
import { abiKey, representationKey } from '../representation/model.js'
import type { ClassLayout } from '../projection/classes.js'
import type { ConstructOperation, IrBody } from './model.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeArgumentsMatch } from './call-entry.js'

/** The allocation owns the receiver; explicit arguments and result use its construct ABI. */
export const constructMatchesAbi = (
  operation: ConstructOperation,
  abi: CallableAbi,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): boolean =>
  abi.receiver === null &&
  representationKey(operation.result.representation) === representationKey(abi.result) &&
  nativeArgumentsMatch(abi, operation.arguments, conversions)

/** The class allocation supplies this receiver before entering the source constructor. */
export const classConstructorBodyMatches = (layout: ClassLayout, body: IrBody): boolean => {
  const abi = body.abi
  const construct = layout.construct
  return (
    abi !== null &&
    abi.result.kind === 'void' &&
    layout.instance !== null &&
    abi.receiver !== null &&
    representationKey(abi.receiver) === representationKey(layout.instance) &&
    construct !== null &&
    construct.receiver === null &&
    abi.restFrom === construct.restFrom &&
    abi.parameters.length === construct.parameters.length &&
    abi.parameters.every((parameter, index) => representationKey(parameter.value) === representationKey(construct.parameters[index]!.value))
  )
}

/** The native ordinary construct thunk allocates its receiver and forwards
 * the construct frame into the source body. An explicit return needs its own
 * entry proof. A void body or an authenticated return of this preserves the
 * allocated receiver; a matching return type alone does not prove identity. */
export const ordinaryConstructBodyMatches = (
  operation: ConstructOperation,
  body: Pick<IrBody, 'sourceOwner' | 'abi' | 'construct' | 'blocks'>,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  const { abi, construct } = body
  const callee = operation.callee.representation
  const target = operation.target
  if (
    abi === null ||
    construct === null ||
    callee.kind !== 'function-and-constructor' ||
    operation.callee.value !== operation.newTarget.value ||
    target.kind !== 'exact' ||
    target.target.kind !== 'function' ||
    !target.target.constructable ||
    target.target.functionId !== body.sourceOwner ||
    abiKey(callee.call) !== abiKey(abi) ||
    abiKey(callee.construct) !== abiKey(construct) ||
    abiKey({ ...abi, receiver: null, result: construct.result }) !== abiKey(construct) ||
    !constructMatchesAbi(operation, construct, conversions)
  )
    return false
  if (abi.result.kind !== 'void') {
    if (abi.receiver === null || representationKey(abi.result) !== representationKey(abi.receiver)) return false
    const receivers = new Set(
      [...body.blocks.values()].flatMap((block) =>
        block.operations.flatMap((operation) => (operation.kind === 'receiver' ? [operation.result.id] : []))
      )
    )
    const returns = [...body.blocks.values()].flatMap((block) => (block.terminator.kind === 'return' ? [block.terminator] : []))
    if (returns.length === 0 || returns.some((operation) => operation.value === null || !receivers.has(operation.value.value))) return false
  }
  return nativeOrdinaryConstructInstanceMatches(abi, construct.result)
}

/** Allocation and body entry must share one native receiver representation.
 * Both provenance and the construct thunk consume this same admission. */
export const nativeOrdinaryConstructInstanceMatches = (
  abi: CallableAbi,
  instance: Representation
): instance is Extract<Representation, { kind: 'record' | 'record-with-index' | 'native-record-ref' }> => {
  return (
    (instance.kind === 'record' || instance.kind === 'record-with-index' || instance.kind === 'native-record-ref') &&
    (instance.ownership === 'owned' || instance.ownership === 'shared-refcount') &&
    (abi.receiver === null || representationKey(abi.receiver) === representationKey(instance))
  )
}

/** ECMA-262 ordinary [[Construct]] uses an explicit Object return instead of its receiver. */
const alwaysReturnsObject = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'array-object':
    case 'class-ref':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'data-view':
    case 'dense-buffer':
    case 'dictionary':
    case 'function':
    case 'function-and-constructor':
    case 'function-family':
    case 'function-value-dispatch':
    case 'generic-function-set':
    case 'iterator':
    case 'keyed-collection':
    case 'native-handle':
    case 'native-record-ref':
    case 'native-sequence':
    case 'promise':
    case 'proxy-object':
    case 'record':
    case 'record-with-index':
    case 'typed-array':
      return true
    case 'function-value-family':
      return !representation.optional
    case 'tagged-union':
      return representation.arms.length > 0 && representation.arms.every((arm) => alwaysReturnsObject(arm.value))
    default:
      return false
  }
}

/**
 * Publish the call entry used by a receiver-free ordinary constructor that
 * always returns an object. The semantic target authenticates [[Construct]];
 * the carrier alone cannot distinguish ordinary functions from arrows. Both
 * the body and the held closure must agree on the entry convention. Keeping
 * the invocation indirect preserves the actual closure's captures.
 */
export const explicitObjectConstructEntryOf = (operation: ConstructOperation, bodyAbi: CallableAbi | null): ConstructOperation['entry'] => {
  const callee = operation.callee.representation
  const target = operation.target
  if (
    operation.newTarget.value !== operation.callee.value ||
    callee.kind !== 'function-value-dispatch' ||
    target.kind !== 'exact' ||
    target.target.kind !== 'function' ||
    !target.target.constructable ||
    bodyAbi === null ||
    callee.abi.receiver !== null ||
    !alwaysReturnsObject(callee.abi.result) ||
    representationKey(callee) !== representationKey({ kind: 'function-value-dispatch', abi: bodyAbi })
  )
    return undefined
  return { kind: 'explicit-object-return', functionId: target.target.functionId, abi: bodyAbi }
}
