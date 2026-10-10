import { calleeRenderingOf, type CalleeRenderingInput } from '../projection/callee.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import { hostReceiverProtocolOf, hostTemplateOfRead, type HostTemplate } from '../representation/host-templates.js'
import { representationKey } from '../representation/model.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { coreHostMembers, hostMemberOf, type HostMemberTable } from '../targets/cpp/host/host-members.js'
import type { BindingReadOperation, CallOperation, ConstantOperation, GetOperation, IrOperation } from './model.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'

/** A deferred method lookup names its evaluated source frame, rather than a
 * general claim that reads of a host carrier cannot execute code.
 */
export interface NativeHostMethodRead {
  readonly invocation: SemanticResultId
  readonly receiver: IrValueId
  readonly key: IrValueId
  readonly protocol: string
  readonly member: string
}

/** Exact source and SSA producers shared by template invocation and presence proofs. */
export interface AuthenticatedNativeHostMethodRead {
  readonly read: GetOperation
  readonly receiver: BindingReadOperation
  readonly key: ConstantOperation
  readonly receipt: NativeHostMethodRead
}

/** Only a method row defers this actual Get to its authenticated call. Native
 * properties (including readonly getters) still execute at the read itself.
 * @semanticCategory generic-primitive
 */
export const authenticatedNativeHostMethodReadOf = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  rendering: CalleeRenderingInput | undefined,
  definitionOf: ((value: IrValueId) => IrOperation | null) | undefined,
  hosts: HostMemberTable = rendering?.hostMembers ?? coreHostMembers,
  expectedTemplate?: HostTemplate
): AuthenticatedNativeHostMethodRead | null => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.internalMethod !== 'call' ||
    semantic.optionalChain ||
    rendering === undefined ||
    definitionOf === undefined ||
    operation.lineage === null ||
    resultOf(semantic, 'value')?.id !== operation.lineage ||
    rendering.graph.results.get(operation.lineage) !== semantic.id ||
    rendering.graph.operations.get(semantic.id) !== semantic ||
    calleeRenderingOf(rendering, semantic) !== 'template' ||
    !authenticatedTemplateCallEntry(operation, semantic, rendering, definitionOf)
  )
    return null
  const callee = operandOf(semantic, 'callee')
  if (callee?.source.kind !== 'result') return null
  const readId = rendering.graph.results.get(callee.source.result)
  const sourceRead = readId === undefined ? undefined : rendering.graph.operations.get(readId)
  const read = definitionOf(operation.callee.value)
  if (
    sourceRead?.family !== 'property' ||
    sourceRead.internalMethod !== 'get' ||
    sourceRead.keyIsComputed ||
    resultOf(sourceRead, 'value')?.id !== callee.source.result ||
    read?.kind !== 'get' ||
    read.result.id !== operation.callee.value ||
    read.lineage !== callee.source.result ||
    representationKey(read.result.representation) !== representationKey(operation.callee.representation)
  )
    return null
  const key = operandOf(sourceRead, 'key')
  const actualKey = definitionOf(read.key.value)
  if (
    key?.source.kind !== 'constant' ||
    key.source.literal !== 'string' ||
    actualKey?.kind !== 'constant' ||
    actualKey.result.id !== read.key.value ||
    actualKey.literal !== 'string' ||
    actualKey.text !== key.source.text
  )
    return null
  const receiver = operandOf(sourceRead, 'receiver')
  if (receiver?.source.kind !== 'result') return null
  const actualReceiver = definitionOf(read.receiver.value)
  const receiverId = rendering.graph.results.get(receiver.source.result)
  const sourceReceiver = receiverId === undefined ? undefined : rendering.graph.operations.get(receiverId)
  const held = rendering.plan.selected.get(receiver.source.result)
  // The direct ambient owner read carries its declaration identity as well
  // as its lineage. An equal-shaped user object cannot borrow that origin.
  if (
    actualReceiver?.kind !== 'binding-read' ||
    actualReceiver.result.id !== read.receiver.value ||
    actualReceiver.lineage !== receiver.source.result ||
    sourceReceiver?.family !== 'binding' ||
    sourceReceiver.action !== 'read' ||
    actualReceiver.declaration !== sourceReceiver.declaration ||
    resultOf(sourceReceiver, 'value')?.id !== receiver.source.result ||
    held === undefined
  )
    return null
  const view = narrowedOperandView(held, receiver, rendering.deriver)
  const protocol = hostReceiverProtocolOf(view)
  const storage = rendering.placements.get(sourceReceiver.declaration)?.storage.kind
  const ambient = storage === 'host-class' || storage === 'host-singleton' || storage === 'host-namespace'
  // The normalized stock predicates/mutations already authenticate their
  // ambient owner. Ordinary host methods must additionally name the actual
  // ambient binding placement; a local equal-shaped host object cannot claim it.
  const stockIntrinsic =
    (expectedTemplate === 'array-is-array' && semantic.intrinsicCarrierPredicate === true) ||
    (expectedTemplate === 'object-assign' && semantic.intrinsicMutation === 'object-assign')
  if (
    representationKey(view) !== representationKey(read.receiver.representation) ||
    representationKey(actualReceiver.result.representation) !== representationKey(read.receiver.representation) ||
    protocol === null ||
    (!ambient && !stockIntrinsic) ||
    (view.kind !== 'native-handle' && !(ambient && view.kind === 'native-record-ref')) ||
    hostMemberOf(hosts, protocol.protocol, key.source.text)?.kind !== 'method' ||
    (expectedTemplate !== undefined && hostTemplateOfRead(view, key.source.text, read.result.representation) !== expectedTemplate)
  )
    return null
  return {
    read,
    receiver: actualReceiver,
    key: actualKey,
    receipt: {
      invocation: operation.lineage,
      receiver: read.receiver.value,
      key: read.key.value,
      protocol: protocol.protocol,
      member: key.source.text
    }
  }
}

