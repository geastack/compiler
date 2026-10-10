import type { FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { callableOriginsOf, callableWriteTargetsOf, functionPrototypeOriginsOf, type CallableWriteTarget } from './callable-origins.js'
import type { SemanticGraph } from './model/graph.js'
import { identityOperandOf, operandOf, type SemanticOperand, type SemanticResult } from './model/operands.js'
import type { AllocationOperation, SemanticOperation } from './model/operations.js'
import { propertyKeyTextOf } from './property-key.js'

/** Actual stored value authority, distinct from the destination or an assertion on its operand.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataValue {
  readonly operand: SemanticOperand
  readonly producer: SemanticOperation | null
  readonly result: SemanticResult | null
  readonly type: StructuralTypeId | null
  readonly callable: FunctionId | null
  readonly shape: StructuralTypeId | null
}

/** Every source writer remains present, including unsupported descriptor/copy/delete protocols.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataWriter {
  readonly mutation: CallableWriteTarget
  readonly value: CallableOwnDataValue | null
}

/** A source observation can demand dynamic materialization without changing native storage.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataObservation {
  readonly operation: SemanticOperation
  readonly target: SemanticOperand
  readonly key: string | null
  readonly kind: 'get' | 'has' | 'descriptor' | 'keys' | 'publication' | 'prototype' | 'identity' | 'typeof' | 'invocation-receiver'
  /** The canonical Get selecting this call's member; a FunctionId alone
   * cannot identify which allocation supplies the logical receiver. */
  readonly memberRead?: SemanticOperation
}

/** Unknown identities and protocols are obligations, never evidence that a slot is closed.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataBlocker {
  readonly operation: SemanticOperation
  readonly kind:
    | 'unknown-key'
    | 'delete'
    | 'opaque-definition'
    | 'opaque-source'
    | 'unknown-target'
    | 'prototype-mutation'
    | 'inherited-chain'
    | 'exposure'
    | 'integrity'
}

/** Storage for one exact source Function and key; all its allocations conservatively share the domain.
 * A schema alone proves neither successful installation nor a dominating read.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataSlotSchema {
  readonly functionId: FunctionId
  readonly key: string
  readonly allocations: readonly AllocationOperation[]
  readonly writers: readonly CallableOwnDataWriter[]
  readonly reads: readonly CallableOwnDataObservation[]
  readonly dynamicObservations: readonly CallableOwnDataObservation[]
  readonly blockers: readonly CallableOwnDataBlocker[]
}

/** One sealed inventory used by publication, projection and certification.
 * It is computed once and published with the representation plan
 * (`representation/native-callable-data-storage.ts`). An exact native
 * value-flow census may later re-decide only its blockers
 * (`refineCallableOwnDataCensus`); owners, writers and allocations stay these.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataSlotCensus {
  readonly owners: ReadonlyMap<FunctionId, CallableOwnDataOwner>
  readonly schemas: ReadonlyMap<FunctionId, ReadonlyMap<string, CallableOwnDataSlotSchema>>
  readonly unknownTargetWrites: readonly CallableWriteTarget[]
  readonly prototypeWrites: readonly CallableWriteTarget[]
}

/** Owner-wide mutation/publication obligations shared by every key, including
 * symbols whose actual identity is certified at the native write.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataOwner {
  readonly functionId: FunctionId
  readonly allocations: readonly AllocationOperation[]
  readonly writes: readonly CallableWriteTarget[]
  readonly observations: readonly CallableOwnDataObservation[]
  readonly blockers: readonly CallableOwnDataBlocker[]
}

/** Additional exact origin families from a sealed native value-flow census.
 * Consumers must recompute this input from actual SSA, never signatures. It
 * refines the published census (`refineCallableOwnDataCensus`) and never
 * re-decides a slot's published storage.
 * @semanticCategory generic-primitive
 */
export interface CallableOwnDataOriginInput {
  readonly origins: ReadonlyMap<SemanticResultId, readonly FunctionId[]>
  readonly closedReturns: ReadonlySet<OperationId>
  /** Actual evaluated native target carriers exclude Function identity. */
  readonly disjointTargets: ReadonlySet<OperationId>
  /** Exact class-layout method installations use a native descriptor, rather
   * than publishing the Function to an unknown object or setter. */
  readonly closedInstallations?: ReadonlySet<OperationId>
  /** Exact evaluated native entries account for argument transfer. Any
   * publication by their actual bodies remains a separate native obligation. */
  readonly closedOperandTransfers?: ReadonlySet<OperationId>
  /** An authenticated execution prefix limits effects, never allocation or
   * alias identity. Omitted means the complete program inventory. */
  readonly observedOperations?: ReadonlySet<OperationId>
}

