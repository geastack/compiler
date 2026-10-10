import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNodeId } from '../conversion/algebra.js'
import type { DeclarationId, IrValueId, OperationId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { representationKey, type Representation } from '../representation/model.js'
import {
  callableDataDefinitionDescriptorIsData,
  nativeCallableDataCarrierHasStorageIdentity,
  type NativeCallableDataPlan
} from '../representation/native-callable-data-storage.js'
import { identityOperandOf, immutableBindingInitializerOf, operandOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { IrBody, IrOperand, IrOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { resultOfIrOperation } from './queries.js'
import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import { nativeCallableDataOwnerAuthorityOf, type NativeCallableDataOwnerAuthority } from './native-callable-data-owner.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { NativeCallableFlow } from './callable-class-flow.js'

/** Ordinary descriptor mutation retains the actual typed payload, independently
 * of a later read's all-writer/presence proof.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataWrite {
  readonly writer: OperationId
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly value: IrOperand
  readonly storedValue: IrOperand
  readonly storage: Representation
  readonly storageConversion: ConversionNodeId
  readonly storageFits: readonly {
    readonly writer: OperationId
    readonly source: Representation
    readonly conversion: ConversionNodeId
  }[]
  readonly materialization: ConversionNodeId | null
  /** The intact data-only owner/key proof does not request a dynamic setter
   * receiver. Keep a callback only when such an entry is independently proved. */
  readonly receiverMaterialization: ConversionNodeId | null
  /** 'own-table': no program Function can own the target and the intact
   * stock chain is answered by the runtime own-table [[Set]]; the writer
   * keeps its payload and receiver callbacks for every observation. */
  readonly prototypeProtocol: 'absent' | 'builtin' | 'own-facts' | 'own-table'
  /** An Object.defineProperty data definition: the holder is the literal
   * descriptor's own `value` field, installed by [[DefineOwnProperty]] rather
   * than [[Set]]. `value`/`storedValue` name the descriptor operand. */
  readonly definition?: true
}

/** @semanticCategory generic-primitive */
export interface NativeCallableDataWriteInput {
  readonly graph: SemanticGraph
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly conversions: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly deriver: RepresentationDeriver
  readonly callableFlow: NativeCallableFlow
  readonly nativeCallableData: NativeCallableDataPlan
}

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

// This first writer entry does not grant an erased Function argument frame.
// Function-valued slots still need their separately authenticated source ABI,
// unless no typed read can consume the slot at all: an own-table write's
// payload is only ever observed through its dynamic materializer.
const supportedPayload = (value: Representation, callable = false): boolean =>
  value.kind === 'optional'
    ? supportedPayload(value.payload, callable)
    : value.kind === 'tagged-union'
      ? value.arms.every((arm) => supportedPayload(arm.value, callable))
      : (callable || !isNativeCallableCarrier(value.kind)) && value.kind !== 'dynamic' && nativeCallableDataCarrierHasStorageIdentity(value)

/** Actual evaluated operands, rather than a signature or source key spelling,
 * authenticate a native write. The ordinary descriptor engine retains setter,
 * inherited writable, extensibility and strict-assignment effects.
 */
export const nativeCallableDataWritesOf = (input: NativeCallableDataWriteInput): ReadonlyMap<IrOperation, NativeCallableDataWrite> => {
  const owners = nativeCallableDataOwnerAuthorityOf(input)
  const definitions = new Map<IrValueId, IrOperation>()
  const operations: IrOperation[] = []
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        operations.push(operation)
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
      }
  const matches = (actual: IrOperand, expected: SemanticOperand | undefined): boolean => {
    if (!expected) return false
    const aliases = new Set<string>()
    let source = expected.source
    while (source.kind === 'result' && !aliases.has(source.result)) {
      aliases.add(source.result)
      const id = input.graph.results.get(source.result)
      const producer = id === undefined ? undefined : input.graph.operations.get(id)
      const alias =
        producer === undefined ? undefined : (identityOperandOf(producer) ?? immutableBindingInitializerOf(input.graph, producer))
      if (!alias) break
      source = alias.source
    }
    let value = actual.value
    const seen = new Set<IrValueId>()
    while (!seen.has(value)) {
      seen.add(value)
      const producer = definitions.get(value)
      if (!producer || resultOfIrOperation(producer)?.id !== value) return false
      if (producer.lineage !== null && aliases.has(producer.lineage)) return true
      if (producer.kind === 'convert') {
        const node = input.conversions.nodeById(producer.conversionUse)
        if (!node || !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return false
        value = producer.source.value
        continue
      }
      if (source.kind === 'constant')
        return producer.kind === 'constant' && producer.literal === source.literal && producer.text === source.text
      if (source.kind === 'parameter') return producer.kind === 'parameter' && producer.ordinal === source.ordinal
      return false
    }
    return false
  }
  const definitionReceiptOf = (
    operation: IrOperation,
    semantic: SemanticOperation | undefined,
    owners: NativeCallableDataOwnerAuthority,
    matches: (actual: IrOperand, expected: SemanticOperand | undefined) => boolean
  ): NativeCallableDataWrite | null => {
    if (
      operation.kind !== 'call' ||
      semantic?.family !== 'invocation' ||
      semantic.intrinsicMutation !== 'object-define-property' ||
      operation.argumentsAreSpread ||
      operation.arguments.length !== 3 ||
      semantic.operands.filter((operand) => operand.role === 'argument').length !== 3 ||
      !callableDataDefinitionDescriptorIsData(semantic)
    )
      return null
    const [receiver, key, descriptor] = operation.arguments as [IrOperand, IrOperand, IrOperand]
    const ownNames = semantic.descriptorOwnProtocol!.ownNames
    const field =
      descriptor.representation.kind === 'record' ? descriptor.representation.fields.find(({ key }) => key === 'value') : undefined
    if (
      !isNativeCallableCarrier(receiver.representation.kind) ||
      // A constructor's non-configurable prototype has its own authority.
      definitions.get(key.value)?.kind !== 'constant' ||
      descriptor.representation.kind !== 'record' ||
      descriptor.representation.accessors.length !== 0 ||
      descriptor.representation.fields.length !== ownNames.length ||
      !descriptor.representation.fields.every((held) => held.required && ownNames.includes(held.key)) ||
      field === undefined ||
      !supportedPayload(field.value) ||
      ![receiver, key, descriptor].every((operand, ordinal) => matches(operand, operandOf(semantic, 'argument', ordinal)))
    )
      return null
    const keyText = definitions.get(key.value)
    if (keyText?.kind !== 'constant' || keyText.literal !== 'string' || keyText.text === 'prototype') return null
    const prototypeProtocol = owners.protocolAt(operation, semantic, receiver, key)
    if (prototypeProtocol === null) return null
    const storage = field.value
    const storageNode = input.conversions.nodeFor(storage, storage)
    const payload =
      owners.dynamicObservationAt(operation, semantic, receiver, key) === false ? null : input.conversions.nodeFor(storage, dynamic)
    if (
      !recipeHasNormalResult(storageNode, input.conversions.nodeById) ||
      !recipePreservesNativePayload(storageNode, input.conversions.nodeById) ||
      (payload !== null && !recipeIsMaterializableWithoutPriorSourceGuard(payload, input.conversions.nodeById))
    )
      return null
    return {
      writer: semantic.id,
      receiver,
      key,
      value: descriptor,
      storedValue: descriptor,
      storage,
      storageConversion: storageNode.id,
      storageFits: [],
      prototypeProtocol,
      materialization: payload?.id ?? null,
      // [[DefineOwnProperty]] never runs an accessor with this receiver.
      receiverMaterialization: null,
      definition: true
    }
  }
  const receipts = new Map<IrOperation, NativeCallableDataWrite>()
  for (const operation of operations) {
    if (operation.kind !== 'set' && operation.kind !== 'call') continue
    if (operation.kind === 'set' && operation.privateNativeCallableSlot !== undefined) continue
    const semanticId = input.graph.results.get(operation.lineage)
    const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
    let actual: { receiver: IrOperand; key: IrOperand; value: IrOperand } | null = null
    let roles: readonly [string, number][]
    if (operation.kind === 'set' && semantic?.family === 'property' && semantic.internalMethod === 'set') {
      actual = operation
      roles = [
        ['receiver', 0],
        ['key', 0],
        ['value', 0]
      ]
    } else if (
      operation.kind === 'call' &&
      semantic?.family === 'invocation' &&
      semantic.intrinsicReflection === 'set' &&
      operation.intrinsicReflection === 'set' &&
      !operation.argumentsAreSpread &&
      operation.arguments.length === 3 &&
      semantic.operands.filter((operand) => operand.role === 'argument').length === 3
    ) {
      actual = { receiver: operation.arguments[0]!, key: operation.arguments[1]!, value: operation.arguments[2]! }
      roles = [
        ['argument', 0],
        ['argument', 1],
        ['argument', 2]
      ]
    } else {
      const definition = definitionReceiptOf(operation, semantic, owners, matches)
      if (definition !== null) receipts.set(operation, definition)
      continue
    }
    if (
      !actual ||
      !semantic ||
      !isNativeCallableCarrier(actual.receiver.representation.kind) ||
      !supportedPayload(actual.value.representation, true)
    )
      continue
    const proved = owners.protocolAt(operation, semantic, actual.receiver, actual.key)
    const ownTable = proved === null && owners.ownTableAt(operation, semantic, actual.receiver, actual.key)
    const prototypeProtocol = ownTable ? 'own-table' : proved
    if (prototypeProtocol === null || (!ownTable && !supportedPayload(actual.value.representation))) continue
    if (
      ![actual.receiver, actual.key, actual.value].every((operand, index) =>
        matches(operand, operandOf(semantic, roles[index]![0], roles[index]![1]))
      )
    )
      continue
    const held = ownTable ? null : owners.storageAt(operation, semantic, actual.receiver, actual.key)
    let storedValue = actual.value
    const seen = new Set<IrValueId>()
    while (held !== null && !seen.has(storedValue.value)) {
      seen.add(storedValue.value)
      const producer = definitions.get(storedValue.value)
      if (producer?.kind !== 'convert') break
      const node = input.conversions.nodeById(producer.conversionUse)
      if (
        !node ||
        representationKey(node.source) !== representationKey(producer.source.representation) ||
        representationKey(node.target) !== representationKey(storedValue.representation) ||
        !recipeHasNormalResult(node, input.conversions.nodeById) ||
        !recipePreservesNativePayload(node, input.conversions.nodeById) ||
        !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
      )
        break
      storedValue = producer.source
    }
    const storage = held?.storage.storage ?? storedValue.representation
    const fits =
      held?.storage.writers.map(({ writer, source }) => ({
        writer: writer.mutation.operation.id,
        source,
        node: input.conversions.nodeFor(source, storage)
      })) ?? []
    const storageNode = input.conversions.nodeFor(storedValue.representation, storage)
    if (
      ![storageNode, ...fits.map(({ node }) => node)].every(
        (node) =>
          recipeHasNormalResult(node, input.conversions.nodeById) &&
          recipePreservesNativePayload(node, input.conversions.nodeById) &&
          recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
      )
    )
      continue
    // A constructor's non-configurable prototype is installed by its own
    // authority; this entry cannot pretend a computed key is an ordinary expando.
    if (actual.receiver.representation.kind === 'function-and-constructor') {
      const key = definitions.get(actual.key.value)
      if (key?.kind !== 'constant' || key.literal !== 'string' || key.text === 'prototype') continue
    }
    const dynamicObservation = ownTable ? true : owners.dynamicObservationAt(operation, semantic, actual.receiver, actual.key)
    const payload = dynamicObservation === false ? null : input.conversions.nodeFor(storage, dynamic)
    // The native owner protocol seals the inherited chain and every current
    // own writer as data. No accessor can request the logical receiver here;
    // an own-table write may meet any own accessor the target already holds.
    const receiver = ownTable ? input.conversions.nodeFor(actual.receiver.representation, dynamic) : null
    if (
      ![payload, receiver].every((node) => node === null || recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById))
    )
      continue
    receipts.set(operation, {
      writer: semantic.id,
      receiver: actual.receiver,
      key: actual.key,
      value: actual.value,
      storedValue,
      storage,
      storageConversion: storageNode.id,
      storageFits: fits.map(({ writer, source, node }) => ({ writer, source, conversion: node.id })),
      prototypeProtocol,
      materialization: payload?.id ?? null,
      receiverMaterialization: receiver?.id ?? null
    })
  }
  return receipts
}

export const nativeCallableDataWriteMatches = (
  expected: NativeCallableDataWrite | undefined,
  actual: NativeCallableDataWrite | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  expected.writer === actual.writer &&
  expected.prototypeProtocol === actual.prototypeProtocol &&
  expected.definition === actual.definition &&
  expected.materialization === actual.materialization &&
  expected.receiverMaterialization === actual.receiverMaterialization &&
  expected.storageConversion === actual.storageConversion &&
  representationKey(expected.storage) === representationKey(actual.storage) &&
  expected.storageFits.length === actual.storageFits.length &&
  expected.storageFits.every((fit, ordinal) => {
    const other = actual.storageFits[ordinal]!
    return (
      fit.writer === other.writer &&
      fit.conversion === other.conversion &&
      representationKey(fit.source) === representationKey(other.source)
    )
  }) &&
  [expected.receiver, expected.key, expected.value, expected.storedValue].every((operand, ordinal) => {
    const stated = [actual.receiver, actual.key, actual.value, actual.storedValue][ordinal]!
    return operand.value === stated.value && representationKey(operand.representation) === representationKey(stated.representation)
  })