/** The final callee is the intact Array.isArray read authenticated by normalization.
 * @semanticCategory generic-primitive
 */
export const authenticatedArrayIsArrayCall = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  rendering: CalleeRenderingInput | undefined,
  definitionOf: ((value: IrValueId) => IrOperation | null) | undefined
): boolean =>
  operation.intrinsicCarrierPredicate === true &&
  (operation.hostTemplate === undefined || operation.hostTemplate === 'array-is-array') &&
  semantic?.family === 'invocation' &&
  semantic.intrinsicCarrierPredicate === true &&
  authenticatedNativeHostMethodReadOf(operation, semantic, rendering, definitionOf, undefined, 'array-is-array') !== null

/** Recompute the whole lookup frame when independently certifying its receipt. */
export const nativeHostMethodReadMatches = (operation: GetOperation, expected: AuthenticatedNativeHostMethodRead | null): boolean => {
  const actual = operation.nativeHostMethodRead
  return (
    actual !== undefined &&
    expected !== null &&
    expected.read === operation &&
    actual.invocation === expected.receipt.invocation &&
    actual.receiver === expected.receipt.receiver &&
    actual.key === expected.receipt.key &&
    actual.protocol === expected.receipt.protocol &&
    actual.member === expected.receipt.member
  )
}

/** Intrinsic template flags cannot replace an ordinary frame without their source invocation proof. */
export const intrinsicCallFlagsMatch = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  rendering?: CalleeRenderingInput,
  definitionOf?: (value: IrValueId) => IrOperation | null
): boolean => {
  if (
    operation.hostTemplate === 'object-assign' &&
    (definitionOf === undefined || !authenticatedTemplateCallEntry(operation, semantic, rendering, definitionOf))
  )
    return false
  if (operation.intrinsicCarrierPredicate !== undefined && !authenticatedArrayIsArrayCall(operation, semantic, rendering, definitionOf))
    return false
  if (
    operation.intrinsicOwnKeys === undefined &&
    operation.intrinsicReflection === undefined &&
    operation.intrinsicReturnIdentity === undefined &&
    operation.intrinsicIntegrity === undefined &&
    operation.intrinsicDataDefinition === undefined
  )
    return true
  if (
    semantic?.family !== 'invocation' ||
    semantic.internalMethod !== 'call' ||
    (operation.intrinsicOwnKeys !== undefined && semantic.intrinsicOwnKeys !== true) ||
    (operation.intrinsicReflection !== undefined && operation.intrinsicReflection !== semantic.intrinsicReflection) ||
    (operation.intrinsicReturnIdentity !== undefined && operation.intrinsicReturnIdentity !== semantic.intrinsicReturnIdentity) ||
    (operation.intrinsicIntegrity !== undefined && operation.intrinsicIntegrity !== semantic.intrinsicIntegrity) ||
    (operation.intrinsicDataDefinition !== undefined &&
      (semantic.intrinsicDataDefinition !== true ||
        semantic.intrinsicMutation !== 'object-define-property' ||
        operation.argumentsAreSpread)) ||
    rendering === undefined ||
    rendering.graph.operations.get(semantic.id) !== semantic
  )
    return false
  return (
    definitionOf !== undefined &&
    rendering.graph.results.get(operation.lineage) === semantic.id &&
    (operation.intrinsicReturnIdentity === undefined || intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf)) &&
    (operation.intrinsicDataDefinition === undefined ||
      [0, 1].every((ordinal) => intrinsicCallArgumentMatches(operation, semantic, ordinal, definitionOf))) &&
    authenticatedTemplateCallEntry(operation, semantic, rendering, definitionOf)
  )
}

/** An intrinsic receipt belongs to its actual evaluated argument, not its ABI. */
export const intrinsicCallArgumentMatches = (
  operation: CallOperation,
  semantic: Extract<SemanticOperation, { family: 'invocation' }>,
  ordinal: number,
  definitionOf: (value: IrValueId) => IrOperation | null
): boolean => {
  const expected = operandOf(semantic, 'argument', ordinal)
  let value = operation.arguments[ordinal]?.value
  if (expected === undefined || value === undefined || operation.argumentsAreSpread) return false
  const seen = new Set<IrValueId>()
  while (!seen.has(value)) {
    seen.add(value)
    const producer = definitionOf(value)
    if (producer === null || !('result' in producer) || producer.result === null || producer.result.id !== value) return false
    if (producer.kind === 'convert') {
      value = producer.source.value
      continue
    }
    const source = expected.source
    if (source.kind === 'result') return producer.lineage === source.result
    if (source.kind === 'constant')
      return producer.kind === 'constant' && producer.literal === source.literal && producer.text === source.text
    if (source.kind === 'parameter') return producer.kind === 'parameter' && producer.ordinal === source.ordinal
    return false
  }
  return false
}
