import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeCallableIdentityTransportMatches } from '../conversion/native-callable-adapter.js'
import { recipeIsMaterializableWithoutPriorSourceGuard, recipePreservesNativePayload } from '../conversion/recipe-closure.js'
import type { DeclarationId, FunctionId, IrValueId, SemanticResultId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { abiKey, representationKey, type CallableAbi } from '../representation/model.js'
import { callableOwnPrototypeAt, callableOwnPrototypeOf } from '../semantics/callable-origins.js'
import { operandOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { authenticatedNativeHostMethodReadOf, intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperand, type IrOperation } from './model.js'
import type { NativeCallableDataSlotInput } from './native-callable-data-slots.js'
import { resultOfIrOperation } from './queries.js'

/** The native MakeConstructor table retains this actual allocation's current
 * physical entry. Source Function identity alone cannot license boxing a
 * public adapter with a different receiver, parameter, result or rest frame.
 * @semanticCategory generic-primitive
 */
export interface NativeCallablePrototype {
  readonly owner: FunctionId
  readonly allocation: IrValueId
  readonly source: SemanticResultId
  readonly receiver: IrOperand
  readonly entry: CallableAbi
  readonly materialization: ConversionNodeId | null
}

export const nativeCallablePrototypeSourceAuthorityOf = (input: NativeCallableDataSlotInput) => {
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, { readonly block: object; readonly index: number }>()
  const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  const allocations = new Map<SemanticResultId, Extract<IrOperation, { kind: 'allocate-callable' }> | null>()
  const initializers = new Map<DeclarationId, Extract<SemanticOperation, { family: 'binding' }> | null>()
  const sourceBodies = new Map<FunctionId, IrBody | null>()
  for (const operation of input.graph.operations.values()) {
    if (operation.family !== 'binding' || !['initialize', 'write'].includes(operation.action)) continue
    initializers.set(
      operation.declaration,
      operation.action === 'initialize' && !initializers.has(operation.declaration) ? operation : null
    )
  }
  for (const body of input.bodies.values()) {
    const source = body.sourceOwner as FunctionId
    sourceBodies.set(source, sourceBodies.has(source) ? null : body)
    for (const block of body.blocks.values())
      for (const [index, operation] of allOperationsOf(block).entries()) {
        positions.set(operation, { block, index })
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        if (operation.kind === 'allocate-callable' && operation.lineage !== null)
          allocations.set(operation.lineage, allocations.has(operation.lineage) ? null : operation)
        if (operation.kind === 'binding-write') {
          const rows = writes.get(operation.declaration) ?? []
          rows.push(operation)
          writes.set(operation.declaration, rows)
        }
      }
  }
  const semanticOf = (operation: IrOperation): SemanticOperation | undefined => {
    const id = operation.lineage === null ? undefined : input.graph.results.get(operation.lineage)
    return id === undefined ? undefined : input.graph.operations.get(id)
  }
  const allocationOf = (
    value: IrValueId,
    use: IrOperation,
    expected: SemanticResultId,
    seen = new Set<IrValueId>()
  ): Extract<IrOperation, { kind: 'allocate-callable' }> | null => {
    if (seen.has(value)) return null
    seen.add(value)
    const source = definitions.get(value)
    const from = source && positions.get(source)
    const at = positions.get(use)
    if (!source || !from || !at || from.block !== at.block || from.index >= at.index) return null
    if (
      source.kind === 'convert' &&
      nativeCallableIdentityTransportMatches(
        source.source.representation,
        source.result.representation,
        input.conversions.nodeById(source.conversionUse)
      )
    )
      return allocationOf(source.source.value, source, expected, seen)
    if (source.lineage === null || !nativeCallableSourceAliasesOf(input.graph, expected).has(source.lineage)) return null
    if (source.kind === 'allocate-callable') return source
    if (source.kind !== 'binding-read' || !['local', 'region'].includes(input.placements.get(source.declaration)?.storage.kind ?? ''))
      return null
    const read = semanticOf(source)
    const initializer = initializers.get(source.declaration)
    if (
      read?.family !== 'binding' ||
      read.action !== 'read' ||
      read.declaration !== source.declaration ||
      read.external !== undefined ||
      !initializer ||
      initializer.parameterInitialization === true
    )
      return null
    const rows = writes.get(source.declaration)
    const writer = rows?.length === 1 ? rows[0] : undefined
    const before = writer && positions.get(writer)
    const initialized = operandOf(initializer, 'initializer')
    // Ordinary Function declarations have mutable lexical bindings. Their
    // exact one initializer can still be followed when both inventories and
    // the finalized same-block SSA writer agree; a mutable type alone cannot.
    return writer &&
      semanticOf(writer)?.id === initializer.id &&
      initialized?.source.kind === 'result' &&
      before?.block === at.block &&
      before.index < from.index
      ? allocationOf(writer.value.value, writer, initialized.source.result, seen)
      : null
  }
  return (
    operation: IrOperation,
    receiver: IrOperand,
    semantic: SemanticOperation,
    role: string,
    ordinal = 0
  ): NativeCallablePrototype | null => {
    const operand = operandOf(semantic, role, ordinal)
    if (operand?.source.kind !== 'result' || !isNativeCallableCarrier(receiver.representation.kind)) return null
    const allocation = allocationOf(receiver.value, operation, operand.source.result)
    if (!allocation?.lineage) return null
    const allocationId = input.graph.results.get(allocation.lineage)
    const declared = allocationId === undefined ? undefined : input.graph.operations.get(allocationId)
    const actual = input.callableFlow.callableIdentityOrigins.get(receiver.value)
    const entry = abiOfCallee(receiver.representation)
    const allocatedEntry = abiOfCallee(allocation.result.representation)
    const body = sourceBodies.get(allocation.functionId)
    if (
      declared?.family !== 'allocation' ||
      allocations.get(allocation.lineage) !== allocation ||
      declared.callable !== allocation.functionId ||
      declared.ownPrototypeProperty !== true ||
      allocation.callableOwnPrototype !== true ||
      callableOwnPrototypeOf(input.graph, allocation.functionId) !== true ||
      actual?.length !== 1 ||
      actual[0] !== allocation.functionId ||
      !entry ||
      !allocatedEntry ||
      !body?.abi ||
      abiKey(entry) !== abiKey(body.abi) ||
      abiKey(entry) !== abiKey(allocatedEntry)
    )
      return null
    return {
      owner: allocation.functionId,
      allocation: allocation.result.id,
      source: allocation.lineage,
      receiver,
      entry,
      materialization: null
    }
  }
}

export const nativeCallablePrototypeReadsOf = (input: NativeCallableDataSlotInput) => {
  const required = new Set<IrOperation>()
  const receipts = new Map<IrOperation, NativeCallablePrototype>()
  const sourceOf = nativeCallablePrototypeSourceAuthorityOf(input)
  for (const body of input.bodies.values()) {
    const operations = [...body.blocks.values()].flatMap(allOperationsOf)
    const definitions = new Map<IrValueId, IrOperation>()
    for (const operation of operations) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
    for (const operation of operations) {
      if (operation.kind !== 'get' || !isNativeCallableCarrier(operation.receiver.representation.kind)) continue
      const key = definitions.get(operation.key.value)
      if (key?.kind !== 'constant' || key.literal !== 'string' || key.text !== 'prototype') continue
      const semanticId = input.graph.results.get(operation.lineage)
      const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
      // A constructor carrier's `prototype` is fixed by the carrier itself
      // (`GetOperation.callableOwnPrototype`): being constructable is the
      // proof, and the printer reads it from inside the runtime. Lowering
      // carries no verdict for it, so demanding one here refused every such
      // read with no receipt it could ever earn.
      if (
        operation.callableOwnPrototype !== true &&
        (operation.receiver.representation.kind === 'function-and-constructor' ||
          !semantic ||
          callableOwnPrototypeAt(input.graph, semantic) !== true)
      )
        continue
      required.add(operation)
      const sourceKey = semantic && operandOf(semantic, 'key')
      if (
        operation.callableOwnPrototype !== true ||
        semantic?.family !== 'property' ||
        semantic.internalMethod !== 'get' ||
        sourceKey?.source.kind !== 'constant' ||
        sourceKey.source.literal !== 'string' ||
        sourceKey.source.text !== key.text
      )
        continue
      const proof = sourceOf(operation, operation.receiver, semantic, 'receiver')
      if (!proof || operation.result.representation.kind !== 'dynamic') continue
      const node = input.conversions.nodeFor(operation.receiver.representation, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
      if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) continue
      receipts.set(operation, { ...proof, materialization: node.id })
    }
  }
  return { required, receipts }
}

/** An actual declared-any conversion may later expose the original prototype
 * through the erased Function. Publish its callback before that conversion,
 * over the same physical entry and canonical recipe, without executing it.
 */
export const nativeCallablePrototypeObservationsOf = (input: NativeCallableDataSlotInput) => {
  const receipts = new Map<IrOperation, NativeCallablePrototype>()
  const sourceOf = nativeCallablePrototypeSourceAuthorityOf(input)
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (
          operation.kind !== 'convert' ||
          operation.result.representation.kind !== 'dynamic' ||
          operation.result.representation.reason !== 'declared-any-never-narrowed'
        )
          continue
        const node = input.conversions.nodeById(operation.conversionUse)
        if (
          !node ||
          representationKey(node.source) !== representationKey(operation.source.representation) ||
          representationKey(node.target) !== representationKey(operation.result.representation) ||
          !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
        )
          continue
        const semanticId = input.graph.results.get(operation.lineage)
        const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
        if (!semantic) continue
        for (const operand of semantic.operands) {
          const proof = sourceOf(operation, operation.source, semantic, operand.role, operand.ordinal)
          if (proof) {
            receipts.set(operation, { ...proof, materialization: node.id })
            break
          }
        }
      }
  return receipts
}

/** A descriptor's value is a genuine dynamic observation. Authenticate the
 * actual Function entry before publishing either native holder's callback;
 * a name/length lookup never needs this prototype observation.
 */
export const nativeCallablePrototypeDescriptorsOf = (input: NativeCallableDataSlotInput) => {
  const required = new Set<IrOperation>()
  const receipts = new Map<IrOperation, NativeCallablePrototype>()
  const sourceOf = nativeCallablePrototypeSourceAuthorityOf(input)
  for (const body of input.bodies.values()) {
    const operations = [...body.blocks.values()].flatMap(allOperationsOf)
    const definitions = new Map<IrValueId, IrOperation>()
    for (const operation of operations) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
    for (const operation of operations) {
      if (operation.kind !== 'call') continue
      const receiver = operation.arguments[0]
      const key = operation.arguments[1]
      if (!receiver || !key || !isNativeCallableCarrier(receiver.representation.kind) || key.representation.kind === 'symbol') continue
      const literal = definitions.get(key.value)
      const semanticId = input.graph.results.get(operation.lineage)
      const semantic = semanticId === undefined ? null : (input.graph.operations.get(semanticId) ?? null)
      const entry = authenticatedNativeHostMethodReadOf(
        operation,
        semantic,
        input.calleeRendering,
        (value) => definitions.get(value) ?? null
      )
      if (
        !entry ||
        !['ObjectConstructor', 'gea::ReflectNamespace'].includes(entry.receipt.protocol) ||
        entry.receipt.member !== 'getOwnPropertyDescriptor'
      )
        continue
      const frameMatches =
        semantic?.family === 'invocation' &&
        operation.arguments.length === 2 &&
        [0, 1].every((ordinal) => intrinsicCallArgumentMatches(operation, semantic, ordinal, (value) => definitions.get(value) ?? null))
      if (frameMatches && literal?.kind === 'constant' && literal.literal === 'string' && literal.text !== 'prototype') continue
      const domain = semantic?.family === 'invocation' ? semantic.intrinsicDescriptorKeys : undefined
      const sourceKey = semantic && operandOf(semantic, 'argument', 1)
      if (
        semantic?.family === 'invocation' &&
        semantic.intrinsicReflection === 'getOwnPropertyDescriptor' &&
        domain !== undefined &&
        sourceKey?.source.kind === 'result' &&
        domain.key === sourceKey.source.result &&
        domain.names.length > 0 &&
        domain.names.every((name) => name !== 'prototype') &&
        frameMatches &&
        descriptorKeyTransportMatches(operation, input, definitions)
      )
        continue
      const owners = input.callableFlow.callableIdentityOrigins.get(receiver.value)
      if (owners?.length && owners.every((owner) => callableOwnPrototypeOf(input.graph, owner) === false)) continue
      required.add(operation)
      if (semantic?.family !== 'invocation' || !frameMatches) continue
      const proof = sourceOf(operation, receiver, semantic, 'argument')
      if (!proof) continue
      const node = input.conversions.nodeFor(receiver.representation, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
      if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) continue
      receipts.set(operation, { ...proof, materialization: node.id })
    }
  }
  return { required, receipts }
}

/** The source domain concerns the actual key value before carrier adaptation.
 * Only the canonical payload-preserving path can transport that domain to the
 * evaluated descriptor argument; an unrelated or lossy conversion cannot. */
const descriptorKeyTransportMatches = (
  operation: CallOperation,
  input: NativeCallableDataSlotInput,
  definitions: ReadonlyMap<IrValueId, IrOperation>
): boolean => {
  let actual = operation.arguments[1]
  const seen = new Set<IrValueId>()
  while (actual && !seen.has(actual.value)) {
    seen.add(actual.value)
    const producer = definitions.get(actual.value)
    const result = producer && resultOfIrOperation(producer)
    if (!result || result.id !== actual.value || representationKey(result.representation) !== representationKey(actual.representation))
      return false
    if (producer?.kind !== 'convert') return true
    const node = input.conversions.nodeById(producer.conversionUse)
    if (
      !node ||
      representationKey(node.source) !== representationKey(producer.source.representation) ||
      representationKey(node.target) !== representationKey(producer.result.representation) ||
      !recipePreservesNativePayload(node, input.conversions.nodeById) ||
      !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
    )
      return false
    actual = producer.source
  }
  return false
}

export const nativeCallablePrototypeMatches = (
  expected: NativeCallablePrototype | undefined,
  actual: NativeCallablePrototype | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  expected.owner === actual.owner &&
  expected.allocation === actual.allocation &&
  expected.source === actual.source &&
  expected.receiver.value === actual.receiver.value &&
  representationKey(expected.receiver.representation) === representationKey(actual.receiver.representation) &&
  abiKey(expected.entry) === abiKey(actual.entry) &&
  expected.materialization === actual.materialization
