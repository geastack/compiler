import type { DeclarationId, FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from './derive.js'
import { representationKey, type Representation, type TaggedUnionArm } from './model.js'
import { isNativeCallableCarrier } from './callable-object.js'
import {
  callableOwnDataSlotSchemasOf,
  type CallableOwnDataBlocker,
  type CallableOwnDataSlotCensus,
  type CallableOwnDataSlotSchema,
  type CallableOwnDataValue,
  type CallableOwnDataWriter
} from '../semantics/callable-own-data-slots.js'
import { callableOriginsOf } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { identityOperandOf, immutableBindingInitializerOf, operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { propertyKeyTextOf } from '../semantics/property-key.js'

type StoredValueDeriver = Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'>

/** The carrier a stored value physically occupies. A stored Function keeps its
 * own physical frame: an asserted operand type cannot replace the ABI of the
 * function actually written. Null when that frame has no native convention.
 */
export const storedSourceValueOf = (
  deriver: StoredValueDeriver,
  source: { readonly callable: FunctionId | null; readonly type: StructuralTypeId }
): Representation | null => {
  if (source.callable === null) return deriver.deriveStored(source.type)
  const physical = deriver.nativeCallableConventions(source.callable)
  if (physical === null) return null
  return physical.construct === null
    ? { kind: 'function-value-dispatch', abi: physical.call }
    : { kind: 'function-and-constructor', call: physical.call, construct: physical.construct }
}

/** One native storage carrier authenticated by every actual writer, separately
 * from read presence, dominating installation and dynamic observation.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataStorage {
  readonly schema: CallableOwnDataSlotSchema
  readonly storage: Representation
  readonly writers: readonly { readonly writer: CallableOwnDataWriter; readonly source: Representation }[]
}

/** Which presence protocol a storage answer serves. Only a reader that
 * independently observes presence may use a slot some writer deletes.
 */
export type NativeCallableDataPresence = 'observed-presence' | 'installed-value'

export const nativeCallableDataValueRepresentationOf = (value: CallableOwnDataValue, deriver: StoredValueDeriver): Representation | null =>
  value.type === null ? null : storedSourceValueOf(deriver, { callable: value.callable, type: value.type })

/** A by-value object lacks the object identity a data descriptor must preserve.
 * The native holder copies primitives/callable ABI views or retains the actual
 * shared object; it does not manufacture identity by boxing a value copy.
 */
export const nativeCallableDataCarrierHasStorageIdentity = (value: Representation): boolean => {
  if (value.kind === 'optional') return nativeCallableDataCarrierHasStorageIdentity(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => nativeCallableDataCarrierHasStorageIdentity(arm.value))
  if (value.kind === 'string' || value.kind === 'scalar' || value.kind === 'symbol' || value.kind === 'null' || value.kind === 'undefined')
    return true
  if (value.kind === 'function-value-dispatch' || value.kind === 'function-and-constructor') return true
  return 'ownership' in value && value.ownership === 'shared-refcount'
}

const holdsCallable = (value: Representation): boolean =>
  isNativeCallableCarrier(value.kind) ||
  (value.kind === 'optional' && holdsCallable(value.payload)) ||
  (value.kind === 'tagged-union' && value.arms.some((arm) => holdsCallable(arm.value)))

/** A key-local union names only actual writer carriers. The IR still has to
 * cite a normal, payload-preserving conversion for every writer and read. */
const heldWriterCarrier = (writers: NativeCallableDataStorage['writers']): Representation | null => {
  const arms = new Map<string, TaggedUnionArm>()
  const add = (value: Representation, semanticType: StructuralTypeId): void => {
    if (value.kind === 'tagged-union') {
      for (const arm of value.arms) add(arm.value, arm.semanticType)
    } else if (value.kind === 'optional') {
      add(value.payload, semanticType)
      add({ kind: value.absence }, semanticType)
    } else {
      const key = representationKey(value)
      if (!arms.has(key)) arms.set(key, { tag: '', value, semanticType, runtimeDiscriminator: { kind: 'carrier' } })
    }
  }
  if (writers.every(({ source }) => representationKey(source) === representationKey(writers[0]!.source))) return writers[0]!.source
  // A callable's current entry is more than its C++ payload type. Different
  // callable writer frames need their separately authenticated adapter plan.
  if (writers.some(({ source }) => holdsCallable(source))) return null
  for (const { writer, source } of writers) {
    if (writer.value?.type == null) return null
    add(source, writer.value.type)
  }
  const ordered = [...arms]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, arm], ordinal) => ({ ...arm, tag: String(ordinal) }))
  return ordered.length === 1 ? ordered[0]!.value : { kind: 'tagged-union', arms: ordered }
}

