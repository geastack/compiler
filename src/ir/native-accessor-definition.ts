import type { ConversionNodeId } from '../conversion/algebra.js'
import { transfersNativeStorage } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import type { FunctionId, IrValueId, PhysicalBodyId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { abiOfCallee, type CalleeRenderingInput } from '../projection/callee.js'
import { abiKey, passingOf, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { callableOriginsOf } from '../semantics/callable-origins.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import { nativeObjectDataSlotSchemasOf } from '../semantics/native-object-data-slots.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import {
  allOperationsOf,
  type CallOperation,
  type IrBody,
  type IrNonTerminatorOperation,
  type IrOperand,
  type IrOperation
} from './model.js'
import { resultOfIrOperation, operandsOfIrOperation } from './queries.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { descriptorOwnProtocolMatches } from './descriptor-own-protocol.js'

/** A descriptor half retains an actual source Function and separately names
 * its future zero/one-argument accessor call frame.
 * @semanticCategory generic-primitive
 */
export interface NativeAccessorHalfRecipe {
  readonly half: 'get' | 'set'
  readonly value: IrValueId
  readonly source: Representation
  readonly callable: FunctionId
  readonly call: Representation
  readonly conversion: ConversionNodeId
  readonly read: Representation | null
  readonly write: Representation | null
  /** The dynamic [[Get]]/[[Set]] frame of an accessor installed through a
   * dynamic receiver: boxes a typed getter result, or checks a dynamic
   * argument into the setter's typed parameter. `null` when the frame is
   * the native one already (a dynamic carrier) or no dynamic access exists. */
  readonly observe: ConversionNodeId | null
}

/** Exact literal storage and Function provenance, independently replayed
 * before installation or any future accessor invocation.
 * @semanticCategory generic-primitive
 */
export interface NativeAccessorDefinitionRecipe {
  readonly receiver: IrValueId
  readonly descriptor: IrValueId
  readonly key: IrValueId
  readonly keyText: string
  readonly halves: readonly NativeAccessorHalfRecipe[]
}

/** A reflected half is an adapted view of the original Function. The exact
 * installed definition and current native owner, rather than an ambient
 * PropertyDescriptor signature, authenticate this view.
 * @semanticCategory generic-primitive
 */
export interface NativeAccessorObservationRecipe {
  readonly definition: SemanticResultId
  readonly receiver: IrValueId
  readonly key: IrValueId
  readonly keyText: string
  readonly halves: readonly {
    readonly half: 'get' | 'set'
    readonly callable: FunctionId
    readonly source: Representation
    readonly target: Representation
    readonly conversion: ConversionNodeId
  }[]
}

/** An unchanged reflected descriptor copies its native halves and flags.
 * Its public callable views never become the new stored accessor payloads.
 * @semanticCategory generic-primitive
 */
export interface NativeAccessorReinstallationRecipe {
  readonly receiver: IrValueId
  readonly key: IrValueId
  readonly descriptor: IrValueId
  readonly observation: IrValueId
  readonly definition: SemanticResultId
  readonly snapshotReceiver: IrOperand
  readonly snapshotKey: IrOperand
}

export interface NativeAccessorDefinitionInput {
  readonly graph: SemanticGraph
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly conversions: ConversionCensus
  readonly calleeRendering: CalleeRenderingInput | undefined
}

/** The body frame supplies its actual read/write carrier. The installation
 * neither binds this nor converts a native result to the ambient any result.
 */
export const nativeAccessorHalfOf = (
  half: 'get' | 'set',
  value: IrOperand,
  callable: FunctionId,
  input: Pick<NativeAccessorDefinitionInput, 'abis' | 'conversions'>,
  dynamicReceiver = false
): NativeAccessorHalfRecipe | null => {
  const source = abiOfCallee(value.representation)
  const physical = input.abis.get(callable)
  if (source === null || physical === undefined || abiKey(source) !== abiKey(physical)) return null
  let write: Representation | null = null
  if (half === 'set' && source.parameters.length > 0) {
    const first = source.parameters[0]!.value
    if (source.restFrom === 0) {
      if (first.kind !== 'array-object') return null
      write = first.element
    } else write = first
  }
  const read: Representation | null = half === 'get' ? (source.result.kind === 'void' ? { kind: 'undefined' } : source.result) : null
  const call: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters:
        half === 'get' || write === null
          ? []
          : [{ value: write, ownership: 'ownership' in write ? write.ownership : 'owned', passing: passingOf(write) }],
      restFrom: null,
      result: half === 'get' ? source.result : { kind: 'void' }
    }
  }
  const node = input.conversions.nativeMethodFor(value.representation, call) ?? input.conversions.nodeFor(value.representation, call)
  if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return null
  // Only an object a dynamic carrier holds can meet a dynamic [[Get]] or
  // [[Set]] of this key, and only a typed half needs a frame for one.
  let observe: ConversionNodeId | null = null
  const typed = half === 'get' ? read : write
  if (dynamicReceiver && typed !== null && typed.kind !== 'dynamic') {
    const frame = half === 'get' ? input.conversions.nodeFor(typed, dynamicCarrier) : input.conversions.nodeFor(dynamicCarrier, typed)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(frame, input.conversions.nodeById)) return null
    observe = frame.id
  }
  return { half, value: value.value, source: value.representation, callable, call, conversion: node.id, read, write, observe }
}