const constantKey = (operand: SemanticOperand | undefined): string | null =>
  operand?.source.kind === 'constant' ? propertyKeyTextOf(operand.source.literal, operand.source.text) : null

/** Inventories only canonical graph objects. No checker spelling or parallel alias classifier is consulted. */
export const callableOwnDataSlotSchemasOf = (graph: SemanticGraph): CallableOwnDataSlotCensus => inventoryOf(graph, null)

const blockerKey = (blocker: CallableOwnDataBlocker): string => `${blocker.operation.id}:${blocker.kind}`

/** The published census refined by an exact native value flow. A native
 * origin can discharge a blocker the checker-level origins had to assume, can
 * add one they could not see, and can resolve a write whose target they could
 * not name. Storage is the one thing it cannot re-decide: a slot the published
 * census already holds keeps its published writers (the projection routed
 * storage from them), and a native writer that slot never saw keeps every
 * blocker either census names. An owner or slot the published census never
 * saw has no published storage to disagree with, so the native inventory is
 * its census. An execution prefix only omits writes it does not observe.
 */
export const refineCallableOwnDataCensus = (
  census: CallableOwnDataSlotCensus,
  graph: SemanticGraph,
  native: CallableOwnDataOriginInput
): CallableOwnDataSlotCensus => {
  const refined = inventoryOf(graph, native)
  const observed = native.observedOperations
  const covers = (base: readonly SemanticOperation[], actual: readonly SemanticOperation[]): boolean => {
    const seen = new Set(actual)
    return base.every((operation) => seen.has(operation) || observed?.has(operation.id) === false)
  }
  const unionOf = (
    base: readonly CallableOwnDataBlocker[],
    actual: readonly CallableOwnDataBlocker[]
  ): readonly CallableOwnDataBlocker[] => {
    const union = new Map(base.map((blocker) => [blockerKey(blocker), blocker] as const))
    for (const blocker of actual) if (!union.has(blockerKey(blocker))) union.set(blockerKey(blocker), blocker)
    return [...union.values()]
  }
  const owners = new Map(refined.owners)
  for (const [functionId, owner] of census.owners) {
    const actual = refined.owners.get(functionId)
    if (
      actual === undefined ||
      !covers(
        owner.writes.map((write) => write.operation),
        actual.writes.map((write) => write.operation)
      )
    )
      owners.set(functionId, { ...owner, blockers: unionOf(owner.blockers, actual?.blockers ?? []) })
  }
  const schemas = new Map(refined.schemas)
  for (const [functionId, keys] of census.schemas) {
    const perKey = new Map(refined.schemas.get(functionId) ?? [])
    for (const [key, schema] of keys) {
      const actual = refined.schemas.get(functionId)?.get(key)
      const writers = schema.writers.map((writer) => writer.mutation.operation)
      const actualWriters = actual?.writers.map((writer) => writer.mutation.operation) ?? []
      const same = actual !== undefined && covers(writers, actualWriters) && actualWriters.every((operation) => writers.includes(operation))
      perKey.set(key, { ...schema, blockers: same ? actual.blockers : unionOf(schema.blockers, actual?.blockers ?? []) })
    }
    schemas.set(functionId, perKey)
  }
  return { owners, schemas, unknownTargetWrites: refined.unknownTargetWrites, prototypeWrites: refined.prototypeWrites }
}