const deletion = (writer: CallableOwnDataWriter): boolean => writer.mutation.kind === 'delete' || writer.mutation.kind === 'reflect-delete'

/** Whether one view of a schema's blockers admits its storage. Deletion
 * changes presence, never the family of stored payloads; only a reader which
 * independently observes or proves presence may use that family. The blocker
 * set is a view over the one published schema: refining it never changes the
 * schema's writers, so the published writer carrier stays the storage.
 */
export const nativeCallableDataBlockersAdmit = (
  schema: CallableOwnDataSlotSchema,
  blockers: readonly CallableOwnDataBlocker[],
  presence: NativeCallableDataPresence
): boolean =>
  blockers.every(
    (blocker) =>
      presence === 'observed-presence' &&
      blocker.kind === 'delete' &&
      schema.writers.some((writer) => deletion(writer) && writer.mutation.operation === blocker.operation)
  )

/** The writer carrier alone. This does not assert presence, successful
 * installation, an unblocked schema or permission to coerce a writer's value. */
const writerCarrierOf = (
  schema: CallableOwnDataSlotSchema,
  deriver: StoredValueDeriver,
  presence: NativeCallableDataPresence
): NativeCallableDataStorage | null => {
  if (schema.allocations.length === 0 || schema.writers.length === 0) return null
  const writers: NativeCallableDataStorage['writers'][number][] = []
  for (const writer of schema.writers) {
    if (presence === 'observed-presence' && deletion(writer) && writer.value === null) continue
    // A data definition stores its descriptor's value in the same holder; only
    // an observed-presence reader can use it, since it is not an installation.
    if (
      writer.value === null ||
      (writer.mutation.kind !== 'set' &&
        writer.mutation.kind !== 'reflect-set' &&
        !(presence === 'observed-presence' && writer.mutation.kind === 'object-define-property'))
    )
      return null
    const source = nativeCallableDataValueRepresentationOf(writer.value, deriver)
    if (source === null || !nativeCallableDataCarrierHasStorageIdentity(source)) return null
    writers.push({ writer, source })
  }
  if (writers.length === 0) return null
  const storage = heldWriterCarrier(writers)
  if (storage === null) return null
  return { schema, storage, writers }
}

/** A schema's storage under its own blockers: the writer carrier, admitted
 * only when every blocker the schema names is one this presence protocol
 * discharges. */
export const nativeCallableDataStorageOf = (
  schema: CallableOwnDataSlotSchema,
  deriver: StoredValueDeriver,
  presence: NativeCallableDataPresence = 'installed-value'
): NativeCallableDataStorage | null =>
  nativeCallableDataBlockersAdmit(schema, schema.blockers, presence) ? writerCarrierOf(schema, deriver, presence) : null

const dataDescriptorNames = new Set(['value', 'writable', 'enumerable', 'configurable'])

/** The define's exact own descriptor fields name a data descriptor with a value. */
export const callableDataDefinitionDescriptorIsData = (semantic: SemanticOperation): boolean =>
  semantic.family === 'invocation' &&
  semantic.descriptorOwnProtocol !== undefined &&
  semantic.descriptorOwnProtocol.prototype === 'ordinary-intact-absent' &&
  semantic.descriptorOwnProtocol.ownNames.includes('value') &&
  semantic.descriptorOwnProtocol.ownNames.every((name) => dataDescriptorNames.has(name))

/** The intact inherited descriptor is conditional on the actual receiver being
 * a fresh Function. It cannot establish that owner or successful installation.
 */
export const nativeCallableDataWriteProtocolOf = (semantic: SemanticOperation, key: string): boolean => {
  if (semantic.family === 'property' && semantic.internalMethod === 'set')
    return (
      semantic.ordinaryFunctionDataWrite === true ||
      semantic.ordinaryCallableDataWriteAbsent === true ||
      semantic.ordinaryCallableBuiltinDataWrite === key
    )
  if (semantic.family === 'invocation' && semantic.intrinsicMutation === 'reflect-set')
    return (
      semantic.operands.filter((operand) => operand.role === 'argument').length === 3 &&
      (semantic.ordinaryCallableDataWriteAbsent === true || semantic.ordinaryCallableBuiltinDataWrite === key)
    )
  // [[DefineOwnProperty]] consults no inherited descriptor; the chain fact
  // answers only an absent own key's later read.
  if (semantic.family === 'invocation' && semantic.intrinsicMutation === 'object-define-property')
    return (
      semantic.operands.filter((operand) => operand.role === 'argument').length === 3 &&
      semantic.ordinaryCallableDataWriteAbsent === true &&
      callableDataDefinitionDescriptorIsData(semantic)
    )
  return false
}

