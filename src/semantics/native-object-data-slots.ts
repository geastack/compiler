import {
  withoutFunctionSpecialization,
  type DeclarationId,
  type FunctionId,
  type OperationId,
  type SemanticResultId
} from '../identity/ids.js'
import { callableOriginsOf, callableWriteTargetsOf, type CallableWriteTarget } from './callable-origins.js'
import type { CallableOwnDataValue } from './callable-own-data-slots.js'
import type { SemanticGraph } from './model/graph.js'
import { identityOperandOf, operandOf, resultOf, type SemanticOperand } from './model/operands.js'
import type { AllocationOperation, BindingOperation, InvocationOperation, SemanticOperation } from './model/operations.js'
import type { NativeOwnAssignmentValue } from './native-own-assignment.js'
import { recordObjectShapeOf } from '../representation/unwritten-record-members.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'

/** A fixed own slot belongs to the allocation that stores it, independently
 * of every structural view naming that object.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectDataSlotSchema {
  readonly allocation: NativeObjectDataAllocation
  readonly key: string
  readonly writers: readonly {
    readonly mutation: CallableWriteTarget
    readonly value: CallableOwnDataValue | null
    /** CopyDataProperties' CreateDataProperty of a key the literal's layout
     * lacks: the stored value is the source's own field of that key, so its
     * carrier is the source carrier's field, not an evaluated operand. */
    readonly spreadSource?: SemanticOperand
  }[]
  /** Complete actual slot inputs published by the joint source session,
   * including writers reached through admitted call/parameter aliases. */
  readonly storedValues?: readonly NativeOwnAssignmentValue[]
  readonly reads: readonly SemanticOperation[]
  readonly blockers: readonly {
    readonly operation: SemanticOperation
    readonly kind: 'open-alias' | 'exposure' | 'unknown-key' | 'descriptor' | 'prototype'
  }[]
  /** Accounted consumers that read the allocation's own values through the
   * dynamic property protocol (an unknown-key get, an intact values/entries/
   * stringify). They publish no alias, but every stored slot must carry a
   * certified materializer so that read answers natively. */
  readonly observers: readonly SemanticOperation[]
}

/** Exact canonical aliases and their closed source slots. An unaccounted
 * consumer invalidates the allocation's schemas rather than dropping it from
 * the writer inventory.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectDataSlotCensus {
  readonly origins: ReadonlyMap<SemanticResultId, NativeObjectDataAllocation>
  /** Every allocation a result may hold, including results in a known callee
   * frame (a parameter bound only by exact calls) and the results of exact
   * calls whose closed callee returns the allocation. `origins` remains the
   * single-allocation local subset. */
  readonly aliases: ReadonlyMap<SemanticResultId, ReadonlySet<NativeObjectDataAllocation>>
  /** The aliased results that can hold nothing but their listed allocations
   * (or a non-object): every caller of a followed parameter passes one, every
   * write of a cell stores one, every return of a followed call returns one. */
  readonly complete: ReadonlySet<SemanticResultId>
  readonly schemas: ReadonlyMap<OperationId, ReadonlyMap<string, NativeObjectDataSlotSchema>>
  /** The one named own slot each authenticated `Object.defineProperty(target,
   * 'key', descriptor)` creates, keyed by the invocation: a constant string key
   * that no ordinary prototype member and no array index can answer for. The
   * definition demands that slot alone on its target; whether the target's
   * carrier already declares the key is the carrier's question, not this one. */
  readonly namedDataDefinitions: ReadonlyMap<OperationId, string>
}

/** The standard zero-argument Object invocation publishes its own fresh
 * allocation proof; it is never inferred from an alias's public shape.
 * @semanticCategory generic-primitive
 */
export type NativeObjectDataAllocation = AllocationOperation | (InvocationOperation & { readonly freshOrdinaryObject: true })

const censuses = new WeakMap<SemanticGraph, NativeObjectDataSlotCensus>()
const keyOf = (value: SemanticOperand | undefined): string | null =>
  value?.source.kind === 'constant' && (value.source.literal === 'string' || value.source.literal === 'number') ? value.source.text : null

/** Exact source call frames an object can enter and leave without being
 * published to unknown code. A parameter is followed only when it is bound
 * by its one initializer from its own argument position (no `arguments`
 * object, default or rest reads that slot) and never rebound; a return is
 * followed only out of a synchronous source function whose Function value is
 * consumed solely as the callee of exact calls, so every frame that receives
 * the returned object is one of those calls' results.
 * @semanticCategory generic-primitive
 */