const dynamicCarrier: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

/** Whether a dynamic [[Get]]/[[Set]] can run this half: its own frame is
 * already dynamic, or the definition published the boxing/checking frame. */
const halfHasDynamicFrame = (half: NativeAccessorHalfRecipe): boolean => {
  const typed = half.half === 'get' ? half.read : half.write
  return half.observe !== null || typed === null || typed.kind === 'dynamic'
}

/** This first definition slice uses the literal's complete final-IR writer
 * list. Descriptor aliases and opaque consumers require their own sealed
 * source route; they cannot borrow the literal's initial get/set signatures.
 */
export const nativeAccessorDefinitionOf = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  input: NativeAccessorDefinitionInput,
  definitionOf: (value: IrValueId) => IrOperation | null
): NativeAccessorDefinitionRecipe | null => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.intrinsicMutation !== 'object-define-property' ||
    operation.argumentsAreSpread ||
    operation.arguments.length !== 3 ||
    !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 2, definitionOf)
  )
    return null
  const [receiver, key, descriptor] = operation.arguments
  if (!receiver || !key || !descriptor) return null
  // A shared descriptor literal may be carried by reference; its canonical
  // layout states the same own fields as an inline record carrier.
  const descriptorLayout =
    descriptor.representation.kind === 'record'
      ? descriptor.representation
      : descriptor.representation.kind === 'native-record-ref' && descriptor.representation.native === null
        ? (input.calleeRendering?.deriver.layoutOf(descriptor.representation.shapeId as StructuralTypeId) ?? null)
        : null
  if (descriptorLayout?.kind !== 'record' || descriptorLayout.accessors.length > 0) return null
  // A host object (an intrinsic prototype such as `Object.prototype`) has no
  // native own-property table to install the halves into, and an accessor
  // there changes every inheriting object's Set/Get; it is not this receipt.
  if (receiver.representation.kind === 'native-handle') return null
  const descriptorSource = operandOf(semantic, 'argument', 2)
  const semanticKey = operandOf(semantic, 'argument', 1)
  const keySource = definitionOf(key.value)
  if (
    descriptorSource?.source.kind !== 'result' ||
    keySource?.kind !== 'constant' ||
    keySource.literal !== 'string' ||
    semanticKey?.source.kind !== 'constant' ||
    semanticKey.source.literal !== 'string' ||
    semanticKey.source.text !== keySource.text
  )
    return null
  const fields = descriptorLayout.fields
  if (
    !fields.some((field) => field.key === 'get' || field.key === 'set') ||
    fields.some(
      (field) =>
        !field.required ||
        (!['get', 'set'].includes(field.key) &&
          (!['enumerable', 'configurable'].includes(field.key) || field.value.kind !== 'scalar' || field.value.domain !== 'boolean'))
    )
  )
    return null
  const positions = new Map<IrOperation, { readonly block: object; readonly ordinal: number }>()
  const operations: IrOperation[] = []
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const [ordinal, current] of allOperationsOf(block).entries()) {
        positions.set(current, { block, ordinal })
        operations.push(current)
      }
  const at = positions.get(operation)
  if (!at) return null
  const sourceSlots = nativeObjectDataSlotSchemasOf(input.graph)
  const allocation = sourceSlots.origins.get(descriptorSource.source.result)
  if (!allocation || allocation.family !== 'allocation' || allocation.allocated !== 'object-literal') return null
  // The literal's final result is a store's receiver result, while sibling
  // initializers may still cite the original allocation. Follow the result
  // to that allocation, then authenticate its complete initializer inventory.
  const aliases = new Set<IrValueId>()
  const stores: Extract<IrOperation, { kind: 'define-own-property' }>[] = []
  let value = descriptor.value
  let literal: Extract<IrOperation, { kind: 'allocate-record' }> | null = null
  let next = at.ordinal
  while (!aliases.has(value)) {
    aliases.add(value)
    const producer = definitionOf(value)
    const position = producer === null ? undefined : positions.get(producer)
    const semanticProducer = producer === null ? null : semanticOf(input.graph, producer)
    const result = producer === null ? null : resultOfIrOperation(producer)
    if (
      !producer ||
      !position ||
      !result ||
      result.id !== value ||
      producer.lineage === null ||
      sourceSlots.origins.get(producer.lineage) !== allocation ||
      position.block !== at.block ||
      position.ordinal >= next
    )
      return null
    next = position.ordinal
    if (producer.kind === 'allocate-record') {
      if (semanticProducer !== allocation || resultOf(allocation, 'value')?.id !== producer.lineage) return null
      literal = producer
      break
    }
    if (
      producer.kind !== 'define-own-property' ||
      semanticProducer?.family !== 'property' ||
      semanticProducer.internalMethod !== 'define-own-property' ||
      resultOf(semanticProducer, 'value')?.id !== producer.lineage
    )
      return null
    const semanticReceiver = operandOf(semanticProducer, 'receiver')
    const actualReceiver = definitionOf(producer.receiver.value)
    const semanticKey = operandOf(semanticProducer, 'key')
    const actualKey = definitionOf(producer.key.value)
    if (
      semanticReceiver?.source.kind !== 'result' ||
      actualReceiver?.lineage !== semanticReceiver.source.result ||
      resultOfIrOperation(actualReceiver)?.id !== producer.receiver.value ||
      semanticKey?.source.kind !== 'constant' ||
      semanticKey.source.literal !== 'string' ||
      actualKey?.kind !== 'constant' ||
      actualKey.literal !== 'string' ||
      actualKey.text !== semanticKey.source.text ||
      !producer.attributes.writable ||
      !producer.attributes.enumerable ||
      !producer.attributes.configurable
    )
      return null
    stores.unshift(producer)
    value = producer.receiver.value
  }
  if (literal === null) return null
  const schemas = sourceSlots.schemas.get(allocation.id)
  const allocated = positions.get(literal)!
  for (const current of operations) {
    if (current.kind !== 'define-own-property' || current.lineage === null || sourceSlots.origins.get(current.lineage) !== allocation)
      continue
    const position = positions.get(current)
    const source = semanticOf(input.graph, current)
    const receiver = source?.family === 'property' ? operandOf(source, 'receiver') : undefined
    const key = source?.family === 'property' ? operandOf(source, 'key') : undefined
    const written = source?.family === 'property' ? operandOf(source, 'value') : undefined
    const actualReceiver = definitionOf(current.receiver.value)
    const actualKey = definitionOf(current.key.value)
    const actualValue = definitionOf(current.value.value)
    const valueMatches =
      written?.source.kind === 'constant'
        ? actualValue?.kind === 'constant' && actualValue.literal === written.source.literal && actualValue.text === written.source.text
        : written?.source.kind === 'result' && actualValue?.lineage === written.source.result
    const writer = actualKey?.kind === 'constant' ? schemas?.get(actualKey.text)?.writers : undefined
    if (
      !position ||
      position.block !== at.block ||
      position.ordinal <= allocated.ordinal ||
      position.ordinal >= at.ordinal ||
      source?.family !== 'property' ||
      source.internalMethod !== 'define-own-property' ||
      resultOf(source, 'value')?.id !== current.lineage ||
      receiver?.source.kind !== 'result' ||
      actualReceiver?.lineage !== receiver.source.result ||
      resultOfIrOperation(actualReceiver)?.id !== current.receiver.value ||
      key?.source.kind !== 'constant' ||
      key.source.literal !== 'string' ||
      actualKey?.kind !== 'constant' ||
      actualKey.literal !== 'string' ||
      actualKey.text !== key.source.text ||
      actualValue === null ||
      resultOfIrOperation(actualValue)?.id !== current.value.value ||
      !valueMatches ||
      writer?.length !== 1 ||
      writer[0]?.mutation.operation !== source ||
      !current.attributes.writable ||
      !current.attributes.enumerable ||
      !current.attributes.configurable
    )
      return null
    aliases.add(current.receiver.value)
    if (current.result !== null) aliases.add(current.result.id)
    if (!stores.includes(current)) stores.push(current)
  }
  stores.sort((first, second) => positions.get(first)!.ordinal - positions.get(second)!.ordinal)
  const initial = new Map(literal.fields.map((field) => [field.key, field.value]))
  if (initial.size !== literal.fields.length) return null
  for (const store of stores) {
    const storedKey = definitionOf(store.key.value)
    if (storedKey?.kind !== 'constant' || initial.has(storedKey.text)) return null
    initial.set(storedKey.text, store.value)
  }
  for (const current of operations) {
    const uses = operandsOfIrOperation(current).filter((operand) => aliases.has(operand.value))
    if (uses.length === 0) continue
    if (current === operation) continue
    if (current.kind !== 'define-own-property' || !stores.includes(current) || uses.some((operand) => operand !== current.receiver))
      return null
  }
  if (initial.size !== fields.length || fields.some((field) => !initial.has(field.key))) return null
  if (!descriptorOwnProtocolMatches(operation, semantic, input.graph, definitionOf, [...initial.keys()])) return null
  const origins = callableOriginsOf(input.graph)
  const halves: NativeAccessorHalfRecipe[] = []
  for (const field of fields.filter((field) => field.key === 'get' || field.key === 'set')) {
    const held = initial.get(field.key)!
    if (representationKey(field.value) !== representationKey(held.representation)) return null
    const schema = schemas?.get(field.key)
    const writer = schema?.writers.length === 1 ? schema.writers[0] : undefined
    const source = writer?.value
    const producer = definitionOf(held.value)
    const result = producer === null ? null : resultOfIrOperation(producer)
    if (
      !schema ||
      schema.blockers.length !== 0 ||
      !source ||
      source.result === null ||
      source.callable === null ||
      !producer ||
      !result ||
      result.id !== held.value ||
      producer.lineage !== source.result.id ||
      origins.get(producer.lineage) !== source.callable
    )
      return null
    const half = nativeAccessorHalfOf(field.key as 'get' | 'set', held, source.callable, input, receiver.representation.kind === 'dynamic')
    if (half === null) return null
    halves.push(half)
  }
  return { receiver: receiver.value, descriptor: descriptor.value, key: key.value, keyText: keySource.text, halves }
}