/** A key's canonical text: a constant, or a const binding (read after its
 * TDZ) whose one initializer is that constant. */
const constantKeyTextOf = (graph: SemanticGraph, key: SemanticOperand): string | null => {
  let source = key.source
  const seen = new Set<SemanticResultId>()
  while (source.kind === 'result' && !seen.has(source.result)) {
    seen.add(source.result)
    const id = graph.results.get(source.result)
    const producer = id === undefined ? undefined : graph.operations.get(id)
    const alias = producer === undefined ? undefined : (identityOperandOf(producer) ?? immutableBindingInitializerOf(graph, producer))
    if (alias === undefined) return null
    source = alias.source
  }
  return source.kind === 'constant' ? propertyKeyTextOf(source.literal, source.text) : null
}

/** Without a materializer an unknown-this body may observe only the Function's
 * existing primitive name/length facts. This does not infer irrelevance from
 * public ABI: it walks every actual incoming-this use in the source body.
 */
const receiverUsesOnlyNativeFunctionFacts = (graph: SemanticGraph, functionId: FunctionId, installedKey: string): boolean => {
  const operations = [...graph.operations.values()].filter(
    (operation) => operation.caller.kind === 'function' && operation.caller.functionId === functionId
  )
  const aliases = new Set<SemanticResultId>()
  for (const operation of operations)
    if (operation.family === 'reference' && operation.form === 'this') {
      const value = resultOf(operation, 'value')
      if (value) aliases.add(value.id)
    }
  let changed = true
  while (changed) {
    changed = false
    for (const operation of operations) {
      const source = identityOperandOf(operation)
      const value = resultOf(operation, 'value')
      if (source?.source.kind === 'result' && aliases.has(source.source.result) && value && !aliases.has(value.id)) {
        aliases.add(value.id)
        changed = true
      }
    }
  }
  for (const operation of operations)
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result' || !aliases.has(operand.source.result)) continue
      if (operation.family === 'binding' && identityOperandOf(operation) === operand && operation.external === undefined) continue
      if (
        operation.family === 'computation' &&
        (operation.form === 'typeof' || (operation.form === 'equality' && ['===', '!=='].includes(operation.operator)))
      )
        continue
      // A template substitution is ToString(this): OrdinaryToPrimitive reads
      // only @@toPrimitive, toString and valueOf, so it cannot observe any
      // other installed own slot.
      if (operation.family === 'computation' && operation.form === 'template' && installedKey !== 'toString' && installedKey !== 'valueOf')
        continue
      if (
        (operation.family === 'property' && operation.internalMethod === 'get') ||
        (operation.family === 'reference' && operation.form === 'property')
      ) {
        const receiver = operandOf(operation, 'receiver')
        const key = operandOf(operation, 'key')
        if (
          receiver === operand &&
          key?.source.kind === 'constant' &&
          key.source.literal === 'string' &&
          ['name', 'length'].includes(key.source.text)
        )
          continue
      }
      if (operation.family === 'reference' && operation.form === 'property' && operand === operandOf(operation, 'receiver')) {
        // Producing a Reference does not itself perform GetValue. Actual
        // reads/writes of that reference are checked as property operations.
        const key = operandOf(operation, 'key')
        if (key?.source.kind === 'constant' && key.source.literal === 'string' && key.source.text !== installedKey) continue
      }
      // An explicit any-this body may install unrelated declared-dynamic
      // data. It must not replace or dynamically read this native slot.
      if (operation.family === 'property' && operation.internalMethod === 'set' && operand === operandOf(operation, 'receiver')) {
        const key = operandOf(operation, 'key')
        if (key?.source.kind === 'constant' && key.source.literal === 'string' && key.source.text !== installedKey) continue
      }
      return false
    }
  return true
}

/** Both presence protocols' writer carriers for one source Function and key. */
export interface NativeCallableDataSchemaStorage {
  readonly schema: CallableOwnDataSlotSchema
  /** Gated by the published schema's own blockers: the projection storage. */
  readonly installedValue: () => NativeCallableDataStorage | null
  /** The writer carrier alone; a reader gates it with its own refined view of
   * this schema's blockers (`nativeCallableDataBlockersAdmit`). */
  readonly observedPresence: () => NativeCallableDataStorage | null
}

