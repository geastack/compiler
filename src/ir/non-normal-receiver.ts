import { isMaterializable } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { FunctionId, IrValueId, SemanticResultId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from '../representation/native-logical-receiver.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { genericNativeLogicalReceiverOf } from './call-entry.js'
import type { CallCalleeIdentity, CallOperation, IrBody, IrBlockId, IrOperation } from './model.js'
import { literalPrimitiveOf, noNormalCallCompletionOf } from './no-normal-call-completion.js'
import { resultOfIrOperation } from './queries.js'

export interface NonNormalReceiverArm {
  readonly carrier: string
  readonly proxy: IrValueId
  readonly handler: IrValueId
  readonly trap: IrValueId
  readonly trapCall: IrValueId
  readonly input: IrValueId
  readonly functionId: FunctionId
  readonly key: string
}

/**
 * A receipt for exact unsupported receiver arms whose own ECMAScript Proxy Get cannot produce a Function normally.
 * @semanticCategory generic-primitive
 */
export interface NonNormalReceiverProof {
  readonly receiver: IrValueId
  readonly callee: IrValueId
  readonly arms: readonly NonNormalReceiverArm[]
  readonly conversions: readonly string[]
}

export interface NonNormalReceiverInput {
  readonly body: IrBody
  readonly bodies: Iterable<IrBody>
  readonly conversions: Pick<ConversionCensus, 'nodeById'>
  readonly callables: ReadonlyMap<IrValueId, CallCalleeIdentity>
  readonly definitionOf: (value: IrValueId) => IrOperation | null
  readonly semantic: SemanticOperation | null
  readonly semanticOperationOf: (lineage: SemanticResultId) => SemanticOperation | null
}

const unsupportedArmsOf = (value: Representation): readonly Representation[] => {
  if (value.kind === 'optional') return unsupportedArmsOf(value.payload)
  if (value.kind === 'tagged-union') return value.arms.flatMap((arm) => unsupportedArmsOf(arm.value))
  return nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(value)) ? [] : [value]
}

/** Every link is an actual SSA definition in this body, selected by its own canonical payload recipe. */
const sameReceiver = (value: IrValueId, root: IrValueId, input: NonNormalReceiverInput, citations: Set<string>): boolean => {
  const visited = new Set<IrValueId>()
  while (value !== root && !visited.has(value)) {
    visited.add(value)
    const operation = input.definitionOf(value)
    if (operation === null || resultOfIrOperation(operation)?.id !== value) return false
    if (operation.kind === 'compute' && operation.form === 'require-object-coercible' && operation.operands.length === 1) {
      value = operation.operands[0]!.value
      continue
    }
    if (operation.kind !== 'convert' || operation.rebuild !== undefined) return false
    const node = input.conversions.nodeById(operation.conversionUse)
    if (!nativePayloadTransportMatches(operation.source.representation, operation.result.representation, node) || node === null)
      return false
    citations.add(node.id)
    value = operation.source.value
  }
  return value === root
}

/**
 * This proves only Proxy [[Get]]'s selected trap path. The native remainder keeps
 * its real receiver, and the original trap and all preceding effects remain in IR.
 */