export const nativeAccessorDefinitionMatches = (
  expected: NativeAccessorDefinitionRecipe | null,
  actual: NativeAccessorDefinitionRecipe
): boolean =>
  expected !== null &&
  expected.receiver === actual.receiver &&
  expected.descriptor === actual.descriptor &&
  expected.key === actual.key &&
  expected.keyText === actual.keyText &&
  expected.halves.length === actual.halves.length &&
  expected.halves.every((half, ordinal) => {
    const other = actual.halves[ordinal]!
    return (
      half.half === other.half &&
      half.value === other.value &&
      half.callable === other.callable &&
      half.conversion === other.conversion &&
      half.observe === other.observe &&
      representationKey(half.source) === representationKey(other.source) &&
      representationKey(half.call) === representationKey(other.call) &&
      (half.read === null ? other.read === null : other.read !== null && representationKey(half.read) === representationKey(other.read)) &&
      (half.write === null
        ? other.write === null
        : other.write !== null && representationKey(half.write) === representationKey(other.write))
    )
  })

const semanticOf = (graph: SemanticGraph, operation: IrOperation): SemanticOperation | null => {
  if (operation.lineage === null) return null
  const id = graph.results.get(operation.lineage)
  return id === undefined ? null : (graph.operations.get(id) ?? null)
}