/** The sealed native own-data storage of every callable slot: one census, one
 * carrier per schema and presence protocol, one route per operation. Every
 * consumer -- publication, slot projection, lowering, receipts and the IR
 * owner authority -- reads these answers by id rather than recomputing them.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataPlan {
  readonly census: CallableOwnDataSlotCensus
  /** The schema an operation's exact owner and canonical constant key address. */
  readonly schemaAt: (operation: OperationId) => CallableOwnDataSlotSchema | null
  readonly storageOf: (functionId: FunctionId, key: string) => NativeCallableDataSchemaStorage | null
  /** The same carriers for a schema only a native refinement of the census
   * found (`refineCallableOwnDataCensus`); the projection routed none. */
  readonly storageOfSchema: (schema: CallableOwnDataSlotSchema) => NativeCallableDataSchemaStorage
  /** Shared route eligibility for publication, slot projection and receipt
   * discovery. Read presence/dominance remains a separate IR obligation. */
  readonly routeAt: (operation: OperationId) => NativeCallableDataStorage | null
  /** Actual own-data frames flow through immutable aliases and their calls. */
  readonly results: ReadonlyMap<SemanticResultId, Representation>
}

export const nativeCallableDataPlanOf = (graph: SemanticGraph, deriver: StoredValueDeriver): NativeCallableDataPlan => {
  const census = callableOwnDataSlotSchemasOf(graph)
  const origins = callableOriginsOf(graph)
  const storages = new Map<CallableOwnDataSlotSchema, NativeCallableDataSchemaStorage>()
  const storageOfSchema = (schema: CallableOwnDataSlotSchema): NativeCallableDataSchemaStorage => {
    const held = storages.get(schema)
    if (held !== undefined) return held
    let installed: NativeCallableDataStorage | null | undefined
    let observed: NativeCallableDataStorage | null | undefined
    const storage: NativeCallableDataSchemaStorage = {
      schema,
      installedValue: () => (installed !== undefined ? installed : (installed = nativeCallableDataStorageOf(schema, deriver))),
      observedPresence: () => (observed !== undefined ? observed : (observed = writerCarrierOf(schema, deriver, 'observed-presence')))
    }
    storages.set(schema, storage)
    return storage
  }
  const schemas = new Map<OperationId, CallableOwnDataSlotSchema | null>()
  /** Canonical result aliases name the same schema; lookup never trusts the
   * receiver's signature as evidence of which Function object owns the slot. */
  const schemaAt = (operationId: OperationId): CallableOwnDataSlotSchema | null => {
    const held = schemas.get(operationId)
    if (held !== undefined) return held
    const operation = graph.operations.get(operationId)
    const receiver =
      operation?.family === 'property'
        ? operandOf(operation, 'receiver')
        : operation?.family === 'invocation' && (operation.intrinsicMutation === 'reflect-set' || operation.intrinsicReflection === 'get')
          ? operandOf(operation, 'argument', 0)
          : undefined
    const key = operation?.family === 'property' ? operandOf(operation, 'key') : operation && operandOf(operation, 'argument', 1)
    const text = receiver?.source.kind === 'result' && key !== undefined ? constantKeyTextOf(graph, key) : null
    const functionId = text === null || receiver?.source.kind !== 'result' ? undefined : origins.get(receiver.source.result)
    const schema = (functionId === undefined || text === null ? undefined : census.schemas.get(functionId)?.get(text)) ?? null
    schemas.set(operationId, schema)
    return schema
  }
  const candidateAt = (operationId: OperationId): NativeCallableDataStorage | null => {
    const schema = schemaAt(operationId)
    const storage = schema === null ? null : storageOfSchema(schema).installedValue()
    if (storage === null || ['name', 'length', 'prototype', '__proto__'].includes(storage.schema.key) || storage.writers.length !== 1)
      return null
    // Callable-constructor identities have their own instance/prototype and
    // private-static receipt authority. A call-only data slot cannot replace
    // that domain's presence or initialization protocol.
    if (deriver.nativeCallableConventions(storage.schema.functionId)?.construct !== null) return null
    if (
      storage.schema.allocations.some(
        (allocation) => allocation.allocated !== 'function-object' || allocation.classConstructorBodyOf !== undefined
      )
    )
      return null
    if (
      storage.schema.dynamicObservations.some(
        (observation) =>
          !['keys', 'has', 'identity', 'typeof'].includes(observation.kind) &&
          !(observation.kind === 'get' && observation.key !== null) &&
          !(observation.kind === 'invocation-receiver' && observation.key === storage.schema.key && observation.memberRead !== undefined)
      )
    )
      return null
    for (const { writer, source } of storage.writers) {
      const abi = source.kind === 'function-value-dispatch' ? source.abi : source.kind === 'function-and-constructor' ? source.call : null
      if (
        abi?.receiver?.kind === 'dynamic' &&
        (writer.value?.callable === null ||
          writer.value?.callable === undefined ||
          !receiverUsesOnlyNativeFunctionFacts(graph, writer.value.callable, storage.schema.key))
      )
        return null
    }
    return storage
  }
  const routes = new Map<OperationId, NativeCallableDataStorage | null>()
  // A closed typed payload remains a native obligation when its inherited
  // descriptor proof is unavailable. Missing protocol facts cannot select the
  // older boxed installation path instead.
  const routeAt = (operationId: OperationId): NativeCallableDataStorage | null => {
    const held = routes.get(operationId)
    if (held !== undefined) return held
    const candidate = candidateAt(operationId)
    const route =
      candidate !== null &&
      candidate.writers.every(({ writer }) => nativeCallableDataWriteProtocolOf(writer.mutation.operation, candidate.schema.key))
        ? candidate
        : null
    routes.set(operationId, route)
    return route
  }
  return {
    census,
    schemaAt,
    storageOf: (functionId, key) => {
      const schema = census.schemas.get(functionId)?.get(key)
      return schema === undefined ? null : storageOfSchema(schema)
    },
    storageOfSchema,
    routeAt,
    results: nativeCallableDataResultsOf(graph, routeAt)
  }
}