interface SourceFrameEdges {
  readonly parameterOf: (invocation: SemanticOperation, ordinal: number) => BindingOperation | null
  readonly returnsTo: (callable: FunctionId) => readonly SemanticResultId[] | null
  /** Every invocation of a function whose value is consumed only as an exact callee, or `null`. */
  readonly callersOf: (callable: FunctionId) => readonly SemanticOperation[] | null
  /** The source function copy an exact call enters, or `null`. */
  readonly targetOf: (operation: SemanticOperation) => FunctionId | null
}

const sourceFrameEdgesOf = (graph: SemanticGraph, writes: ReadonlyMap<DeclarationId, readonly BindingOperation[]>): SourceFrameEdges => {
  const parameters = new Map<string, BindingOperation>()
  const slotReads = new Map<string, number>()
  const exactCalls = new Map<FunctionId, SemanticResultId[]>()
  const exactCallers = new Map<FunctionId, SemanticOperation[]>()
  const functionAllocations = new Map<FunctionId, AllocationOperation>()
  const slotKey = (callable: FunctionId, ordinal: number): string => `${callable}#${ordinal}`
  const callables = callableOriginsOf(graph)
  // A generic function's exact target names its root; the callee value names
  // the monomorphized copy whose parameters, allocations and returns the call
  // actually enters. Without that copy the call follows no frame at all.
  const targetOf = (operation: SemanticOperation): FunctionId | null => {
    const root = exactCallTargetOf(operation)
    if (root === null) return null
    const callee = operandOf(operation, 'callee')
    const copy = callee?.source.kind === 'result' ? callables.get(callee.source.result) : undefined
    return copy !== undefined && copy !== root && withoutFunctionSpecialization(copy) === root ? copy : root
  }
  for (const operation of graph.operations.values()) {
    if (operation.family === 'allocation' && operation.allocated === 'function-object' && operation.callable !== null)
      functionAllocations.set(operation.callable, operation)
    if (operation.caller.kind === 'function')
      for (const operand of operation.operands)
        if (operand.source.kind === 'parameter') {
          const key = slotKey(operation.caller.functionId, operand.source.ordinal)
          slotReads.set(key, (slotReads.get(key) ?? 0) + 1)
        }
    if (
      operation.family === 'binding' &&
      operation.action === 'initialize' &&
      operation.parameterInitialization === true &&
      operation.caller.kind === 'function'
    ) {
      const initializer = operandOf(operation, 'initializer')
      if (initializer?.source.kind === 'parameter')
        parameters.set(slotKey(operation.caller.functionId, initializer.source.ordinal), operation)
    }
    const callee = targetOf(operation)
    const result = callee === null ? undefined : resultOf(operation, 'value')
    if (callee !== null) exactCallers.set(callee, [...(exactCallers.get(callee) ?? []), operation])
    if (callee !== null && result) exactCalls.set(callee, [...(exactCalls.get(callee) ?? []), result.id])
  }
  const parameterOf = (invocation: SemanticOperation, ordinal: number): BindingOperation | null => {
    const callable = targetOf(invocation)
    if (callable === null || invocation.operands.some((operand) => operand.role === 'spread-argument')) return null
    const parameter = parameters.get(slotKey(callable, ordinal))
    if (
      !parameter ||
      slotReads.get(slotKey(callable, ordinal)) !== 1 ||
      parameter.external !== undefined ||
      (writes.get(parameter.declaration)?.length ?? 0) !== 1
    )
      return null
    return parameter
  }
  const open = new Set<FunctionId>()
  for (const operation of graph.operations.values())
    for (const operand of operation.operands) {
      const callable = operand.source.kind === 'result' ? callables.get(operand.source.result) : undefined
      if (callable === undefined) continue
      // A provenance operand is evaluated elsewhere: that runtime consumer is
      // the one classified (a binding read's reference, a call's receiver).
      if (operation.family === 'reference' || operand.evaluation.kind === 'provenance') continue
      if (operation.family === 'binding' && operation.external === undefined) continue
      if (operand.role === 'callee' && targetOf(operation) === callable) continue
      open.add(callable)
    }
  const returnsTo = (callable: FunctionId): readonly SemanticResultId[] | null => {
    const allocation = functionAllocations.get(callable)
    if (!allocation || allocation.generatorFunction === true || allocation.asyncFunction === true || open.has(callable)) return null
    return exactCalls.get(callable) ?? []
  }
  const callersOf = (callable: FunctionId): readonly SemanticOperation[] | null =>
    !functionAllocations.has(callable) || open.has(callable) ? null : (exactCallers.get(callable) ?? [])
  return { parameterOf, returnsTo, callersOf, targetOf }
}