const descriptorIntrinsicReadOf = (
  operation: CallOperation,
  semantic: Extract<SemanticOperation, { family: 'invocation' }>,
  graph: SemanticGraph,
  definitionOf: (value: IrValueId) => IrOperation | null,
  member: 'defineProperty' | 'getOwnPropertyDescriptor'
): IrOperation | null => {
  const callee = definitionOf(operation.callee.value)
  const semanticCallee = operandOf(semantic, 'callee')
  if (
    callee?.kind !== 'get' ||
    callee.result.id !== operation.callee.value ||
    semanticCallee?.source.kind !== 'result' ||
    callee.lineage !== semanticCallee.source.result
  )
    return null
  const source = semanticOf(graph, callee)
  if (source?.family !== 'property' || source.internalMethod !== 'get') return null
  const key = operandOf(source, 'key')
  const actualKey = definitionOf(callee.key.value)
  const receiver = operandOf(source, 'receiver')
  const actualReceiver = definitionOf(callee.receiver.value)
  const sourceReceiver = actualReceiver === null ? null : semanticOf(graph, actualReceiver)
  return key?.source.kind === 'constant' &&
    key.source.literal === 'string' &&
    key.source.text === member &&
    actualKey?.kind === 'constant' &&
    actualKey.literal === 'string' &&
    actualKey.text === member &&
    actualKey.result.id === callee.key.value &&
    receiver?.source.kind === 'result' &&
    actualReceiver?.kind === 'binding-read' &&
    actualReceiver.result.id === callee.receiver.value &&
    actualReceiver.lineage === receiver.source.result &&
    sourceReceiver?.family === 'binding' &&
    sourceReceiver.action === 'read' &&
    sourceReceiver.declaration === actualReceiver.declaration
    ? callee
    : null
}