/** Actual own-data frames flow through immutable aliases and their calls.
 * The checker can continue to describe Function.prototype.call after an own
 * replacement; neither that signature nor its result is the installed frame.
 * Presence and store ordering are deliberately authenticated later in IR.
 */
const nativeCallableDataResultsOf = (
  graph: SemanticGraph,
  routeAt: (operation: OperationId) => NativeCallableDataStorage | null
): ReadonlyMap<SemanticResultId, Representation> => {
  const values = new Map<SemanticResultId, Representation>()
  const absent = new Set<SemanticResultId>()
  const visiting = new Set<SemanticResultId>()
  const bindingWriters = new Map<DeclarationId, Extract<SemanticOperation, { family: 'binding' }>[]>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || (operation.action !== 'initialize' && operation.action !== 'write')) continue
    const writers = bindingWriters.get(operation.declaration) ?? []
    writers.push(operation)
    bindingWriters.set(operation.declaration, writers)
  }
  const visit = (id: SemanticResultId): Representation | null => {
    if (values.has(id)) return values.get(id)!
    if (absent.has(id)) return null
    if (visiting.has(id)) return null
    visiting.add(id)
    const operationId = graph.results.get(id)
    const operation = operationId === undefined ? undefined : graph.operations.get(operationId)
    let value: Representation | null = null
    if (operation?.family === 'property' && operation.internalMethod === 'get') value = routeAt(operation.id)?.storage ?? null
    else if (operation?.family === 'invocation') {
      if (operation.intrinsicReflection === 'get') value = routeAt(operation.id)?.storage ?? null
      else {
        const callee = operandOf(operation, 'callee')
        const held = callee?.source.kind === 'result' ? visit(callee.source.result) : null
        const result =
          held?.kind === 'function-value-dispatch'
            ? held.abi.result
            : held?.kind === 'function-and-constructor' && operation.internalMethod === 'call'
              ? held.call.result
              : null
        // The exact physical body may return no C++ payload. A JavaScript
        // observation of that call receives undefined, matching the source
        // frame's observed result rather than overriding it with bare void.
        value = result?.kind === 'void' ? { kind: 'undefined' } : result
      }
    } else if (operation?.family === 'binding' && operation.mutable) {
      // A cell's complete normalized writer domain owns ordinary results.
      // Retaining a physical callable frame additionally requires every real
      // writer to publish that same authenticated frame; an initializer alone
      // cannot replace the cell's union with its first value.
      const writers = bindingWriters.get(operation.declaration) ?? []
      if (writers.some((writer) => writer.action === 'initialize') && writers.every((writer) => writer.external === undefined)) {
        const frames = writers.map((writer) => {
          const source = operandOf(writer, writer.action === 'initialize' ? 'initializer' : 'value')
          return source?.source.kind === 'result' ? visit(source.source.result) : null
        })
        const frame = frames[0]
        if (
          frame &&
          isNativeCallableCarrier(frame.kind) &&
          frames.every((candidate) => candidate !== null && representationKey(candidate) === representationKey(frame))
        )
          value = frame
      }
    } else if (operation) {
      const source = identityOperandOf(operation) ?? immutableBindingInitializerOf(graph, operation)
      if (source?.source.kind === 'result') value = visit(source.source.result)
    }
    visiting.delete(id)
    if (value) values.set(id, value)
    else absent.add(id)
    return value
  }
  for (const id of graph.results.keys()) visit(id)
  return values
}