export const nonNormalReceiverProofOf = (operation: CallOperation, input: NonNormalReceiverInput): NonNormalReceiverProof | undefined => {
  const logical = genericNativeLogicalReceiverOf(operation)
  if (
    logical === null ||
    input.semantic?.family !== 'invocation' ||
    input.semantic.internalMethod !== 'call' ||
    resultOf(input.semantic, 'value')?.id !== operation.lineage
  )
    return undefined
  const semanticCallee = operandOf(input.semantic, 'callee')?.source
  if (semanticCallee?.kind !== 'result') return undefined
  const property = input.semanticOperationOf(semanticCallee.result)
  if (property?.family !== 'property' || property.internalMethod !== 'get' || resultOf(property, 'value')?.id !== semanticCallee.result)
    return undefined
  const selectedKey = operandOf(property, 'key')?.source
  const selectedReceiver = operandOf(property, 'receiver')?.source
  if (selectedKey?.kind !== 'constant' || selectedKey.literal !== 'string' || selectedReceiver === undefined) return undefined
  const unsupported = unsupportedArmsOf(logical.representation)
  if (unsupported.length === 0 || unsupported.some((arm) => arm.kind !== 'proxy-object')) return undefined
  const roots = new Map<FunctionId, IrBody[]>()
  for (const body of input.bodies) {
    const id = body.sourceOwner as FunctionId
    const family = roots.get(id) ?? []
    family.push(body)
    roots.set(id, family)
  }
  const locations = new Map<IrValueId, IrBlockId>()
  for (const block of input.body.blocks.values())
    for (const value of block.operations) {
      const result = resultOfIrOperation(value)
      if (result !== null) locations.set(result.id, block.id)
    }
  const citations = new Set<string>()
  let receiver = logical.value
  const receiverSeen = new Set<IrValueId>()
  let receiverAuthenticated = false
  while (!receiverSeen.has(receiver)) {
    receiverSeen.add(receiver)
    const value = input.definitionOf(receiver)
    if (value === null || resultOfIrOperation(value)?.id !== receiver) break
    if (selectedReceiver.kind === 'result' && value.lineage === selectedReceiver.result) {
      receiverAuthenticated = true
      break
    }
    if (
      property.caller.kind === 'function' &&
      property.caller.functionId === input.body.sourceOwner &&
      ((selectedReceiver.kind === 'parameter' && value.kind === 'parameter' && value.ordinal === selectedReceiver.ordinal) ||
        (selectedReceiver.kind === 'receiver' && value.kind === 'receiver'))
    ) {
      receiverAuthenticated = true
      break
    }
    if (value.kind === 'compute' && value.form === 'require-object-coercible' && value.operands.length === 1)
      receiver = value.operands[0]!.value
    else if (value.kind === 'convert' && sameReceiver(value.result.id, value.source.value, input, citations)) receiver = value.source.value
    else break
  }
  if (!receiverAuthenticated) return undefined
  let callee = operation.callee.value
  const peeled = new Set<IrValueId>()
  while (!peeled.has(callee)) {
    peeled.add(callee)
    const convert = input.definitionOf(callee)
    if (convert?.kind !== 'convert' || convert.rebuild !== undefined) break
    // The trap's checked Function bridge is the witnessed input itself, not
    // an outer native alias to peel before inspecting the Get path.
    if (convert.source.representation.kind === 'dynamic' && abiOfCallee(convert.result.representation) !== null) break
    const node = input.conversions.nodeById(convert.conversionUse)
    if (node === null || !nativePayloadTransportMatches(convert.source.representation, convert.result.representation, node))
      return undefined
    citations.add(node.id)
    callee = convert.source.value
  }
  const producer = input.definitionOf(callee)
  if (producer === null || producer.lineage !== semanticCallee.result || resultOfIrOperation(producer)?.id !== callee) return undefined
  const edges = producer.kind === 'phi' ? producer.incoming : [{ block: locations.get(callee), value: operation.callee }]
  const arms: NonNormalReceiverArm[] = []
  for (const edge of edges) {
    const converted = input.definitionOf(edge.value.value)
    if (
      converted?.kind !== 'convert' ||
      converted.lineage !== producer.lineage ||
      converted.rebuild !== undefined ||
      abiOfCallee(converted.result.representation) === null ||
      converted.source.representation.kind !== 'dynamic'
    )
      continue
    const conversion = input.conversions.nodeById(converted.conversionUse)
    if (
      conversion === null ||
      !isMaterializable(conversion.capability) ||
      representationKey(conversion.source) !== representationKey(converted.source.representation) ||
      representationKey(conversion.target) !== representationKey(converted.result.representation)
    )
      continue
    const called = input.definitionOf(converted.source.value)
    if (
      called?.kind !== 'call' ||
      called.lineage !== producer.lineage ||
      called.result?.id !== converted.source.value ||
      called.closedCallee?.kind !== 'exact' ||
      called.argumentsAreSpread ||
      called.receiver !== null
    )
      continue
    const trap = input.definitionOf(called.callee.value)
    const identity = input.callables.get(called.callee.value)
    if (
      trap?.kind !== 'get' ||
      trap.lineage !== producer.lineage ||
      identity?.kind !== 'exact' ||
      identity.functionId !== called.closedCallee.functionId
    )
      continue
    const trapName = input.definitionOf(trap.key.value)
    const handler = input.definitionOf(trap.receiver.value)
    if (
      trapName?.kind !== 'constant' ||
      trapName.literal !== 'string' ||
      trapName.text !== 'get' ||
      handler?.kind !== 'proxy-part' ||
      handler.part !== 'handler' ||
      handler.lineage !== producer.lineage ||
      handler.proxy.representation.kind !== 'proxy-object' ||
      representationKey(handler.result.representation) !== representationKey(handler.proxy.representation.handler)
    )
      continue
    const carrier = representationKey(handler.proxy.representation)
    if (
      !unsupported.some((arm) => representationKey(arm) === carrier) ||
      !sameReceiver(handler.proxy.value, logical.value, input, citations)
    )
      continue
    const variants = roots.get(identity.functionId)
    const body = variants?.length === 1 ? variants[0] : undefined
    const abi = abiOfCallee(called.callee.representation)
    if (body?.abi === null || body === undefined || abi === null || abiKey(body.abi) !== abiKey(abi)) continue
    const key = called.arguments[1]
    const keyLiteral = key === undefined ? undefined : literalPrimitiveOf(key, input.definitionOf, input.conversions, citations)
    if (typeof keyLiteral?.value !== 'string' || keyLiteral.value !== selectedKey.text) continue
    if (producer.kind === 'phi') {
      if (
        producer.incoming.length !== 2 ||
        edge.block === undefined ||
        locations.get(converted.result.id) !== edge.block ||
        locations.get(called.result.id) !== edge.block ||
        locations.get(trap.result.id) !== edge.block ||
        locations.get(handler.result.id) !== edge.block
      )
        continue
      const join = locations.get(producer.result.id)
      const other = producer.incoming.find((value) => value !== edge)
      if (join === undefined || other === undefined) continue
      const plain = input.definitionOf(other.value.value)
      if (plain?.kind !== 'get' || plain.lineage !== producer.lineage || locations.get(plain.result.id) !== other.block) continue
      const plainKey = literalPrimitiveOf(plain.key, input.definitionOf, input.conversions, citations)
      if (plainKey?.value !== selectedKey.text) continue
      const remainder = input.definitionOf(plain.receiver.value)
      if (remainder?.kind !== 'merge-live-arm-rebuild' || !sameReceiver(remainder.source.value, logical.value, input, citations)) continue
      const source = remainder.source.representation
      if (
        source.kind !== 'tagged-union' ||
        remainder.sourceAbsenceLive ||
        source.arms.filter((arm) => arm.value.kind === 'proxy-object').length !== 1 ||
        remainder.liveArms.length !== source.arms.filter((arm) => arm.value.kind !== 'proxy-object').length ||
        remainder.liveArms.some(
          (index, ordinal) => source.arms[index]?.value.kind === 'proxy-object' || index <= (remainder.liveArms[ordinal - 1] ?? -1)
        ) ||
        !source.arms.some((arm) => representationKey(arm.value) === carrier)
      )
        continue
      const branch = [...input.body.blocks.values()].find((block) => {
        const end = block.terminator
        if (end.kind !== 'branch' || end.whenTrue !== edge.block || end.whenFalse !== other.block) return false
        const test = input.definitionOf(end.condition.value)
        return (
          test?.kind === 'proxy-arm-test' &&
          test.lineage === producer.lineage &&
          sameReceiver(test.value.value, remainder.source.value, input, citations)
        )
      })
      if (
        branch === undefined ||
        [edge.block, other.block].some((id) => {
          const end = input.body.blocks.get(id)?.terminator
          return end?.kind !== 'jump' || end.target !== join
        })
      )
        continue
    } else if (handler.proxy.value !== logical.value) continue
    const noNormal = noNormalCallCompletionOf(body, called.arguments, input.definitionOf, input.conversions)
    if (noNormal === null) continue
    citations.add(conversion.id)
    for (const id of noNormal) citations.add(id)
    arms.push({
      carrier,
      proxy: handler.proxy.value,
      handler: handler.result.id,
      trap: trap.result.id,
      trapCall: called.result.id,
      input: converted.result.id,
      functionId: identity.functionId,
      key: keyLiteral.value
    })
  }
  if (
    arms.length !== unsupported.length ||
    unsupported.some((arm) => arms.filter((proof) => proof.carrier === representationKey(arm)).length !== 1)
  )
    return undefined
  return { receiver: logical.value, callee: operation.callee.value, arms, conversions: [...citations].sort() }
}

export const nonNormalReceiverProofMatches = (operation: CallOperation, input: NonNormalReceiverInput): boolean => {
  const expected = nonNormalReceiverProofOf(operation, input)
  return expected !== undefined && JSON.stringify(operation.nonNormalReceiverProof) === JSON.stringify(expected)
}