/** A known installed native half cannot silently become an absent getter or
 * a freshly allocated ambient wrapper when its reflection proof is missing.
 */
export const nativeAccessorObservationNeedsReceipt = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  input: NativeAccessorDefinitionInput,
  definitionOf: (value: IrValueId) => IrOperation | null
): boolean => {
  if (semantic?.family !== 'invocation' || semantic.intrinsicReflection !== 'getOwnPropertyDescriptor') return false
  const receiver = operation.arguments[0]
  const sourceReceiver = operandOf(semantic, 'argument', 0)
  if (!receiver || sourceReceiver?.source.kind !== 'result' || !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf))
    return false
  const census = nativeObjectDataSlotSchemasOf(input.graph)
  const owner = census.origins.get(sourceReceiver.source.result)
  // A constant observed key can only reflect an installation of that key;
  // an unknown key may observe any installed half.
  const key = operation.arguments[1]
  const keySource = key === undefined ? null : definitionOf(key.value)
  const observedKey =
    keySource?.kind === 'constant' && (keySource.literal === 'string' || keySource.literal === 'number') ? keySource.text : null
  const genericHalves = observesThroughDynamicFrames(operation, input)
  return [...input.bodies.values()]
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .some((candidate) => {
      if (candidate.kind !== 'call' || !candidate.nativeAccessorDefinition) return false
      if (observedKey !== null && candidate.nativeAccessorDefinition.keyText !== observedKey) return false
      // The ambient descriptor's own `get(): any` / `set(v: any)` halves call
      // the installed Function through its dynamic frame with an undefined
      // receiver (`gea::descriptorGetCallable`), which is exactly a detached
      // `desc.get()`. Such an installation needs no static view receipt.
      if (genericHalves && candidate.nativeAccessorDefinition.halves.every(halfHasDynamicFrame)) return false
      if (candidate.nativeAccessorDefinition.receiver === receiver.value) return true
      const source = semanticOf(input.graph, candidate)
      const installedReceiver = source?.family === 'invocation' ? operandOf(source, 'argument', 0) : undefined
      return (
        owner !== undefined && installedReceiver?.source.kind === 'result' && census.origins.get(installedReceiver.source.result) === owner
      )
    })
}

/** The observation's record states each accessor half as the ambient
 * descriptor's dynamic Function frame (`get(): any`, `set(v: any): void`). */
const observesThroughDynamicFrames = (operation: CallOperation, input: NativeAccessorDefinitionInput): boolean => {
  if (operation.result === null) return false
  const result =
    operation.result.representation.kind === 'optional' ? operation.result.representation.payload : operation.result.representation
  const fields =
    result.kind === 'record'
      ? result.fields
      : result.kind === 'native-record-ref' && result.native === null && input.calleeRendering
        ? recordFieldsOfShape(input.calleeRendering.deriver, result.shapeId)
        : null
  if (fields === null) return false
  return (['get', 'set'] as const).every((half) => {
    const field = fields.find((candidate) => candidate.key === half)
    if (field === undefined) return true
    const abi = abiOfCallee(field.value.kind === 'optional' ? field.value.payload : field.value)
    if (abi === null || abi.receiver !== null || abi.restFrom !== null) return false
    return half === 'get'
      ? abi.parameters.length === 0 && abi.result.kind === 'dynamic'
      : abi.parameters.length === 1 && abi.parameters[0]!.value.kind === 'dynamic' && abi.result.kind === 'void'
  })
}

/** The first reflection slice proves one same-block installation and a
 * complete effect-free interval to observation. Unknown calls, mutation,
 * owner escapes, and descriptor replacement cannot borrow that installation.
 */