/** The one source function an ordinary call enters, or `null`. */
const exactCallTargetOf = (operation: SemanticOperation): FunctionId | null =>
  operation.family === 'invocation' &&
  operation.internalMethod === 'call' &&
  operation.target.kind === 'exact' &&
  operation.target.target.kind === 'function' &&
  operation.selectedSignature?.thisParameter == null
    ? operation.target.target.functionId
    : null

/** This bounded plain-object authority composes the semantic identity spine
 * and complete binding writes. It does not infer an owner from type equality,
 * reinterpret class prototypes as Object.prototype, or follow unknown calls.
 */
export const nativeObjectDataSlotSchemasOf = (graph: SemanticGraph): NativeObjectDataSlotCensus => {
  const known = censuses.get(graph)
  if (known) return known
  const allocations = [...graph.operations.values()].filter(
    (operation): operation is NativeObjectDataAllocation =>
      (operation.family === 'allocation' && operation.allocated === 'object-literal') ||
      (operation.family === 'invocation' &&
        operation.freshOrdinaryObject === true &&
        !operation.optionalChain &&
        !operation.operands.some((operand) => operand.role === 'argument'))
  )
  const origins = new Map<SemanticResultId, NativeObjectDataAllocation>()
  const closedBulkRoots = new Set<SemanticResultId>()
  const closedSlotWriters = new Map<NativeObjectDataAllocation, Map<string, Set<OperationId>>>()
  const bulkStoredValues = new Map<SemanticResultId, Map<string, NativeOwnAssignmentValue[]>>()
  const addStoredValues = (
    allocation: SemanticResultId,
    slots: readonly { readonly key: string; readonly values: readonly NativeOwnAssignmentValue[] }[]
  ): void => {
    const stored = bulkStoredValues.get(allocation) ?? new Map<string, NativeOwnAssignmentValue[]>()
    for (const slot of slots) {
      const values = stored.get(slot.key) ?? []
      values.push(...slot.values)
      stored.set(slot.key, values)
    }
    bulkStoredValues.set(allocation, stored)
    closedBulkRoots.add(allocation)
  }
  for (const operation of graph.operations.values())
    if (operation.family === 'invocation' && operation.intrinsicMutation === 'object-assign' && operation.nativeOwnAssignment) {
      for (const root of operation.nativeOwnAssignment.targetSlots) addStoredValues(root.allocation, root.slots)
      for (const source of operation.nativeOwnAssignment.sources)
        for (const root of source.roots) addStoredValues(root.allocation, root.slots)
    }
  const writes = new Map<DeclarationId, BindingOperation[]>()
  for (const allocation of allocations) {
    const result = resultOf(allocation, 'value')
    if (result) origins.set(result.id, allocation)
  }
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property') continue
    const receiver = operandOf(operation, 'receiver')
    const key = keyOf(operandOf(operation, 'key'))
    for (const slot of operation.nativeOwnSlot ? [operation.nativeOwnSlot] : (operation.nativeOwnSlots ?? [])) {
      if (slot.roots.length !== 1 || receiver?.source.kind !== 'result') continue
      if (key !== null ? slot.key !== key : !operation.provenKeyTexts?.includes(slot.key)) continue
      const root = slot.roots[0]!
      const allocation = origins.get(root.allocation)
      if (!allocation) continue
      const known = origins.get(receiver.source.result)
      if (known !== undefined && known !== allocation) continue
      origins.set(receiver.source.result, allocation)
      addStoredValues(root.allocation, [{ key: slot.key, values: root.values }])
      const slots = closedSlotWriters.get(allocation) ?? new Map<string, Set<OperationId>>()
      const writers = slots.get(slot.key) ?? new Set<OperationId>()
      for (const writer of root.writers) writers.add(writer)
      slots.set(slot.key, writers)
      closedSlotWriters.set(allocation, slots)
    }
  }
  for (const operation of graph.operations.values())
    if (operation.family === 'binding' && (operation.action === 'initialize' || operation.action === 'write')) {
      const rows = writes.get(operation.declaration) ?? []
      rows.push(operation)
      writes.set(operation.declaration, rows)
    }
  const cells = new Map<DeclarationId, NativeObjectDataAllocation>()
  const originOf = (operand: SemanticOperand | undefined): NativeObjectDataAllocation | undefined =>
    operand?.source.kind === 'result' ? origins.get(operand.source.result) : undefined
  let changed = true
  while (changed) {
    changed = false
    for (const [declaration, rows] of writes) {
      if (cells.has(declaration) || rows.some((row) => row.external !== undefined || row.parameterInitialization === true)) continue
      const sources = rows.map((row) => originOf(identityOperandOf(row)))
      const source = sources[0]
      if (source && sources.every((one) => one === source)) {
        cells.set(declaration, source)
        changed = true
      }
    }
    for (const operation of graph.operations.values()) {
      const result = resultOf(operation, 'value')
      if (!result || origins.has(result.id)) continue
      const source =
        operation.family === 'binding' && operation.action === 'read' && operation.external === undefined
          ? cells.get(operation.declaration)
          : originOf(identityOperandOf(operation))
      if (!source) continue
      origins.set(result.id, source)
      changed = true
      if (operation.family === 'binding')
        for (const operand of operation.operands) {
          if (operand.source.kind !== 'result') continue
          const producer = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as OperationId))
          if (producer?.family === 'reference' && producer.form === 'identifier') origins.set(operand.source.result, source)
        }
    }
  }
  // The local origin map above follows identity inside one frame. Exact
  // source call frames extend it: a parameter bound only by exact calls holds
  // every allocation its callers pass, and a closed function's exact call
  // results hold every allocation it returns. Consumers of those results are
  // then classified below exactly like local ones, so the call itself is no
  // longer an opaque publication.
  const frames = sourceFrameEdgesOf(graph, writes)
  const aliases = new Map<SemanticResultId, Set<NativeObjectDataAllocation>>()
  for (const [result, allocation] of origins) aliases.set(result, new Set([allocation]))
  const aliasesOf = (operand: SemanticOperand | undefined): ReadonlySet<NativeObjectDataAllocation> | undefined =>
    operand?.source.kind === 'result' ? aliases.get(operand.source.result) : undefined
  const join = (result: SemanticResultId, held: ReadonlySet<NativeObjectDataAllocation> | undefined): boolean => {
    if (!held?.size) return false
    const known = aliases.get(result)
    if (known === undefined) {
      aliases.set(result, new Set(held))
      return true
    }
    const before = known.size
    for (const allocation of held) known.add(allocation)
    return known.size !== before
  }
  // A declaration all of whose writes hold tracked allocations: its reads
  // hold their union. A write of anything untracked leaves the cell unknown,
  // and the write that stored a tracked allocation there is an open alias.
  const aliasCells = new Map<DeclarationId, Set<NativeObjectDataAllocation>>()
  const parameterCells = new Map<DeclarationId, Set<NativeObjectDataAllocation>>()
  const parameterBindings = new Map<DeclarationId, { readonly binding: BindingOperation; readonly ordinal: number }>()
  const returnsOf = new Map<FunctionId, SemanticOperation[]>()
  for (const operation of graph.operations.values())
    if (operation.family === 'control' && operation.form === 'return' && operation.caller.kind === 'function')
      returnsOf.set(operation.caller.functionId, [...(returnsOf.get(operation.caller.functionId) ?? []), operation])
  let grew = true
  while (grew) {
    grew = false
    for (const [declaration, rows] of writes) {
      if (rows.some((row) => row.external !== undefined || row.parameterInitialization === true)) continue
      const held = rows.map((row) => aliasesOf(identityOperandOf(row)))
      if (held.some((one) => one === undefined)) continue
      const cell = aliasCells.get(declaration) ?? new Set<NativeObjectDataAllocation>()
      const before = cell.size
      for (const one of held) for (const allocation of one!) cell.add(allocation)
      aliasCells.set(declaration, cell)
      if (cell.size !== before) grew = true
    }
    for (const operation of graph.operations.values()) {
      if (operation.family === 'invocation')
        for (const operand of operation.operands) {
          if (operand.role !== 'argument') continue
          const held = aliasesOf(operand)
          const parameter = held === undefined ? null : frames.parameterOf(operation, operand.ordinal)
          if (parameter === null) continue
          parameterBindings.set(parameter.declaration, { binding: parameter, ordinal: operand.ordinal })
          const cell = parameterCells.get(parameter.declaration) ?? new Set<NativeObjectDataAllocation>()
          const before = cell.size
          for (const allocation of held!) cell.add(allocation)
          parameterCells.set(parameter.declaration, cell)
          const value = resultOf(parameter, 'value')
          if (value) join(value.id, cell)
          if (cell.size !== before) grew = true
        }
      if (operation.family === 'control' && operation.form === 'return' && operation.caller.kind === 'function') {
        const held = aliasesOf(operandOf(operation, 'value'))
        if (held !== undefined)
          for (const target of frames.returnsTo(operation.caller.functionId) ?? []) if (join(target, held)) grew = true
      }
      const result = resultOf(operation, 'value')
      if (!result) continue
      const held =
        operation.family === 'binding' && operation.action === 'read' && operation.external === undefined
          ? (parameterCells.get(operation.declaration) ?? aliasCells.get(operation.declaration))
          : aliasesOf(identityOperandOf(operation))
      if (join(result.id, held)) grew = true
    }
  }
  // Completeness is the greatest fixpoint: a result stays complete while
  // every value its derivation can deliver is itself a complete alias.
  const complete = new Set(aliases.keys())
  const isComplete = (operand: SemanticOperand | undefined): boolean =>
    operand?.source.kind === 'result' && complete.has(operand.source.result)
  const parameterComplete = (declaration: DeclarationId): boolean => {
    const parameter = parameterBindings.get(declaration)
    if (!parameter || parameter.binding.caller.kind !== 'function') return false
    const callers = frames.callersOf(parameter.binding.caller.functionId)
    return (
      callers !== null &&
      callers.every(
        (call) =>
          isComplete(operandOf(call, 'argument', parameter.ordinal)) && frames.parameterOf(call, parameter.ordinal) === parameter.binding
      )
    )
  }
  let shrank = true
  while (shrank) {
    shrank = false
    for (const operation of graph.operations.values()) {
      const result = resultOf(operation, 'value')
      if (!result || !complete.has(result.id) || origins.has(result.id)) continue
      const callee = frames.targetOf(operation)
      const held =
        operation.family === 'binding' && operation.parameterInitialization === true
          ? parameterComplete(operation.declaration)
          : operation.family === 'binding' && operation.action === 'read'
            ? parameterBindings.has(operation.declaration)
              ? parameterComplete(operation.declaration)
              : (writes.get(operation.declaration) ?? []).every((row) => isComplete(identityOperandOf(row)))
            : callee !== null
              ? (returnsOf.get(callee) ?? []).every((one) => operandOf(one, 'value') === undefined || isComplete(operandOf(one, 'value')))
              : isComplete(identityOperandOf(operation))
      if (!held) {
        complete.delete(result.id)
        shrank = true
      }
    }
  }
  const functions = callableOriginsOf(graph)
  const functionAllocations = new Map(
    [...graph.operations.values()].flatMap((one) =>
      one.family === 'allocation' && one.allocated === 'function-object' && one.callable !== null ? [[one.callable, one] as const] : []
    )
  )
  const actualValue = (operand: SemanticOperand, seen = new Set<SemanticResultId>()): CallableOwnDataValue => {
    const source = operand.source
    if (source.kind === 'constant') {
      // The literal form, not an erased assertion's operand type, selects its
      // primitive carrier. Absence of that canonical type remains unknown.
      const literal = source.literal
      const type = [...graph.structuralTypes.values()].find((one) => one.shape.kind === 'primitive' && one.shape.primitive === literal)
      return { operand, producer: null, result: null, type: type?.id ?? null, callable: null, shape: null }
    }
    if (source.kind !== 'result') return { operand, producer: null, result: null, type: null, callable: null, shape: null }
    const producer = graph.operations.get(graph.results.get(source.result) ?? ('' as OperationId)) ?? null
    // Assignment/comma and binding results carry the same actual RHS. IR
    // deliberately omits a new value producer for that identity, so both
    // native storage and its SSA receipt must cite the original source leaf.
    if (!seen.has(source.result)) {
      seen.add(source.result)
      const identity = producer === null ? undefined : identityOperandOf(producer)
      if (identity !== undefined) return actualValue(identity, seen)
    }
    const result = producer?.results.find((one) => one.id === source.result) ?? null
    const allocation = origins.get(source.result)
    const callable = functions.get(source.result) ?? null
    const functionAllocation = callable === null ? null : functionAllocations.get(callable)
    const shape =
      (allocation?.family === 'allocation' ? allocation.shape : null) ??
      functionAllocation?.shape ??
      (producer?.family === 'allocation' ? producer.shape : null)
    return { operand, producer, result, type: shape ?? result?.type ?? null, callable, shape }
  }
  const mutations = callableWriteTargetsOf(graph)
  const writers = new Map<NativeObjectDataAllocation, Map<string, NativeObjectDataSlotSchema['writers'][number][]>>()
  const reads = new Map<NativeObjectDataAllocation, Map<string, SemanticOperation[]>>()
  const blockers = new Map<NativeObjectDataAllocation, NativeObjectDataSlotSchema['blockers'][number][]>()
  const observers = new Map<NativeObjectDataAllocation, SemanticOperation[]>()
  const observe = (allocation: NativeObjectDataAllocation, operation: SemanticOperation): void => {
    const rows = observers.get(allocation) ?? []
    if (!rows.includes(operation)) rows.push(operation)
    observers.set(allocation, rows)
  }
  const block = (
    allocation: NativeObjectDataAllocation,
    operation: SemanticOperation,
    kind: NativeObjectDataSlotSchema['blockers'][number]['kind']
  ): void => {
    // The joint source session publishes complete allocation consumers for
    // an admitted bulk domain. It already follows known native call frames
    // and their aliases; this local schema must not independently reclassify
    // that same closed call as opaque publication. Mutation/descriptor/key
    // blockers still require their own exact storage recipes below.
    const source = resultOf(allocation, 'value')
    if ((kind === 'open-alias' || kind === 'exposure') && source && closedBulkRoots.has(source.id)) return
    const rows = blockers.get(allocation) ?? []
    if (!rows.some((one) => one.operation === operation && one.kind === kind)) rows.push({ operation, kind })
    blockers.set(allocation, rows)
  }
  const closedDataDeletionOf = (allocation: NativeObjectDataAllocation, operation: SemanticOperation): boolean => {
    const source = resultOf(allocation, 'value')
    if (!source || !closedBulkRoots.has(source.id) || operation.family !== 'property' || operation.internalMethod !== 'delete') return false
    const key = keyOf(operandOf(operation, 'key'))
    const keys = key === null ? operation.provenKeyTexts : [key]
    return keys !== undefined && keys.length > 0 && keys.every((key) => key !== '__proto__')
  }
  for (const allocation of allocations) {
    // The authenticated standard constructor creates no own descriptors.
    // Its ambient any signature does not turn that source allocation into an
    // open descriptor domain; SSA replay still checks the native layout.
    if (allocation.family === 'invocation') continue
    // An intersection uses the checker's published resolved object, exactly
    // as its native record layout does. Requiring the wrapper itself to be
    // an object falsely rejected contextual A & B literal allocations.
    const body = recordObjectShapeOf(graph.structuralTypes, allocation.shape)
    const shape = body === null ? undefined : graph.structuralTypes.get(body)?.shape
    // An observed accessor can publish its implicit receiver; a plain
    // allocation index/callable alias inventory alone cannot account for
    // that execution frame. Keep those owners with the accessor authority.
    if (shape?.kind !== 'object' || shape.index.length !== 0 || shape.membersDropped || shape.members.some((member) => member.accessor))
      block(allocation, allocation, 'descriptor')
  }
  const mutationKeysOf = (mutation: CallableWriteTarget): readonly string[] | null =>
    mutation.key !== null
      ? [mutation.key]
      : mutation.operation.family === 'property' && mutation.operation.provenKeyTexts?.length
        ? mutation.operation.provenKeyTexts
        : null
  for (const mutation of mutations) {
    const targets = new Set<NativeObjectDataAllocation>(aliasesOf(mutation.target) ?? [])
    const keys = mutationKeysOf(mutation)
    if (
      mutation.copiedSlot !== undefined &&
      mutation.operation.family === 'invocation' &&
      mutation.operation.intrinsicMutation === 'object-assign' &&
      mutation.operation.nativeOwnAssignment
    ) {
      const fact = mutation.operation.nativeOwnAssignment
      for (const root of fact.targetSlots) {
        if (!fact.targets.includes(root.allocation) || !root.slots.some((slot) => keys?.includes(slot.key))) continue
        const allocation = origins.get(root.allocation)
        if (allocation) targets.add(allocation)
      }
    }
    for (const key of keys ?? [])
      for (const [allocation, slots] of closedSlotWriters) if (slots.get(key)?.has(mutation.operation.id)) targets.add(allocation)
    for (const allocation of targets) {
      if (keys === null) {
        block(allocation, mutation.operation, 'unknown-key')
        continue
      }
      // A complete ordinary data-source closure accounts removal as a
      // descriptor absence, separately from its actual stored payloads.
      if (closedDataDeletionOf(allocation, mutation.operation)) continue
      const slots = writers.get(allocation) ?? new Map()
      for (const key of new Set(keys)) {
        const rows = slots.get(key) ?? []
        rows.push({ mutation: { ...mutation, key }, value: mutation.value === null ? null : actualValue(mutation.value) })
        slots.set(key, rows)
        if (key === '__proto__') block(allocation, mutation.operation, 'prototype')
      }
      writers.set(allocation, slots)
      if (!['set', 'reflect-set', 'define-own-property'].includes(mutation.kind) && mutation.copiedSlot === undefined)
        block(allocation, mutation.operation, 'descriptor')
    }
  }
  // An object spread defines each statically known source key on the literal
  // it builds, by CreateDataProperty: a writer of that slot as surely as
  // `o.k = v`. Whether the key lands in a layout field or beside the layout
  // is the carrier's answer, which every consumer asks first; the literal's
  // semantic type names the spread keys either way, so it cannot decide.
  // The receiver operand is provenance (the literal itself), so the alias
  // walk below never sees it; the copy is accounted here instead.
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'protocol' || operation.protocol !== 'spread' || operation.spreadKeys === undefined) continue
    const receiver = operandOf(operation, 'receiver')
    const source = operandOf(operation, 'source')
    const allocation = receiver?.source.kind === 'result' ? origins.get(receiver.source.result) : undefined
    if (!receiver || !source || allocation?.family !== 'allocation') continue
    const overwritten = new Set(operation.overwrittenKeys ?? [])
    const slots = writers.get(allocation) ?? new Map()
    for (const key of new Set(operation.spreadKeys)) {
      if (overwritten.has(key)) continue
      const rows = slots.get(key) ?? []
      rows.push({
        mutation: {
          result: null,
          name: key,
          key,
          operation,
          lookupTarget: null,
          target: receiver,
          value: null,
          produced: null,
          kind: 'define-own-property',
          resultContract: 'none'
        },
        value: null,
        spreadSource: source
      })
      slots.set(key, rows)
      if (key === '__proto__') block(allocation, operation, 'prototype')
    }
    writers.set(allocation, slots)
  }
  const ownKeysOf = (allocation: NativeObjectDataAllocation): ReadonlySet<string> => {
    const keys = new Set<string>(writers.get(allocation)?.keys() ?? [])
    const source = resultOf(allocation, 'value')
    for (const key of (source === undefined ? undefined : bulkStoredValues.get(source.id))?.keys() ?? []) keys.add(key)
    const body = allocation.family === 'allocation' ? recordObjectShapeOf(graph.structuralTypes, allocation.shape) : null
    const shape = body === null ? undefined : graph.structuralTypes.get(body)?.shape
    if (shape?.kind === 'object') for (const member of shape.members) if (member.key.kind !== 'symbol') keys.add(String(member.key.value))
    return keys
  }
  const classify = (operation: SemanticOperation, operand: SemanticOperand, allocation: NativeObjectDataAllocation): void => {
    if (operation.family === 'binding') {
      if (
        operation.external === undefined &&
        (cells.get(operation.declaration) === allocation || aliasCells.get(operation.declaration)?.has(allocation))
      )
        return
      block(allocation, operation, 'open-alias')
      return
    }
    // An exact call into a followed parameter, and a return out of a
    // closed function, hand the object to frames whose consumers this loop
    // classifies as well.
    if (operation.family === 'invocation' && operand.role === 'argument' && frames.parameterOf(operation, operand.ordinal) !== null) return
    if (
      operation.family === 'control' &&
      operation.form === 'return' &&
      operand.role === 'value' &&
      operation.caller.kind === 'function' &&
      frames.returnsTo(operation.caller.functionId) !== null
    )
      return
    if (operation.family === 'reference' && operation.form === 'identifier') return
    if (operation.family === 'reference' && operation.form === 'property' && operand === operandOf(operation, 'receiver')) return
    if (operation.family === 'property' && operand === operandOf(operation, 'receiver')) {
      const key = keyOf(operandOf(operation, 'key'))
      if (operation.internalMethod === 'get') {
        const keys = key === null ? operation.provenKeyTexts : [key]
        // A literal read through an `any` receiver (a duck-typing
        // `value.toJSON`-style probe) answers through the descriptor protocol too: it observes
        // whatever payload a store installed, whatever its key.
        const type = graph.structuralTypes.get(operand.type)?.shape
        if (operand.asserted !== true && type?.kind === 'primitive' && (type.primitive === 'any' || type.primitive === 'unknown'))
          observe(allocation, operation)
        // A get of a key known only at run time answers through the dynamic
        // property protocol; it reads a value and publishes no alias.
        if (!keys?.length) observe(allocation, operation)
        else {
          const slots = reads.get(allocation) ?? new Map()
          for (const key of new Set(keys)) {
            const rows = slots.get(key) ?? []
            rows.push(operation)
            slots.set(key, rows)
          }
          reads.set(allocation, slots)
        }
      } else if (
        !closedDataDeletionOf(allocation, operation) &&
        !['set', 'define-own-property', 'has-property', 'own-property-keys'].includes(operation.internalMethod)
      )
        block(allocation, operation, 'descriptor')
      return
    }
    // `o.k(...)` where no allocation `o` can hold owns `k` and the intact
    // Object.prototype lacks it: the callee is undefined and the call throws
    // before any code receives `o` as its this value.
    if (operation.family === 'invocation' && operand.role === 'receiver' && operand.source.kind === 'result') {
      const callee = operandOf(operation, 'callee')
      const producer =
        callee?.source.kind === 'result' ? graph.operations.get(graph.results.get(callee.source.result) ?? ('' as OperationId)) : undefined
      const lookup = producer?.family === 'property' && producer.internalMethod === 'get' ? operandOf(producer, 'receiver') : undefined
      const key = producer?.family === 'property' ? keyOf(operandOf(producer, 'key')) : null
      if (
        key !== null &&
        producer?.family === 'property' &&
        producer.ordinaryObjectPrototypeKeyAbsent === true &&
        lookup?.source.kind === 'result' &&
        lookup.source.result === operand.source.result &&
        complete.has(operand.source.result) &&
        [...(aliasesOf(operand) ?? [])].every((held) => !ownKeysOf(held).has(key))
      )
        return
    }
    // CopyDataProperties reads each own enumerable value into the new
    // literal through the dynamic property protocol; the source itself is
    // published nowhere.
    if (operation.family === 'protocol' && operation.protocol === 'spread') {
      observe(allocation, operation)
      return
    }
    if (
      operation.family === 'computation' &&
      (identityOperandOf(operation) === operand ||
        operation.form === 'typeof' ||
        (operation.form === 'equality' && ['===', '!=='].includes(operation.operator)))
    )
      return
    if (operation.family === 'invocation' && operand === operandOf(operation, 'argument', 0)) {
      if (operation.intrinsicOwnKeys || operation.intrinsicCarrierPredicate || operation.intrinsicReflection === 'has') return
      // Integrity operations change descriptor attributes, which every native
      // data store and definition re-checks; their identity result is its own
      // classified alias.
      if (operation.intrinsicIntegrity !== undefined) return
      const observation = operation.intrinsicObservation
      if (observation === 'isFrozen' || observation === 'isSealed' || observation === 'isExtensible') return
      if (observation === 'values' || observation === 'entries') {
        observe(allocation, operation)
        return
      }
      // A replacer function or an own toJSON would receive the object itself.
      const replacer = operandOf(operation, 'argument', 1)
      if (
        observation === 'stringify' &&
        (replacer === undefined || (replacer.source.kind === 'constant' && ['null', 'undefined'].includes(replacer.source.literal))) &&
        !ownKeysOf(allocation).has('toJSON')
      ) {
        observe(allocation, operation)
        return
      }
      if (operation.intrinsicMutation === 'reflect-set' && operation.operands.filter((one) => one.role === 'argument').length === 3) return
      if (operation.intrinsicReflection === 'get' && keyOf(operandOf(operation, 'argument', 1)) !== null) return
    }
    // The intact intrinsic reads a descriptor's exact own data fields. Its
    // target has a separate definition schema; passing the descriptor does
    // not expose that descriptor object to arbitrary source code.
    if (
      operation.family === 'invocation' &&
      operand === operandOf(operation, 'argument', 2) &&
      (operation.intrinsicDataDefinition === true ||
        (operand.source.kind === 'result' && operation.descriptorOwnProtocol?.descriptor === operand.source.result))
    )
      return
    block(allocation, operation, 'exposure')
  }
  for (const operation of graph.operations.values())
    for (const operand of operation.operands) {
      if (operand.evaluation.kind === 'provenance' && !(operation.family === 'invocation' && operand.role === 'receiver')) continue
      for (const allocation of aliasesOf(operand) ?? []) classify(operation, operand, allocation)
    }
  const schemas = new Map<OperationId, ReadonlyMap<string, NativeObjectDataSlotSchema>>()
  for (const allocation of allocations) {
    const result = resultOf(allocation, 'value')
    const stored = result === undefined ? undefined : bulkStoredValues.get(result.id)
    const keys = new Set([...(writers.get(allocation)?.keys() ?? []), ...(reads.get(allocation)?.keys() ?? []), ...(stored?.keys() ?? [])])
    schemas.set(
      allocation.id,
      new Map(
        [...keys].map((key) => [
          key,
          {
            allocation,
            key,
            writers: writers.get(allocation)?.get(key) ?? [],
            ...(stored?.has(key) === true ? { storedValues: stored.get(key)! } : {}),
            reads: reads.get(allocation)?.get(key) ?? [],
            blockers: blockers.get(allocation) ?? [],
            observers: observers.get(allocation) ?? []
          }
        ])
      )
    )
  }
  const namedDataDefinitions = new Map<OperationId, string>()
  for (const operation of graph.operations.values()) {
    if (
      operation.family !== 'invocation' ||
      operation.intrinsicDataDefinition !== true ||
      operation.intrinsicMutation !== 'object-define-property' ||
      operation.operands.filter((operand) => operand.role === 'argument').length !== 3
    )
      continue
    const source = operandOf(operation, 'argument', 1)?.source
    if (source?.kind !== 'constant' || source.literal !== 'string') continue
    const key = source.text
    if (objectPrototypeMemberNames.has(key) || key === '__proto__' || canonicalIndexLiteral(key) !== null) continue
    namedDataDefinitions.set(operation.id, key)
  }
  const census = { origins, aliases, complete, schemas, namedDataDefinitions }
  censuses.set(graph, census)
  return census
}