const inventoryOf = (graph: SemanticGraph, native: CallableOwnDataOriginInput | null): CallableOwnDataSlotCensus => {
  const origins = new Map<SemanticResultId, readonly FunctionId[]>([...callableOriginsOf(graph)].map(([id, source]) => [id, [source]]))
  for (const [id, sources] of native?.origins ?? [])
    if (graph.results.has(id) && sources.length > 0) origins.set(id, [...new Set([...(origins.get(id) ?? []), ...sources])])
  const sourcesOf = (id: SemanticResultId | null): readonly FunctionId[] => (id === null ? [] : (origins.get(id) ?? []))
  const prototypes = functionPrototypeOriginsOf(graph)
  const allocations = new Map<FunctionId, AllocationOperation[]>()
  for (const operation of graph.operations.values())
    if (operation.family === 'allocation' && operation.allocated === 'function-object' && operation.callable !== null) {
      const bucket = allocations.get(operation.callable) ?? []
      bucket.push(operation)
      allocations.set(operation.callable, bucket)
    }
  const actualValue = (operand: SemanticOperand): CallableOwnDataValue => {
    const source = operand.source
    if (source.kind === 'result') {
      const producerId = graph.results.get(source.result)
      const producer = producerId === undefined ? null : (graph.operations.get(producerId) ?? null)
      const result = producer?.results.find((value) => value.id === source.result) ?? null
      const sources = sourcesOf(source.result)
      const callable = sources.length === 1 ? sources[0]! : null
      const roots = callable === null ? [] : (allocations.get(callable) ?? [])
      const shape =
        producer?.family === 'allocation'
          ? producer.shape
          : roots.length > 0 && roots.every((root) => root.shape === roots[0]!.shape)
            ? roots[0]!.shape
            : null
      return { operand, producer, result, type: shape ?? result?.type ?? null, callable, shape }
    }
    if (source.kind === 'constant') {
      // A cast on a literal cannot turn a number into a class or a Function.
      const types = [...graph.structuralTypes.values()].filter(
        (type) => type.shape.kind === 'primitive' && type.shape.primitive === source.literal
      )
      return { operand, producer: null, result: null, type: types.length === 1 ? types[0]!.id : null, callable: null, shape: null }
    }
    return { operand, producer: null, result: null, type: null, callable: null, shape: null }
  }
  const writes = callableWriteTargetsOf(graph).filter((write) =>
    native?.observedOperations === undefined ? true : native.observedOperations.has(write.operation.id)
  )
  // The result of an object/array/RegExp/template literal allocation is never
  // a Function, so a write into it (an object literal's own property
  // definitions) cannot target any callable owner.
  const literalAllocation = (result: SemanticResultId | null): boolean => {
    const producerId = result === null ? undefined : graph.results.get(result)
    const producer = producerId === undefined ? undefined : graph.operations.get(producerId)
    return (
      producer?.family === 'allocation' &&
      (producer.allocated === 'object-literal' ||
        producer.allocated === 'array-literal' ||
        producer.allocated === 'regexp-object' ||
        producer.allocated === 'template-object')
    )
  }
  const unknownTargetWrites = writes.filter(
    (write) =>
      !native?.disjointTargets.has(write.operation.id) &&
      !literalAllocation(write.result) &&
      (write.result === null || (!prototypes.has(write.result) && !origins.has(write.result)))
  )
  const prototypeWrites = writes.filter((write) => write.result !== null && prototypes.has(write.result))
  // Membership and per-owner indexes over `writes`, so every owner and key
  // below visits only the writes that can block it, still in `writes` order
  // (blockers are recorded in that order). Scanning all writes with array
  // `includes` per owner and per key was quadratic in the write count.
  const unknownTargetWriteSet = new Set(unknownTargetWrites)
  const prototypeWriteSet = new Set(prototypeWrites)
  const ownWriteIndexes = new Map<FunctionId, number[]>()
  const sharedWriteIndexes: number[] = []
  writes.forEach((write, index) => {
    for (const functionId of sourcesOf(write.result)) {
      const bucket = ownWriteIndexes.get(functionId)
      if (bucket === undefined) ownWriteIndexes.set(functionId, [index])
      else if (bucket[bucket.length - 1] !== index) bucket.push(index)
    }
    if (unknownTargetWriteSet.has(write) || prototypeWriteSet.has(write) || write.key === '__proto__') sharedWriteIndexes.push(index)
  })
  const ownWriteSets = new Map<FunctionId, ReadonlySet<number>>()
  const ownsWrite = (functionId: FunctionId, index: number): boolean => {
    let set = ownWriteSets.get(functionId)
    if (set === undefined) ownWriteSets.set(functionId, (set = new Set(ownWriteIndexes.get(functionId) ?? [])))
    return set.has(index)
  }
  /** Every write that can add a blocker for this owner, in `writes` order. */
  const blockingWritesOf = (functionId: FunctionId): readonly number[] => {
    const own = ownWriteIndexes.get(functionId) ?? []
    const merged: number[] = []
    let a = 0
    let b = 0
    while (a < own.length || b < sharedWriteIndexes.length) {
      const next =
        b >= sharedWriteIndexes.length || (a < own.length && own[a]! <= sharedWriteIndexes[b]!) ? own[a++]! : sharedWriteIndexes[b++]!
      if (merged[merged.length - 1] !== next) merged.push(next)
    }
    return merged
  }
  // The writer values a `set`-like write into a callable origin stores; only
  // equality with an operand is asked of them below.
  const callableStoredValues = new Set<SemanticOperand>()
  for (const writer of writes)
    if (
      writer.value !== null &&
      writer.value !== undefined &&
      writer.result !== null &&
      origins.has(writer.result) &&
      (writer.kind === 'set' || writer.kind === 'define-own-property' || writer.kind === 'reflect-set')
    )
      callableStoredValues.add(writer.value)
  const owned = new Map<FunctionId, Map<string, CallableOwnDataWriter[]>>()
  for (const mutation of writes) {
    if (mutation.key === null || (mutation.result !== null && prototypes.has(mutation.result))) continue
    for (const functionId of sourcesOf(mutation.result)) {
      const keys = owned.get(functionId) ?? new Map<string, CallableOwnDataWriter[]>()
      const bucket = keys.get(mutation.key) ?? []
      const value = mutation.value ?? callableDataDefinitionValueOf(graph, mutation)
      bucket.push({ mutation, value: value === null ? null : actualValue(value) })
      keys.set(mutation.key, bucket)
      owned.set(functionId, keys)
    }
  }
  const observations = new Map<FunctionId, CallableOwnDataObservation[]>()
  const exposures = new Map<FunctionId, SemanticOperation[]>()
  const observe = (functionId: FunctionId, observation: CallableOwnDataObservation): void => {
    const bucket = observations.get(functionId) ?? []
    bucket.push(observation)
    observations.set(functionId, bucket)
  }
  for (const operation of graph.operations.values()) {
    if (native?.observedOperations !== undefined && !native.observedOperations.has(operation.id)) continue
    for (const target of operation.operands) {
      if (target.source.kind !== 'result' || target.evaluation.kind === 'provenance') continue
      for (const functionId of sourcesOf(target.source.result)) {
        if (operation.family === 'property' && target === operandOf(operation, 'receiver')) {
          if (
            operation.internalMethod === 'get' ||
            operation.internalMethod === 'has-property' ||
            operation.internalMethod === 'own-property-keys'
          )
            observe(functionId, {
              operation,
              target,
              key: constantKey(operandOf(operation, 'key')),
              kind:
                operation.internalMethod === 'own-property-keys'
                  ? 'keys'
                  : operation.internalMethod === 'has-property'
                    ? 'has'
                    : constantKey(operandOf(operation, 'key')) === 'prototype'
                      ? 'prototype'
                      : 'get'
            })
          continue
        }
        if (operation.family === 'invocation' && target === operandOf(operation, 'argument', 0)) {
          if (operation.intrinsicIntegrity !== undefined) {
            const bucket = exposures.get(functionId) ?? []
            if (!bucket.includes(operation)) bucket.push(operation)
            exposures.set(functionId, bucket)
            continue
          }
          if (
            operation.intrinsicReflection === 'get' ||
            operation.intrinsicReflection === 'has' ||
            operation.intrinsicReflection === 'getOwnPropertyDescriptor' ||
            operation.intrinsicOwnKeys
          ) {
            observe(functionId, {
              operation,
              target,
              key: constantKey(operandOf(operation, 'argument', 1)),
              kind: operation.intrinsicOwnKeys
                ? 'keys'
                : operation.intrinsicReflection === 'getOwnPropertyDescriptor'
                  ? 'descriptor'
                  : operation.intrinsicReflection === 'has'
                    ? 'has'
                    : 'get'
            })
            continue
          }
          if (operation.intrinsicMutation !== undefined || operation.intrinsicReflection === 'deleteProperty') continue
        }
        if (operation.family === 'binding' && operation.external === undefined) continue
        if (operation.family === 'reference') continue
        if (identityOperandOf(operation) === target) continue
        if (operation.family === 'control' && operation.form === 'return' && native?.closedReturns.has(operation.id)) continue
        if (
          operation.family === 'class-lifecycle' &&
          operation.event === 'define-method' &&
          target.role === 'method' &&
          native?.closedInstallations?.has(operation.id)
        )
          continue
        if (
          operation.family === 'computation' &&
          (operation.form === 'typeof' || (operation.form === 'equality' && (operation.operator === '===' || operation.operator === '!==')))
        ) {
          observe(functionId, { operation, target, key: null, kind: operation.form === 'typeof' ? 'typeof' : 'identity' })
          continue
        }
        if (callableStoredValues.has(target)) continue
        if (operation.family === 'invocation' && target === operandOf(operation, 'callee')) continue
        if (operation.family === 'invocation' && native?.closedOperandTransfers?.has(operation.id)) continue
        if (operation.family === 'invocation' && target === operandOf(operation, 'receiver')) {
          const callee = operandOf(operation, 'callee')
          const producerId = callee?.source.kind === 'result' ? graph.results.get(callee.source.result) : undefined
          const member = producerId === undefined ? undefined : graph.operations.get(producerId)
          const receiver = member?.family === 'property' && member.internalMethod === 'get' ? operandOf(member, 'receiver') : undefined
          const key = member?.family === 'property' ? constantKey(operandOf(member, 'key')) : null
          if (member && key !== null && receiver?.source.kind === 'result' && receiver.source.result === target.source.result) {
            observe(functionId, { operation, target, key, kind: 'invocation-receiver', memberRead: member })
            continue
          }
        }
        const bucket = exposures.get(functionId) ?? []
        if (!bucket.includes(operation)) bucket.push(operation)
        exposures.set(functionId, bucket)
        observe(functionId, { operation, target, key: null, kind: 'publication' })
      }
    }
  }
  const schemas = new Map<FunctionId, ReadonlyMap<string, CallableOwnDataSlotSchema>>()
  for (const [functionId, keys] of owned) {
    const perKey = new Map<string, CallableOwnDataSlotSchema>()
    const blockingWrites = blockingWritesOf(functionId)
    for (const [key, writers] of keys) {
      const blockers = new Map<string, CallableOwnDataBlocker>()
      const add = (operation: SemanticOperation, kind: CallableOwnDataBlocker['kind']): void => {
        blockers.set(`${operation.id}:${kind}`, { operation, kind })
      }
      for (const writer of writers) {
        if (writer.mutation.kind === 'delete' || writer.mutation.kind === 'reflect-delete') add(writer.mutation.operation, 'delete')
        else if (writer.value === null) add(writer.mutation.operation, 'opaque-definition')
        else if (writer.value.type === null) add(writer.mutation.operation, 'opaque-source')
      }
      for (const index of blockingWrites) {
        const write = writes[index]!
        const own = ownsWrite(functionId, index)
        if (own && write.key === null) add(write.operation, 'unknown-key')
        // [[Set]] may call the inherited __proto__ setter with this owner as
        // Receiver. An own data definition and deletion are different
        // protocols; neither changes [[Prototype]] merely by naming this key.
        // Without a prior own-descriptor receipt, all schemas for this owner
        // must retain the possible inherited-chain change, including writes
        // through an identity the inventory cannot isolate from this owner.
        if (
          write.key === '__proto__' &&
          (write.kind === 'set' || write.kind === 'reflect-set') &&
          (own || unknownTargetWriteSet.has(write))
        )
          add(write.operation, 'inherited-chain')
        if (write.key !== null && write.key !== key) continue
        if (unknownTargetWriteSet.has(write)) add(write.operation, 'unknown-target')
        if (prototypeWriteSet.has(write)) add(write.operation, 'prototype-mutation')
      }
      for (const operation of exposures.get(functionId) ?? [])
        add(operation, operation.family === 'invocation' && operation.intrinsicIntegrity !== undefined ? 'integrity' : 'exposure')
      for (const observed of observations.get(functionId) ?? []) if (observed.kind === 'prototype') add(observed.operation, 'exposure')
      const observed = observations.get(functionId) ?? []
      perKey.set(key, {
        functionId,
        key,
        allocations: allocations.get(functionId) ?? [],
        writers,
        reads: observed.filter((read) => read.kind === 'get' && read.key === key),
        dynamicObservations: observed.filter(
          (read) =>
            read.kind !== 'identity' &&
            read.kind !== 'typeof' &&
            (read.kind !== 'get' ||
              read.key === null ||
              read.operation.results.some((value) => {
                const shape = graph.structuralTypes.get(value.type)?.shape
                return shape?.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')
              }))
        ),
        blockers: [...blockers.values()]
      })
    }
    schemas.set(functionId, perKey)
  }
  const owners = new Map<FunctionId, CallableOwnDataOwner>()
  for (const functionId of new Set([...allocations.keys(), ...[...origins.values()].flat()])) {
    const blockers = new Map<string, CallableOwnDataBlocker>()
    const add = (operation: SemanticOperation, kind: CallableOwnDataBlocker['kind']): void => {
      blockers.set(`${operation.id}:${kind}`, { operation, kind })
    }
    for (const index of blockingWritesOf(functionId)) {
      const write = writes[index]!
      const own = ownsWrite(functionId, index)
      if (own && write.key === null) add(write.operation, 'unknown-key')
      if (unknownTargetWriteSet.has(write)) add(write.operation, 'unknown-target')
      if (prototypeWriteSet.has(write)) add(write.operation, 'prototype-mutation')
      if (write.key === '__proto__' && (write.kind === 'set' || write.kind === 'reflect-set') && (own || unknownTargetWriteSet.has(write)))
        add(write.operation, 'inherited-chain')
    }
    for (const operation of exposures.get(functionId) ?? [])
      add(operation, operation.family === 'invocation' && operation.intrinsicIntegrity !== undefined ? 'integrity' : 'exposure')
    for (const observation of observations.get(functionId) ?? [])
      if (observation.kind === 'prototype') add(observation.operation, 'exposure')
    owners.set(functionId, {
      functionId,
      allocations: allocations.get(functionId) ?? [],
      writes: (ownWriteIndexes.get(functionId) ?? []).map((index) => writes[index]!),
      observations: observations.get(functionId) ?? [],
      blockers: [...blockers.values()]
    })
  }
  return { owners, schemas, unknownTargetWrites, prototypeWrites }
}