export const nativeAccessorObservationOf = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  input: NativeAccessorDefinitionInput,
  definitionOf: (value: IrValueId) => IrOperation | null
): NativeAccessorObservationRecipe | null => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.intrinsicReflection !== 'getOwnPropertyDescriptor' ||
    operation.argumentsAreSpread ||
    operation.arguments.length !== 2 ||
    operation.result === null ||
    !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf)
  )
    return null
  const [receiver, key] = operation.arguments
  const keySource = key === undefined ? null : definitionOf(key.value)
  const semanticKey = operandOf(semantic, 'argument', 1)
  const semanticReceiver = operandOf(semantic, 'argument', 0)
  if (
    !receiver ||
    !key ||
    keySource?.kind !== 'constant' ||
    keySource.literal !== 'string' ||
    semanticKey?.source.kind !== 'constant' ||
    semanticKey.source.literal !== 'string' ||
    semanticKey.source.text !== keySource.text ||
    semanticReceiver?.source.kind !== 'result'
  )
    return null
  const census = nativeObjectDataSlotSchemasOf(input.graph)
  const owner = census.origins.get(semanticReceiver.source.result)
  const actualOwner = definitionOf(receiver.value)
  if (owner === undefined || actualOwner === null || actualOwner.lineage === null || census.origins.get(actualOwner.lineage) !== owner)
    return null
  const body = [...input.bodies.values()].find((body) => [...body.blocks.values()].some((block) => block.operations.includes(operation)))
  const block = body && [...body.blocks.values()].find((block) => block.operations.includes(operation))
  if (!block) return null
  const index = block.operations.indexOf(operation)
  const candidates = block.operations.slice(0, index).filter((candidate): candidate is CallOperation => {
    if (candidate.kind !== 'call' || !candidate.nativeAccessorDefinition) return false
    const source = semanticOf(input.graph, candidate)
    const held = source?.family === 'invocation' ? operandOf(source, 'argument', 0) : undefined
    return (
      candidate.nativeAccessorDefinition.keyText === keySource.text &&
      held?.source.kind === 'result' &&
      census.origins.get(held.source.result) === owner
    )
  })
  if (candidates.length !== 1) return null
  const installed = candidates[0]!
  const definition = nativeAccessorDefinitionOf(installed, semanticOf(input.graph, installed), input, definitionOf)
  if (!definition || !nativeAccessorDefinitionMatches(definition, installed.nativeAccessorDefinition!)) return null
  const installedSemantic = semanticOf(input.graph, installed)
  if (
    [...(census.schemas.get(owner.id)?.values() ?? [])].some((schema) =>
      schema.blockers.some((blocker) => blocker.operation.id !== semantic.id && blocker.operation.id !== installedSemantic?.id)
    )
  )
    return null
  const installedIndex = block.operations.indexOf(installed)
  const intactCalleeRead = descriptorIntrinsicReadOf(operation, semantic, input.graph, definitionOf, 'getOwnPropertyDescriptor')
  // The Function's invocation is effectful even when its nominal result is
  // ignored. Only actual primitive operations and local identity transport
  // may lie between descriptor installation and reflection, besides the
  // exact intact intrinsic member read authenticated for this query.
  if (
    block.operations
      .slice(installedIndex + 1, index)
      .some(
        (one) =>
          one !== intactCalleeRead &&
          !['constant', 'binding-read', 'binding-write'].includes(one.kind) &&
          !(one.kind === 'convert' && representationKey(one.source.representation) === representationKey(one.result.representation))
      )
  )
    return null
  for (const operation of input.graph.operations.values())
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result' || census.origins.get(operand.source.result) !== owner) continue
      if (operation.family === 'binding' && operation.external === undefined) continue
      if (operation.family === 'reference' && (operation.form === 'identifier' || operation.form === 'property')) continue
      if (operation.id === semantic.id || operation.id === semanticOf(input.graph, installed)?.id) continue
      // Any other property operation/call can replace the descriptor or
      // publish the receiver. A source-key spelling is not isolation proof.
      return null
    }
  const result =
    operation.result.representation.kind === 'optional' ? operation.result.representation.payload : operation.result.representation
  const fields =
    result.kind === 'record'
      ? result.fields
      : result.kind === 'native-record-ref' && result.native === null && input.calleeRendering
        ? recordFieldsOfShape(input.calleeRendering.deriver, result.shapeId)
        : null
  if (fields === null) return null
  const halves: NativeAccessorObservationRecipe['halves'][number][] = []
  for (const half of definition.halves) {
    const field = fields.find((field) => field.key === half.half)
    if (!field) return null
    const target = field.value.kind === 'optional' ? field.value.payload : field.value
    const observedAbi = abiOfCallee(target)
    const sourceAbi = abiOfCallee(half.source)
    if (observedAbi === null || sourceAbi === null) return null
    // An ambient PropertyDescriptor return of any is not evidence that the
    // program's actual getter returns any. A typed result must keep its own
    // carrier in the source descriptor result publication.
    if (half.half === 'get' && observedAbi.result.kind === 'dynamic' && sourceAbi.result.kind !== 'dynamic') return null
    const node = input.conversions.nativeMethodFor(half.source, target) ?? input.conversions.nodeFor(half.source, target)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return null
    halves.push({ half: half.half, callable: half.callable, source: half.source, target, conversion: node.id })
  }
  return { definition: installed.lineage, receiver: receiver.value, key: key.value, keyText: keySource.text, halves }
}

