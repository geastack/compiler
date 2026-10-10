import type { DeclarationId, FunctionId, IrValueId, SemanticResultId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import { recordAccessorsOfShape, recordFieldsOfShape, recordIndexesOfShape, declaredRecordFieldOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeCallableIdentityTransportMatches } from '../conversion/native-callable-adapter.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operationOfResult } from '../identity/ids.js'
import { allOperationsOf, type GetOperation, type IrBody, type IrOperation, type SetOperation, type IrOperand } from './model.js'
import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/** A source prototype fact cannot be transplanted to another key or operation. */
export const ordinaryFunctionDataWriteMatches = (
  operation: SetOperation,
  semantic: SemanticOperation | null,
  key: IrOperation | null
): boolean => {
  const sourceKey = semantic === null ? undefined : operandOf(semantic, 'key')
  return (
    operation.ordinaryFunctionDataWrite === true &&
    semantic?.family === 'property' &&
    semantic.internalMethod === 'set' &&
    semantic.ordinaryFunctionDataWrite === true &&
    resultOf(semantic, 'value')?.id === operation.lineage &&
    sourceKey?.source.kind === 'constant' &&
    sourceKey.source.literal === 'string' &&
    key?.kind === 'constant' &&
    key.literal === 'string' &&
    key.text === sourceKey.source.text
  )
}

/**
 * One confined ordinary data slot whose native source is read without a dynamic table.
 * @semanticCategory generic-primitive
 */
export interface NativeCallablePrivateSlot {
  readonly key: string
  readonly constructor: IrValueId
  readonly constructorSource: SemanticResultId
  readonly installation: SemanticResultId
  readonly source: SemanticResultId
  readonly callable: FunctionId
  readonly value: IrOperand
}

interface OwnPropertyPlan {
  readonly receipt: NativeCallablePrivateSlot
  readonly store: SetOperation
  readonly reads: readonly GetOperation[]
}

interface OwnPropertyAuthority {
  readonly deriver: RepresentationDeriver
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly semanticOperationOf?: (lineage: SemanticResultId) => SemanticOperation | null
}

/** Property stores thread their receiver; the enclosing assignment publishes the RHS separately. */
export const ordinaryFunctionStoreResultMatches = (operation: SetOperation, semantic: SemanticOperation | null): boolean => {
  if (operation.result === null) return true
  const receiver = semantic === null ? undefined : operandOf(semantic, 'receiver')
  const value = semantic === null ? undefined : resultOf(semantic, 'value')
  return (
    semantic?.family === 'property' &&
    semantic.internalMethod === 'set' &&
    value?.id === operation.lineage &&
    receiver !== undefined &&
    value.type === receiver.type &&
    representationKey(operation.result.representation) === representationKey(operation.receiver.representation)
  )
}

// Receipts add their native read source to uniform SSA uses. Proof discovery
// must inspect original operations rather than consume its own proposed edge.
const originalOperands = (operation: IrOperation): readonly IrOperand[] =>
  operation.kind === 'get' ? [operation.receiver, operation.key] : operandsOfIrOperation(operation)

/** Exact local Function allocation + installed data slot, with no mutable or
 * external property protocol. This supplies source provenance, never an
 * erased receiver payload for arbitrary constructor Functions.
 */
const createOwnPropertyPlans = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined,
  ignoresReceiver: (functionId: FunctionId) => boolean,
  authority?: OwnPropertyAuthority
): ((read: GetOperation, key: string | null) => OwnPropertyPlan | null) => {
  const operations = bodies.flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, { readonly block: object; readonly index: number }>()
  const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  const owners = new Map<IrOperation, IrBody>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const [index, operation] of allOperationsOf(block).entries()) {
        positions.set(operation, { block, index })
        owners.set(operation, body)
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        if (operation.kind === 'binding-write') {
          const held = writes.get(operation.declaration) ?? []
          held.push(operation)
          writes.set(operation.declaration, held)
        }
      }
  const identity = (operation: Extract<IrOperation, { kind: 'convert' }>): boolean =>
    nativeCallableIdentityTransportMatches(
      operation.source.representation,
      operation.result.representation,
      conversions?.nodeById(operation.conversionUse)
    )
  const roots = new Map<IrValueId, IrValueId | null>()
  const rootOf = (value: IrValueId): IrValueId | null => {
    if (roots.has(value)) return roots.get(value)!
    roots.set(value, null)
    const operation = definitions.get(value)
    let root: IrValueId | null = null
    if (operation?.kind === 'allocate-callable') root = operation.result.id
    else if (operation?.kind === 'convert' && identity(operation)) root = rootOf(operation.source.value)
    else if (
      operation?.kind === 'binding-read' &&
      ['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? '')
    ) {
      const stored = writes.get(operation.declaration)
      if (stored?.length === 1) root = rootOf(stored[0]!.value.value)
    } else if (operation?.kind === 'phi' && operation.incoming.length > 0) {
      const alternatives = operation.incoming.map((incoming) => rootOf(incoming.value.value))
      if (alternatives[0] !== null && alternatives.every((candidate) => candidate === alternatives[0])) root = alternatives[0]!
    } else if (
      operation?.kind === 'set' &&
      operation.ordinaryFunctionDataWrite === true &&
      ordinaryFunctionStoreResultMatches(operation, authority?.semanticOperationOf?.(operation.lineage) ?? null)
    )
      root = rootOf(operation.receiver.value)
    roots.set(value, root)
    return root
  }
  const keyOf = (value: IrValueId): string | null => {
    const operation = definitions.get(value)
    return operation?.kind === 'constant' && operation.literal === 'string' ? operation.text : null
  }
  // Alias discovery is conservative across bodies so an unentered closure
  // cannot hide a mutation. The selected value must also be initialized now.
  const availableBefore = (value: IrValueId, use: IrOperation, visiting = new Set<IrValueId>()): boolean => {
    if (visiting.has(value)) return false
    visiting.add(value)
    const definition = definitions.get(value)
    const at = definition && positions.get(definition)
    const target = positions.get(use)
    if (!definition || !at || !target || at.block !== target.block || at.index >= target.index) return false
    if (definition.kind === 'allocate-callable') return true
    if (definition.kind === 'convert' && identity(definition)) return availableBefore(definition.source.value, definition, visiting)
    if (definition.kind === 'binding-read') {
      const stored = writes.get(definition.declaration)
      const write = stored?.length === 1 ? stored[0] : undefined
      const writeSite = write && positions.get(write)
      return (
        write !== undefined &&
        writeSite?.block === at.block &&
        writeSite.index < at.index &&
        availableBefore(write.value.value, write, visiting)
      )
    }
    if (
      definition.kind === 'set' &&
      definition.ordinaryFunctionDataWrite === true &&
      ordinaryFunctionStoreResultMatches(definition, authority?.semanticOperationOf?.(definition.lineage) ?? null)
    )
      return availableBefore(definition.receiver.value, definition, visiting)
    return false
  }
  return (read, key) => {
    if (read.receiver.representation.kind !== 'function-and-constructor' || key === null) return null
    if (['prototype', '__proto__', 'caller', 'arguments', 'name', 'length'].includes(key)) return null
    const root = rootOf(read.receiver.value)
    if (root === null) return null
    const constructor = definitions.get(root)
    if (
      constructor?.kind !== 'allocate-callable' ||
      constructor.captures.length !== 0 ||
      constructor.result.representation.kind !== 'function-and-constructor'
    )
      return null
    const aliasesRoot = (value: IrValueId): boolean => rootOf(value) === root
    const stores = operations.filter(
      (operation): operation is Extract<IrOperation, { kind: 'set' | 'define-own-property' }> =>
        (operation.kind === 'set' || operation.kind === 'define-own-property') &&
        aliasesRoot(operation.receiver.value) &&
        keyOf(operation.key.value) === key
    )
    if (stores.length !== 1) return null
    const store = stores[0]!
    if (store.kind !== 'set' || store.ordinaryFunctionDataWrite !== true) return null
    // A used result is admissible only under the canonical receiver-threading contract.
    if (
      store.result !== null &&
      operations.some((operation) => originalOperands(operation).some((operand) => operand.value === store.result!.id)) &&
      !ordinaryFunctionStoreResultMatches(store, authority?.semanticOperationOf?.(store.lineage) ?? null)
    )
      return null
    if (!availableBefore(store.receiver.value, store) || !availableBefore(store.value.value, store)) return null
    const source = rootOf(store.value.value)
    const allocation = source === null ? undefined : definitions.get(source)
    if (
      allocation?.kind !== 'allocate-callable' ||
      allocation.captures.length !== 0 ||
      !ignoresReceiver(allocation.functionId) ||
      representationKey(allocation.result.representation) !== representationKey(store.value.representation)
    )
      return null
    const selectedReads = operations.filter(
      (operation): operation is GetOperation =>
        operation.kind === 'get' && aliasesRoot(operation.receiver.value) && keyOf(operation.key.value) === key
    )
    const storeSite = positions.get(store)
    if (
      !storeSite ||
      !selectedReads.includes(read) ||
      selectedReads.some(
        (operation) => representationKey(operation.result.representation) !== representationKey(store.value.representation)
      ) ||
      selectedReads.some((operation) => {
        const site = positions.get(operation)
        return site?.block !== storeSite.block || site.index <= storeSite.index || !availableBefore(operation.receiver.value, operation)
      })
    )
      return null

    const constructorAbi = constructor.result.representation.construct
    const instance = constructorAbi.result
    const instanceKey = representationKey(instance)
    const containsInstance = (representation: Representation, seen = new Set<string>()): boolean => {
      const key = representationKey(representation)
      if (key === instanceKey) return true
      if (seen.has(key)) return false
      seen.add(key)
      if (representation.kind === 'optional') return containsInstance(representation.payload, seen)
      if (representation.kind === 'tagged-union') return representation.arms.some((arm) => containsInstance(arm.value, seen))
      if (representation.kind === 'array-object') return containsInstance(representation.element, seen)
      if (representation.kind === 'dictionary') return containsInstance(representation.value, seen)
      if (representation.kind === 'record' || representation.kind === 'record-with-index')
        return representation.fields.some((field) => containsInstance(field.value, seen))
      if (representation.kind === 'native-record-ref' && representation.native === null && authority)
        return recordFieldsOfShape(authority.deriver, representation.shapeId)?.some((field) => containsInstance(field.value, seen)) ?? false
      // A callable's declared return type is not a stored instance payload.
      return false
    }
    const primitiveData = (value: Representation): boolean => {
      if (value.kind === 'optional') return primitiveData(value.payload)
      if (value.kind === 'tagged-union') return value.arms.every((arm) => primitiveData(arm.value))
      return (
        ['scalar', 'string', 'symbol', 'null', 'undefined', 'void'].includes(value.kind) ||
        (value.kind === 'array-object' &&
          value.ownership === 'shared-refcount' &&
          value.extension === null &&
          ['scalar', 'string', 'symbol', 'null', 'undefined'].includes(value.element.kind))
      )
    }
    const confinedInstances = (): boolean => {
      if (
        authority === undefined ||
        instance.kind !== 'native-record-ref' ||
        instance.native !== null ||
        instance.ownership !== 'shared-refcount'
      )
        return false
      const fields = recordFieldsOfShape(authority.deriver, instance.shapeId)
      if (
        fields === null ||
        fields.some((field) => !primitiveData(field.value)) ||
        (recordAccessorsOfShape(authority.deriver, instance.shapeId)?.length ?? 0) !== 0 ||
        recordIndexesOfShape(authority.deriver, instance.shapeId).length !== 0
      )
        return false
      const factoryBodies = bodies.filter((body) => body.sourceOwner === allocation.functionId)
      const constructorBodies = bodies.filter((body) => body.sourceOwner === constructor.functionId)
      if (
        factoryBodies.length === 0 ||
        constructorBodies.length === 0 ||
        factoryBodies.some((body) => body.abi === null || representationKey(body.abi.result) !== instanceKey) ||
        constructorBodies.some((body) => body.construct === null || abiKey(body.construct) !== abiKey(constructorAbi))
      )
        return false
      for (const operation of operations) {
        const incoming = originalOperands(operation).filter((operand) => containsInstance(operand.representation))
        const result = resultOfIrOperation(operation)
        const produces = result !== null && containsInstance(result.representation)
        if (incoming.length === 0 && !produces) continue
        if (
          incoming.some((operand) => representationKey(operand.representation) !== instanceKey) ||
          (produces && representationKey(result!.representation) !== instanceKey)
        )
          return false
        if (operation.kind === 'get' || operation.kind === 'set') {
          const field = declaredRecordFieldOf(
            authority.deriver,
            operation.receiver.representation,
            keyOf(operation.key.value) ?? '',
            authority.classes
          )
          if (
            representationKey(operation.receiver.representation) !== instanceKey ||
            field === null ||
            !primitiveData(field.value) ||
            incoming.some((operand) => operand.value !== operation.receiver.value)
          )
            return false
          continue
        }
        if (operation.kind === 'receiver') {
          if (owners.get(operation)?.sourceOwner !== constructor.functionId) return false
          continue
        }
        if (operation.kind === 'construct') {
          if (!aliasesRoot(operation.callee.value) || !aliasesRoot(operation.newTarget.value) || incoming.length !== 0) return false
          continue
        }
        if (operation.kind === 'call') {
          if (!getterAliases.has(operation.callee.value) || incoming.length !== 0) return false
          continue
        }
        if (operation.kind === 'binding-read' || operation.kind === 'binding-write') {
          if (!['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? '')) return false
          if (operation.kind === 'binding-read' && writes.get(operation.declaration)?.length !== 1) return false
          continue
        }
        if (operation.kind === 'return') {
          if (![constructor.functionId, allocation.functionId].includes(owners.get(operation)?.sourceOwner as FunctionId)) return false
          continue
        }
        if (operation.kind === 'convert') {
          if (
            representationKey(operation.source.representation) !== instanceKey ||
            representationKey(operation.result.representation) !== instanceKey
          )
            return false
          continue
        }
        if (operation.kind === 'phi' || (operation.kind === 'compute' && observesNativeCarrierOnly(operation))) continue
        return false
      }
      return true
    }
    const getterAliases = new Set(selectedReads.map((operation) => operation.result.id))
    let changed = true
    while (changed) {
      changed = false
      for (const operation of operations)
        if (
          operation.kind === 'convert' &&
          getterAliases.has(operation.source.value) &&
          identity(operation) &&
          !getterAliases.has(operation.result.id)
        ) {
          getterAliases.add(operation.result.id)
          changed = true
        }
    }
    for (const operation of operations) {
      if (originalOperands(operation).some((operand) => getterAliases.has(operand.value))) {
        if (operation.kind === 'convert' && identity(operation)) continue
        if (
          operation.kind !== 'call' ||
          !getterAliases.has(operation.callee.value) ||
          operation.arguments.some((operand) => getterAliases.has(operand.value))
        )
          return null
      }
      // The stored Function itself cannot escape independently of its slot.
      if (operation !== store && originalOperands(operation).some((operand) => rootOf(operand.value) === source)) return null
      const aliases = originalOperands(operation).filter((operand) => aliasesRoot(operand.value))
      if (aliases.length === 0) continue
      if (operation.kind === 'binding-write') {
        if (
          !['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? '') ||
          writes.get(operation.declaration)?.length !== 1
        )
          return null
        continue
      }
      if (operation.kind === 'convert') {
        if (!identity(operation)) return null
        continue
      }
      if (operation.kind === 'phi' || (operation.kind === 'compute' && observesNativeCarrierOnly(operation))) continue
      if (operation === store || selectedReads.includes(operation as GetOperation)) continue
      if (operation.kind === 'construct') {
        if (
          !aliasesRoot(operation.callee.value) ||
          !aliasesRoot(operation.newTarget.value) ||
          operation.arguments.some((operand) => aliasesRoot(operand.value)) ||
          !confinedInstances()
        )
          return null
        continue
      }
      if (
        operation.kind === 'call' &&
        getterAliases.has(operation.callee.value) &&
        !operation.arguments.some((operand) => aliasesRoot(operand.value))
      )
        continue
      return null
    }
    return {
      store,
      reads: selectedReads,
      receipt: {
        key,
        constructor: root,
        constructorSource: constructor.lineage,
        installation: store.lineage,
        source: allocation.lineage,
        callable: allocation.functionId,
        value: store.value
      }
    }
  }
}

/** Source-only observation of the same confined-slot plan, without granting property storage support. */
export const createNativeCallableOwnPropertySource = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined,
  ignoresReceiver: (functionId: FunctionId) => boolean
): ((read: GetOperation, key: string | null) => readonly FunctionId[] | null) => {
  const query = createOwnPropertyPlans(bodies, placements, conversions, ignoresReceiver)
  return (read, key) => {
    const plan = query(read, key)
    return plan === null ? null : [plan.receipt.callable]
  }
}

/** Inputs shared by receipt publication and independent certification.
 * @semanticCategory generic-primitive
 */
export interface NativeCallablePrivateSlotInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly conversions: Pick<ConversionCensus, 'nodeById'>
  readonly deriver: RepresentationDeriver
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly graph: Pick<SemanticGraph, 'operations' | 'results'>
}

/** Recomputes native slot receipts from actual source allocations, never from their published marker. */
export const nativeCallablePrivateSlotsOf = (
  input: NativeCallablePrivateSlotInput
): ReadonlyMap<IrOperation, NativeCallablePrivateSlot> => {
  const bodies = [...input.bodies.values()]
  const operations = bodies.flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map(
    operations.flatMap((operation) => {
      const result = resultOfIrOperation(operation)
      return result === null ? [] : [[result.id, operation] as const]
    })
  )
  const semanticOf = (lineage: SemanticResultId): SemanticOperation | null => input.graph.operations.get(operationOfResult(lineage)) ?? null
  const knownSource = (value: IrValueId, expected: SemanticResultId, seen = new Set<SemanticResultId>()): boolean => {
    if (seen.has(expected)) return false
    seen.add(expected)
    const definition = definitions.get(value)
    if (definition?.lineage === expected) return true
    const operation = semanticOf(expected)
    // Only the source's explicit evaluated identity aliases qualify. Property
    // result threading is authenticated separately, not guessed as an alias.
    const identity =
      operation?.family === 'computation' && (operation.form === 'assignment' || operation.form === 'comma')
        ? operation.operands.filter((operand) => operand.evaluation.kind !== 'provenance').at(-1)
        : operation?.family === 'binding' && (operation.action === 'initialize' || operation.action === 'write')
          ? operandOf(operation, operation.action === 'initialize' ? 'initializer' : 'value')
          : undefined
    return identity?.source.kind === 'result' && knownSource(value, identity.source.result, seen)
  }
  const operandMatches = (actual: IrOperand, semantic: SemanticOperation, role: string): boolean => {
    const expected = operandOf(semantic, role)
    return expected?.source.kind === 'result' && knownSource(actual.value, expected.source.result)
  }
  const allocationMatches = (operation: IrOperation | undefined): boolean => {
    if (operation?.kind !== 'allocate-callable') return false
    const source = semanticOf(operation.lineage)
    return (
      source?.family === 'allocation' &&
      source.allocated === 'function-object' &&
      source.callable === operation.functionId &&
      resultOf(source, 'value')?.id === operation.lineage
    )
  }
  const independent = (id: FunctionId): boolean => {
    const variants = bodies.filter((body) => body.sourceOwner === id)
    return variants.length > 0 && variants.every(nativeBodyIgnoresLogicalReceiver)
  }
  const query = createOwnPropertyPlans(bodies, input.placements, input.conversions, independent, {
    deriver: input.deriver,
    classes: input.classes,
    semanticOperationOf: semanticOf
  })
  const receipts = new Map<IrOperation, NativeCallablePrivateSlot>()
  for (const read of operations) {
    if (read.kind !== 'get') continue
    const key = definitions.get(read.key.value)
    const plan = query(read, key?.kind === 'constant' && key.literal === 'string' ? key.text : null)
    if (plan === null) continue
    const source = semanticOf(plan.store.lineage)
    if (
      source === null ||
      !ordinaryFunctionDataWriteMatches(plan.store, source, definitions.get(plan.store.key.value) ?? null) ||
      !ordinaryFunctionStoreResultMatches(plan.store, source) ||
      !operandMatches(plan.store.value, source, 'value') ||
      !operandMatches(plan.store.receiver, source, 'receiver') ||
      !allocationMatches(definitions.get(plan.receipt.constructor)) ||
      !allocationMatches(definitions.get(plan.receipt.value.value))
    )
      continue
    let authentic = true
    for (const operation of operations) {
      if (operation.kind !== 'binding-read' && operation.kind !== 'binding-write') continue
      // All native Function and constructed-instance cells in this bounded
      // proof must still be the source's actual declaration/value edge.
      const result = resultOfIrOperation(operation)
      const relevant = operation.kind === 'binding-write' ? operation.value.representation : result?.representation
      if (relevant === undefined || !['function-and-constructor', 'native-record-ref'].includes(relevant.kind)) continue
      const semantic = semanticOf(operation.lineage)
      if (
        semantic?.family !== 'binding' ||
        semantic.declaration !== operation.declaration ||
        (operation.kind === 'binding-read'
          ? semantic.action !== 'read'
          : !operandMatches(operation.value, semantic, semantic.action === 'initialize' ? 'initializer' : 'value'))
      ) {
        authentic = false
        break
      }
    }
    if (!authentic) continue
    for (const selected of plan.reads) {
      const sourceRead = semanticOf(selected.lineage)
      const sourceKey = sourceRead === null ? undefined : operandOf(sourceRead, 'key')
      if (
        sourceRead?.family !== 'property' ||
        sourceRead.internalMethod !== 'get' ||
        resultOf(sourceRead, 'value')?.id !== selected.lineage ||
        !operandMatches(selected.receiver, sourceRead, 'receiver') ||
        sourceKey?.source.kind !== 'constant' ||
        sourceKey.source.literal !== 'string' ||
        sourceKey.source.text !== plan.receipt.key
      ) {
        authentic = false
        break
      }
    }
    if (!authentic) continue
    receipts.set(plan.store, plan.receipt)
    for (const selected of plan.reads) receipts.set(selected, plan.receipt)
  }
  return receipts
}

export const nativeCallablePrivateSlotMatches = (
  expected: NativeCallablePrivateSlot | undefined,
  actual: NativeCallablePrivateSlot | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  expected.key === actual.key &&
  expected.constructor === actual.constructor &&
  expected.constructorSource === actual.constructorSource &&
  expected.installation === actual.installation &&
  expected.source === actual.source &&
  expected.callable === actual.callable &&
  expected.value.value === actual.value.value &&
  representationKey(expected.value.representation) === representationKey(actual.value.representation)

export const publishNativeCallablePrivateSlots = (input: NativeCallablePrivateSlotInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const receipts = nativeCallablePrivateSlotsOf(input)
  return new Map(
    [...input.bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([key, block]) => [
            key,
            {
              ...block,
              operations: block.operations.map((operation) => {
                if (operation.kind !== 'get' && operation.kind !== 'set') return operation
                const { privateNativeCallableSlot: _old, ...source } = operation
                const receipt = receipts.get(operation)
                return receipt === undefined ? source : { ...source, privateNativeCallableSlot: receipt }
              })
            }
          ])
        )
      }
    ])
  )
}