const dataDescriptorNames = new Set(['value', 'writable', 'enumerable', 'configurable'])

/** The stored value of an Object.defineProperty whose descriptor is a fresh
 * object literal owning exactly data fields (its omitted fields discharged
 * against the intact prototype): that literal's own `value` initializer.
 * An accessor, copied or opaque descriptor has no such value.
 * @semanticCategory generic-primitive
 */
export const callableDataDefinitionValueOf = (graph: SemanticGraph, mutation: CallableWriteTarget): SemanticOperand | null => {
  const operation = mutation.operation
  if (mutation.kind !== 'object-define-property' || operation.family !== 'invocation') return null
  const protocol = operation.descriptorOwnProtocol
  if (
    protocol === undefined ||
    protocol.prototype !== 'ordinary-intact-absent' ||
    !protocol.ownNames.includes('value') ||
    !protocol.ownNames.every((name) => dataDescriptorNames.has(name))
  )
    return null
  let source: SemanticOperand['source'] = { kind: 'result', result: protocol.descriptor }
  const seen = new Set<SemanticResultId>()
  while (source.kind === 'result' && !seen.has(source.result)) {
    seen.add(source.result)
    const id = graph.results.get(source.result)
    const producer = id === undefined ? undefined : graph.operations.get(id)
    if (producer?.family === 'allocation') {
      if (producer.allocated !== 'object-literal') return null
      const literal = source.result
      const fields = callableWriteTargetsOf(graph).filter((write) => write.result === literal)
      const values = fields.filter((write) => write.key === 'value' && write.kind === 'define-own-property')
      // Every own field is a constant data-descriptor name defined once.
      return fields.length === protocol.ownNames.length &&
        fields.every((write) => write.kind === 'define-own-property' && write.key !== null && dataDescriptorNames.has(write.key)) &&
        values.length === 1
        ? values[0]!.value
        : null
    }
    const identity = producer === undefined ? undefined : identityOperandOf(producer)
    if (identity === undefined) return null
    source = identity.source
  }
  return null
}

/** Consumers authenticate the original writer row, not an equivalent signature or rebuilt result. */
export const callableOwnDataWriterAt = (census: CallableOwnDataSlotCensus, operation: OperationId): CallableOwnDataWriter | null => {
  for (const keys of census.schemas.values())
    for (const schema of keys.values()) for (const writer of schema.writers) if (writer.mutation.operation.id === operation) return writer
  return null
}