export const nativeAccessorObservationMatches = (
  expected: NativeAccessorObservationRecipe | null,
  actual: NativeAccessorObservationRecipe
): boolean =>
  expected !== null &&
  expected.definition === actual.definition &&
  expected.receiver === actual.receiver &&
  expected.key === actual.key &&
  expected.keyText === actual.keyText &&
  expected.halves.length === actual.halves.length &&
  expected.halves.every((half, index) => {
    const other = actual.halves[index]!
    return (
      half.half === other.half &&
      half.callable === other.callable &&
      half.conversion === other.conversion &&
      representationKey(half.source) === representationKey(other.source) &&
      representationKey(half.target) === representationKey(other.target)
    )
  })

/** The snapshot route is bounded to an exact native observation, immutable
 * local aliases, and no effects or descriptor writes before reinstallation.
 * Re-reading its original native descriptor is therefore observationally the
 * same snapshot, including source Function identity and invocation carriers.
 */
export const nativeAccessorReinstallationOf = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  input: NativeAccessorDefinitionInput,
  definitionOf: (value: IrValueId) => IrOperation | null
): NativeAccessorReinstallationRecipe | null => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.intrinsicMutation !== 'object-define-property' ||
    operation.argumentsAreSpread ||
    operation.arguments.length !== 3 ||
    !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf) ||
    !intrinsicCallArgumentMatches(operation, semantic, 2, definitionOf)
  )
    return null
  const [receiver, key, descriptor] = operation.arguments
  if (!receiver || !key || !descriptor) return null
  const keySource = definitionOf(key.value)
  const semanticKey = operandOf(semantic, 'argument', 1)
  if (
    keySource?.kind !== 'constant' ||
    keySource.literal !== 'string' ||
    semanticKey?.source.kind !== 'constant' ||
    semanticKey.source.literal !== 'string' ||
    semanticKey.source.text !== keySource.text
  )
    return null
  const block = [...input.bodies.values()]
    .flatMap((body) => [...body.blocks.values()])
    .find((block) => block.operations.includes(operation))
  if (!block) return null
  const seen = new Set<IrValueId>()
  const sourceOf = (value: IrValueId): CallOperation | null => {
    if (seen.has(value)) return null
    seen.add(value)
    const source = definitionOf(value)
    if (!source || !block.operations.includes(source as IrNonTerminatorOperation)) return null
    if (source.kind === 'call') return source.nativeAccessorObservation && source.result?.id === value ? source : null
    if (source.kind === 'convert') {
      if (source.rebuild !== undefined) return null
      const node = input.conversions.nodeFor(source.source.representation, source.result.representation)
      if (!transfersNativeStorage(node.capability)) return null
      return sourceOf(source.source.value)
    }
    if (source.kind !== 'binding-read') return null
    const writes = [...input.bodies.values()]
      .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
      .filter((one) => one.kind === 'binding-write' && one.declaration === source.declaration)
    if (writes.length !== 1 || writes[0]?.kind !== 'binding-write') return null
    const write = writes[0]
    if (!block.operations.includes(write) || block.operations.indexOf(write) >= block.operations.indexOf(source)) return null
    const semanticSource = semanticOf(input.graph, source)
    if (
      !semanticSource ||
      semanticSource.family !== 'binding' ||
      semanticSource.action !== 'read' ||
      semanticSource.declaration !== source.declaration ||
      semanticSource.external !== undefined
    )
      return null
    const observation = sourceOf(write.value.value)
    return observation && nativeCallableSourceAliasesOf(input.graph, source.lineage).has(observation.lineage) ? observation : null
  }
  const observation = sourceOf(descriptor.value)
  if (!observation || !observation.nativeAccessorObservation || !observation.result) return null
  const reflected = nativeAccessorObservationOf(observation, semanticOf(input.graph, observation), input, definitionOf)
  if (!reflected || !nativeAccessorObservationMatches(reflected, observation.nativeAccessorObservation)) return null
  if (!descriptorOwnProtocolMatches(operation, semantic, input.graph, definitionOf, ['get', 'set', 'enumerable', 'configurable']))
    return null
  const start = block.operations.indexOf(observation)
  const end = block.operations.indexOf(operation)
  const intactCalleeRead = descriptorIntrinsicReadOf(operation, semantic, input.graph, definitionOf, 'defineProperty')
  if (
    start >= end ||
    block.operations
      .slice(start + 1, end)
      .some(
        (one) =>
          one !== intactCalleeRead &&
          !['constant', 'binding-read', 'binding-write'].includes(one.kind) &&
          !(
            one.kind === 'convert' &&
            one.rebuild === undefined &&
            transfersNativeStorage(input.conversions.nodeFor(one.source.representation, one.result.representation).capability)
          )
      )
  )
    return null
  const snapshotReceiver = observation.arguments[0]
  const snapshotKey = observation.arguments[1]
  if (!snapshotReceiver || !snapshotKey) return null
  return {
    receiver: receiver.value,
    key: key.value,
    descriptor: descriptor.value,
    observation: observation.result.id,
    definition: reflected.definition,
    snapshotReceiver,
    snapshotKey
  }
}

export const nativeAccessorReinstallationMatches = (
  expected: NativeAccessorReinstallationRecipe | null,
  actual: NativeAccessorReinstallationRecipe
): boolean =>
  expected !== null &&
  expected.receiver === actual.receiver &&
  expected.key === actual.key &&
  expected.descriptor === actual.descriptor &&
  expected.observation === actual.observation &&
  expected.definition === actual.definition &&
  expected.snapshotReceiver.value === actual.snapshotReceiver.value &&
  expected.snapshotKey.value === actual.snapshotKey.value &&
  representationKey(expected.snapshotReceiver.representation) === representationKey(actual.snapshotReceiver.representation) &&
  representationKey(expected.snapshotKey.representation) === representationKey(actual.snapshotKey.representation)

export const publishNativeAccessorDefinitions = (input: NativeAccessorDefinitionInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const definitions = new Map<IrValueId, IrOperation>()
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
      }
  const definitionsPublished = new Map<PhysicalBodyId, IrBody>(
    [...input.bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation): IrNonTerminatorOperation => {
                if (operation.kind !== 'call') return operation
                const semantic = semanticOf(input.graph, operation)
                const recipe = nativeAccessorDefinitionOf(operation, semantic, input, (value) => definitions.get(value) ?? null)
                const { nativeAccessorDefinition: _previous, ...ordinary } = operation
                return recipe === null
                  ? ordinary
                  : {
                      ...ordinary,
                      nativeAccessorDefinition: recipe,
                      objectValueConversions: (operation.objectValueConversions ?? []).filter(
                        (value) =>
                          value.role !== 'descriptor-value' ||
                          value.argument !== 2 ||
                          !recipe.halves.some((half) => half.half === value.field)
                      )
                    }
              })
            }
          ])
        )
      }
    ])
  )
  const observationInput = { ...input, bodies: definitionsPublished }
  const publishedDefinitions = new Map<IrValueId, IrOperation>()
  for (const body of definitionsPublished.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result) publishedDefinitions.set(result.id, operation)
      }
  const observationsPublished = new Map<PhysicalBodyId, IrBody>(
    [...definitionsPublished].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation): IrNonTerminatorOperation => {
                if (operation.kind !== 'call') return operation
                const recipe = nativeAccessorObservationOf(
                  operation,
                  semanticOf(input.graph, operation),
                  observationInput,
                  (value) => publishedDefinitions.get(value) ?? null
                )
                const { nativeAccessorObservation: _previous, ...ordinary } = operation
                return recipe === null ? ordinary : { ...ordinary, nativeAccessorObservation: recipe }
              })
            }
          ])
        )
      }
    ])
  )
  const reinstallationInput = { ...input, bodies: observationsPublished }
  const observationDefinitions = new Map<IrValueId, IrOperation>()
  for (const body of observationsPublished.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result) observationDefinitions.set(result.id, operation)
      }
  return new Map(
    [...observationsPublished].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation): IrNonTerminatorOperation => {
                if (operation.kind !== 'call') return operation
                const recipe = nativeAccessorReinstallationOf(
                  operation,
                  semanticOf(input.graph, operation),
                  reinstallationInput,
                  (value) => observationDefinitions.get(value) ?? null
                )
                const { nativeAccessorReinstallation: _previous, ...ordinary } = operation
                return recipe === null ? ordinary : { ...ordinary, nativeAccessorReinstallation: recipe }
              })
            }
          ])
        )
      }
    ])
  )
}
