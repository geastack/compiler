import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeCallableIdentityTransportMatches } from '../conversion/native-callable-adapter.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import type { DeclarationId, FunctionId, IrValueId, OperationId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import { abiOfCallee, deferredCalleeOf, type CalleeRenderingInput } from '../projection/callee.js'
import { classMemberOf } from '../projection/fields.js'
import { nativeCallableDataOwnerWriteProtocolOf } from '../projection/native-callable-data.js'
import {
  callableDataDefinitionDescriptorIsData,
  nativeCallableDataBlockersAdmit,
  type NativeCallableDataPlan,
  type NativeCallableDataStorage
} from '../representation/native-callable-data-storage.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { abiKey, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { refineCallableOwnDataCensus } from '../semantics/callable-own-data-slots.js'
import { callableOriginsOf, callableWriteTargetsOf } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { identityOperandOf, immutableBindingInitializerOf, operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { nativeCallableFlowOf, type NativeCallableFlow } from './callable-class-flow.js'
import { allOperationsOf, type CallCalleeIdentity, type IrBlock, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { resultOfIrOperation, successorsOfTerminator } from './queries.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import { closedCallFrameOf, nativeCallFrameOf } from './call-entry.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { intrinsicCallArgumentMatches, intrinsicCallFlagsMatch } from './intrinsic-call-facts.js'

/** Exact native source identities augment the canonical owner/writer census;
 * they do not grant an executable physical call frame or a stock-chain proof.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataOwnerInput {
  readonly graph: SemanticGraph
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly deriver: RepresentationDeriver
  readonly conversions: Pick<ConversionCensus, 'nodeById' | 'nodeFor'>
  readonly callableFlow: NativeCallableFlow
  readonly calleeRendering?: CalleeRenderingInput
  readonly nativeCallableData: NativeCallableDataPlan
}

/** @semanticCategory generic-primitive */
export interface NativeCallableDataOwnerAuthority {
  readonly protocolAt: (
    operation: IrOperation,
    semantic: SemanticOperation,
    receiver: IrOperand,
    key: IrOperand
  ) => 'absent' | 'builtin' | 'own-facts' | null
  /** All exact source owners agree on the current native writer carrier.
   * Object identity and successful dominating installation remain IR obligations. */
  readonly storageAt: (
    operation: IrOperation,
    semantic: SemanticOperation,
    receiver: IrOperand,
    key: IrOperand
  ) => { readonly owners: readonly FunctionId[]; readonly storage: NativeCallableDataStorage } | null
  /** No program Function can be the actual owner, the write names only keys
   * whose intact stock Function/Object chain an own-table [[Set]] answers
   * exactly, and no Set in the program may replace a Function's [[Prototype]].
   * Only a writer that keeps both the payload and receiver callbacks may use it. */
  readonly ownTableAt: (operation: IrOperation, semantic: SemanticOperation, receiver: IrOperand, key: IrOperand) => boolean
  /** A callback belongs to an actual dynamic observation, not the native
   * installation itself. Null leaves that future observation unproved. */
  readonly dynamicObservationAt: (
    operation: IrOperation,
    semantic: SemanticOperation,
    receiver: IrOperand,
    key: IrOperand
  ) => boolean | null
}

const cannotBeFunction = (value: Representation): boolean => {
  if (value.kind === 'optional') return cannotBeFunction(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => cannotBeFunction(arm.value))
  if (value.kind === 'borrowed-ref') return cannotBeFunction(value.referent)
  if (
    value.kind === 'dynamic' ||
    value.kind === 'unresolved' ||
    value.kind === 'proxy-object' ||
    (value.kind === 'native-handle' && (value.call !== null || value.construct !== null)) ||
    abiOfCallee(value) !== null
  )
    return false
  return true
}

const createOwnerAuthority = (
  input: NativeCallableDataOwnerInput,
  observedOperations?: ReadonlySet<OperationId>
): NativeCallableDataOwnerAuthority => {
  const flow = input.callableFlow
  const operations = [...input.bodies.values()].flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const producers = new Map<IrValueId, IrOperation>()
  const abis = new Map<FunctionId, CallableAbi>()
  const ambiguousAbis = new Set<FunctionId>()
  for (const body of input.bodies.values()) {
    if (!body.abi) continue
    const id = body.sourceOwner as FunctionId
    const previous = abis.get(id)
    if (previous && abiKey(previous) !== abiKey(body.abi)) ambiguousAbis.add(id)
    abis.set(id, body.abi)
  }
  for (const id of ambiguousAbis) abis.delete(id)
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result) producers.set(result.id, operation)
  }
  const semanticOf = (operation: IrOperation): SemanticOperation | undefined => {
    if (operation.lineage === null) return undefined
    const id = input.graph.results.get(operation.lineage)
    return id === undefined ? undefined : input.graph.operations.get(id)
  }
  const origins = new Map<SemanticResultId, readonly FunctionId[]>()
  const disjointTargets = new Set<OperationId>()
  const closedReturns = new Set<OperationId>()
  const closedInstallations = new Set<OperationId>()
  const actualOwners = new Map<IrValueId, readonly FunctionId[]>()
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    const sources = result === null ? undefined : flow.callableIdentityOrigins.get(result.id)
    if (result && sources !== undefined) {
      actualOwners.set(result.id, sources)
      if (operation.lineage !== null && input.graph.results.has(operation.lineage))
        origins.set(operation.lineage, [...new Set([...(origins.get(operation.lineage) ?? []), ...sources])])
    }
    const semantic = semanticOf(operation)
    if (semantic === undefined) continue
    if (flow.closedCallableReturns.has(operation)) closedReturns.add(semantic.id)
    const target =
      operation.kind === 'set' || operation.kind === 'define-own-property' || operation.kind === 'delete'
        ? operation.receiver
        : operation.kind === 'call' && semantic.family === 'invocation' && semantic.intrinsicMutation !== undefined
          ? operation.arguments[semantic.intrinsicMutation === 'reflect-set' && operation.arguments.length >= 4 ? 3 : 0]
          : undefined
    if (target !== undefined && cannotBeFunction(target.representation)) disjointTargets.add(semantic.id)
  }
  for (const semantic of input.graph.operations.values()) {
    if (semantic.family !== 'class-lifecycle' || semantic.event !== 'define-method') continue
    const method = operandOf(semantic, 'method')
    const key = operandOf(semantic, 'key')
    const source = method?.source.kind === 'result' ? callableOriginsOf(input.graph).get(method.source.result) : undefined
    const layout = input.classes.get(semantic.classDeclaration)
    if (source === undefined || key?.source.kind !== 'constant' || layout === undefined) continue
    const name = key.source.text
    const members = semantic.placement === 'static' ? layout.staticMethods : semantic.placement === 'prototype' ? layout.methods : []
    if (members.some((member) => member.key === name && member.callable === source)) closedInstallations.add(semantic.id)
  }
  const closedOperandTransfers = new Set<OperationId>()
  for (const operation of operations) {
    if (operation.kind !== 'call' || operation.argumentsAreSpread) continue
    const semantic = semanticOf(operation)
    const callee = semantic?.family === 'invocation' ? operandOf(semantic, 'callee') : undefined
    const actual = callableProducerOf(operation.callee)
    const source = actual === null ? undefined : semanticOf(actual)
    const authentic =
      actual?.kind === 'binding-read'
        ? source?.family === 'binding' && source.action === 'read' && source.declaration === actual.declaration
        : actual?.kind === 'allocate-callable' && source?.family === 'allocation' && source.callable === actual.functionId
    // The field-read target projection omits ordinary local callee reads.
    // Their complete original identities belong to the same source solver;
    // no signature, asserted target or failed identity query replaces them.
    // closedCallFrameOf still requires every actual source body's ABI to
    // agree with this executable entry and its native arguments/result.
    const identities = flow.callableIdentityOrigins.get(operation.callee.value)
    const entry: CallCalleeIdentity | undefined =
      flow.callables.get(operation.callee.value) ??
      (identities === undefined || identities.length === 0
        ? undefined
        : identities.length === 1
          ? { kind: 'exact', functionId: identities[0]! }
          : { kind: 'closed-family', functionIds: identities })
    if (
      semantic?.family !== 'invocation' ||
      callee?.source.kind !== 'result' ||
      actual?.lineage === null ||
      actual?.lineage === undefined ||
      !authentic ||
      !nativeCallableSourceAliasesOf(input.graph, callee.source.result).has(actual.lineage) ||
      semantic.operands.filter((operand) => operand.role === 'argument').length !== operation.arguments.length ||
      !operation.arguments.every((_, ordinal) =>
        intrinsicCallArgumentMatches(operation, semantic, ordinal, (id) => producers.get(id) ?? null)
      ) ||
      closedCallFrameOf(
        operation,
        entry,
        (id) => abis.get(id) ?? null,
        new Set(operation.result ? [operation.result.id] : []),
        input.conversions
      ) === undefined
    )
      continue
    closedOperandTransfers.add(semantic.id)
  }
  const census = refineCallableOwnDataCensus(input.nativeCallableData.census, input.graph, {
    origins,
    disjointTargets,
    closedReturns,
    closedInstallations,
    closedOperandTransfers,
    ...(observedOperations === undefined ? {} : { observedOperations })
  })
  const ordinarySources = new Set<FunctionId>()
  for (const owner of census.owners.values())
    if (
      owner.allocations.length > 0 &&
      owner.allocations.every(
        (allocation) => allocation.classConstructorBodyOf === undefined && allocation.ownPrototypeProperty !== undefined
      )
    )
      ordinarySources.add(owner.functionId)
  for (const layout of input.classes.values())
    for (const method of [...layout.methods, ...layout.staticMethods]) if (method.callable !== null) ordinarySources.add(method.callable)
  const protocolFor = (semantic: SemanticOperation, sources: readonly FunctionId[], key: IrOperand) => {
    const sourceKey = operandOf(semantic, semantic.family === 'property' ? 'key' : 'argument', semantic.family === 'property' ? 0 : 1)
    const text = sourceKey?.source.kind === 'constant' && sourceKey.source.literal === 'string' ? sourceKey.source.text : null
    const owners = sources.flatMap((source) => {
      const owner = census.owners.get(source)
      return owner === undefined ? [] : [owner]
    })
    if (owners.length !== sources.length || (key.representation.kind !== 'string' && key.representation.kind !== 'symbol')) return null
    return nativeCallableDataOwnerWriteProtocolOf(semantic, text, key.representation.kind === 'symbol', { owners, ordinarySources })
  }
  const sourcesOf = (receiver: IrOperand, semantic: SemanticOperation): readonly FunctionId[] => {
    const native = actualOwners.get(receiver.value)
    if (native !== undefined) return native
    const expected = operandOf(semantic, semantic.family === 'property' ? 'receiver' : 'argument', 0)
    const source = expected?.source.kind === 'result' ? callableOriginsOf(input.graph).get(expected.source.result) : undefined
    return source === undefined ? [] : [source]
  }
  const keyIdentityOf = (operand: SemanticOperand | undefined): SemanticOperand['source'] | null => {
    if (operand === undefined) return null
    const seen = new Set<SemanticResultId>()
    let source = operand.source
    while (source.kind === 'result') {
      if (seen.has(source.result)) return null
      seen.add(source.result)
      const id = input.graph.results.get(source.result)
      const producer = id === undefined ? undefined : input.graph.operations.get(id)
      const identity = producer && (identityOperandOf(producer) ?? immutableBindingInitializerOf(input.graph, producer))
      if (!identity) return source
      source = identity.source
    }
    return source.kind === 'constant' ? source : null
  }
  const sameKeyIdentity = (left: SemanticOperand | undefined, right: SemanticOperand | undefined): boolean => {
    const a = keyIdentityOf(left)
    const b = keyIdentityOf(right)
    return (
      a !== null &&
      b !== null &&
      a.kind === b.kind &&
      (a.kind === 'result' && b.kind === 'result'
        ? a.result === b.result
        : a.kind === 'constant' && b.kind === 'constant' && a.literal === b.literal && a.text === b.text)
    )
  }
  function callableProducerOf(operand: IrOperand): IrOperation | null {
    let actual = producers.get(operand.value)
    let held = operand
    const seen = new Set<IrValueId>()
    while (actual !== undefined) {
      const result = resultOfIrOperation(actual)
      if (
        result === null ||
        result.id !== held.value ||
        representationKey(result.representation) !== representationKey(held.representation) ||
        seen.has(result.id)
      )
        return null
      seen.add(result.id)
      if (actual.kind !== 'convert') return actual
      if (
        !nativeCallableIdentityTransportMatches(
          actual.source.representation,
          actual.result.representation,
          input.conversions.nodeById(actual.conversionUse)
        )
      )
        return null
      held = actual.source
      actual = producers.get(held.value)
    }
    return null
  }
  const builtinCalls = new Map<IrOperation, { readonly read: SemanticResultId; readonly source: SemanticResultId }>()
  if (input.calleeRendering)
    for (const operation of operations) {
      if (operation.kind !== 'call' || operation.argumentsAreSpread) continue
      const semantic = semanticOf(operation)
      if (semantic?.family !== 'invocation' || resultOf(semantic, 'value')?.id !== operation.lineage) continue
      const heldAbi = abiOfCallee(operation.callee.representation)
      const deferred = deferredCalleeOf(
        {
          graph: input.graph,
          plan: input.calleeRendering.plan,
          abis,
          constructs: new Map(),
          callableOrigins: callableOriginsOf(input.graph),
          classes: input.classes
        },
        semantic
      )
      if (
        !deferred ||
        deferred.member === 'bind' ||
        deferred.frame !== 'native' ||
        deferred.shadowGuard !== undefined ||
        operation.builtinShadowGuard !== undefined ||
        deferred.receiver.source.kind !== 'result' ||
        heldAbi === null ||
        abiKey(deferred.abi) !== abiKey(heldAbi) ||
        nativeCallFrameOf(operation, deferred.abi, new Set(operation.result ? [operation.result.id] : []), input.conversions) === undefined
      )
        continue
      const actual = callableProducerOf(operation.callee)
      const callee = operandOf(semantic, 'callee')
      if (
        actual?.lineage === null ||
        actual?.lineage === undefined ||
        !nativeCallableSourceAliasesOf(input.graph, deferred.receiver.source.result).has(actual.lineage) ||
        callee?.source.kind !== 'result'
      )
        continue
      builtinCalls.set(operation, { read: callee.source.result, source: deferred.receiver.source.result })
    }
  // The flow conservatively treats unmodeled Function property operations as
  // publication. Discharge only exact canonical native table operations and
  // source-authenticated stock calls with the actual native frame; a
  // container publication, opaque call or implicit entry remains a blocker.
  const nativeObservation = (operation: IrOperation, functionId: FunctionId): boolean => {
    const semantic = semanticOf(operation)
    if (operation.kind === 'call' && builtinCalls.has(operation))
      return actualOwners.get(operation.callee.value)?.includes(functionId) === true
    if (operation.kind === 'get' && operation.lineage !== null)
      for (const [call, { read, source }] of builtinCalls) {
        if (read !== operation.lineage || call.kind !== 'call' || !actualOwners.get(call.callee.value)?.includes(functionId)) continue
        const receiver = callableProducerOf(operation.receiver)
        const key = producers.get(operation.key.value)
        const expectedKey = semantic === undefined ? undefined : operandOf(semantic, 'key')
        if (
          receiver?.lineage !== null &&
          receiver?.lineage !== undefined &&
          nativeCallableSourceAliasesOf(input.graph, source).has(receiver.lineage) &&
          actualOwners.get(operation.receiver.value)?.includes(functionId) &&
          expectedKey?.source.kind === 'constant' &&
          expectedKey.source.literal === 'string' &&
          key?.kind === 'constant' &&
          key.literal === 'string' &&
          key.text === expectedKey.source.text
        )
          return true
      }
    // An ordinary `new F()` runs F's native construct frame; its body cannot
    // name F (new.target is not lowered). The instance's inherited
    // `constructor` remains an open dynamic observation (dynamicObservationAt),
    // and every write through it is an unknown-target census blocker.
    if (
      operation.kind === 'construct' &&
      operation.newTarget.value === operation.callee.value &&
      callableProducerOf(operation.callee) !== null &&
      actualOwners.get(operation.callee.value)?.includes(functionId) === true
    )
      return true
    // The stock descriptor query reads one own descriptor (its native value
    // through the payload callback dynamicObservationAt keeps); a stock data
    // definition is a census writer of its exact constant key.
    if (
      operation.kind === 'call' &&
      semantic?.family === 'invocation' &&
      !operation.argumentsAreSpread &&
      ((semantic.intrinsicReflection === 'getOwnPropertyDescriptor' &&
        operation.intrinsicReflection === 'getOwnPropertyDescriptor' &&
        operation.arguments.length === 2 &&
        intrinsicCallFlagsMatch(operation, semantic, input.calleeRendering, (id) => producers.get(id) ?? null)) ||
        (semantic.intrinsicMutation === 'object-define-property' &&
          semantic.intrinsicDataDefinition === true &&
          callableDataDefinitionDescriptorIsData(semantic) &&
          operation.arguments.length === 3)) &&
      operandOf(semantic, 'argument', 1)?.source.kind === 'constant' &&
      [0, 1].every((ordinal) => intrinsicCallArgumentMatches(operation, semantic, ordinal, (id) => producers.get(id) ?? null)) &&
      sourcesOf(operation.arguments[0]!, semantic).includes(functionId)
    )
      return true
    if (semantic?.family === 'invocation' && semantic.intrinsicIntegrity !== undefined && operation.kind === 'call')
      return operation.arguments[0] !== undefined && sourcesOf(operation.arguments[0], semantic).includes(functionId)
    const reflected =
      operation.kind === 'call' &&
      semantic?.family === 'invocation' &&
      operation.intrinsicReflection === semantic.intrinsicReflection &&
      (semantic.intrinsicReflection === 'get' ||
        semantic.intrinsicReflection === 'set' ||
        semantic.intrinsicReflection === 'deleteProperty') &&
      !operation.argumentsAreSpread &&
      operation.arguments.length === (semantic.intrinsicReflection === 'set' ? 3 : 2)
    if (semantic === undefined || (!reflected && semantic.family !== 'property')) return false
    if (!reflected && operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'delete') return false
    const receiver =
      reflected && operation.kind === 'call'
        ? operation.arguments[0]!
        : operation.kind === 'get' || operation.kind === 'set' || operation.kind === 'delete'
          ? operation.receiver
          : null
    const actualKey =
      reflected && operation.kind === 'call'
        ? operation.arguments[1]!
        : operation.kind === 'get' || operation.kind === 'set' || operation.kind === 'delete'
          ? operation.key
          : null
    if (receiver === null || actualKey === null) return false
    const sources = sourcesOf(receiver, semantic)
    if (!sources.includes(functionId)) return false
    if (reflected && operation.kind === 'call' && semantic.family === 'invocation' && semantic.intrinsicReflection === 'deleteProperty')
      return (
        intrinsicCallFlagsMatch(operation, semantic, input.calleeRendering, (id) => producers.get(id) ?? null) &&
        [0, 1].every((ordinal) => intrinsicCallArgumentMatches(operation, semantic, ordinal, (id) => producers.get(id) ?? null))
      )
    if (operation.kind === 'delete') {
      const expected = operandOf(semantic, 'receiver')
      const actual = callableProducerOf(operation.receiver)
      const expectedKey = operandOf(semantic, 'key')
      const actualKey = producers.get(operation.key.value)
      return (
        semantic.family === 'property' &&
        semantic.internalMethod === 'delete' &&
        expected?.source.kind === 'result' &&
        actual?.lineage !== null &&
        actual?.lineage !== undefined &&
        nativeCallableSourceAliasesOf(input.graph, expected.source.result).has(actual.lineage) &&
        (expectedKey?.source.kind === 'constant'
          ? actualKey?.kind === 'constant' && actualKey.literal === expectedKey.source.literal && actualKey.text === expectedKey.source.text
          : expectedKey?.source.kind === 'result' && actualKey?.lineage === expectedKey.source.result)
      )
    }
    if (operation.kind === 'set' || (reflected && operation.kind === 'call' && operation.intrinsicReflection === 'set'))
      return protocolFor(semantic, sources, actualKey) !== null
    const sourceKey = operandOf(semantic, semantic.family === 'property' ? 'key' : 'argument', semantic.family === 'property' ? 0 : 1)
    const key = sourceKey?.source.kind === 'constant' && sourceKey.source.literal === 'string' ? sourceKey.source.text : null
    if (key === 'name' || key === 'length') return true
    if (actualKey.representation.kind === 'symbol')
      return sources.every((source) => {
        const owner = census.owners.get(source)
        return (
          owner !== undefined &&
          owner.writes.some(({ operation: writer }) => {
            if (writer.family !== 'property' && writer.family !== 'invocation') return false
            if (writer.ordinaryCallableProgramSymbolDataWriteAbsent !== true) return false
            const writtenKey = operandOf(writer, writer.family === 'property' ? 'key' : 'argument', writer.family === 'property' ? 0 : 1)
            return sameKeyIdentity(sourceKey, writtenKey) && protocolFor(writer, sources, actualKey) !== null
          })
        )
      })
    if (key === null) return false
    return sources.every((source) => {
      const schema = census.schemas.get(source)?.get(key)
      return (
        schema !== undefined &&
        schema.writers.length > 0 &&
        schema.writers.every(({ mutation }) => {
          if (mutation.kind === 'delete' || mutation.kind === 'reflect-delete') return true
          return (
            (mutation.kind === 'set' ||
              mutation.kind === 'reflect-set' ||
              (mutation.kind === 'object-define-property' && callableDataDefinitionDescriptorIsData(mutation.operation))) &&
            protocolFor(mutation.operation, sources, actualKey) !== null
          )
        })
      )
    })
  }
  const protocolAt: NativeCallableDataOwnerAuthority['protocolAt'] = (operation, semantic, receiver, key) => {
    if (semanticOf(operation) !== semantic) return null
    const evaluated =
      operation.kind === 'set'
        ? [operation.receiver, operation.key]
        : operation.kind === 'call' && operation.arguments.length === 3 && !operation.argumentsAreSpread
          ? [operation.arguments[0], operation.arguments[1]]
          : []
    if (
      ![receiver, key].every(
        (operand, ordinal) =>
          evaluated[ordinal]?.value === operand.value &&
          representationKey(evaluated[ordinal]!.representation) === representationKey(operand.representation)
      )
    )
      return null
    const sources = sourcesOf(receiver, semantic)
    if (
      sources.some((source) =>
        [...(flow.callablePublications.get(source) ?? [])].some(
          (publication) => publication === null || !nativeObservation(publication, source)
        )
      )
    )
      return null
    return protocolFor(semantic, sources, key)
  }
  const storageAt: NativeCallableDataOwnerAuthority['storageAt'] = (operation, semantic, receiver, key) => {
    if (semanticOf(operation) !== semantic || (operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'call'))
      return null
    const evaluated =
      operation.kind === 'get' || operation.kind === 'set'
        ? [operation.receiver, operation.key]
        : !operation.argumentsAreSpread &&
            ((operation.intrinsicReflection === 'get' && operation.arguments.length === 2) ||
              (operation.intrinsicReflection === 'set' && operation.arguments.length === 3))
          ? operation.arguments.slice(0, 2)
          : []
    if (
      ![receiver, key].every(
        (operand, ordinal) =>
          evaluated[ordinal]?.value === operand.value &&
          representationKey(evaluated[ordinal]!.representation) === representationKey(operand.representation)
      )
    )
      return null
    const sourceKey = operandOf(semantic, semantic.family === 'property' ? 'key' : 'argument', semantic.family === 'property' ? 0 : 1)
    if (sourceKey?.source.kind !== 'constant' || sourceKey.source.literal !== 'string') return null
    const text = sourceKey.source.text
    const sources = sourcesOf(receiver, semantic)
    if (
      sources.length === 0 ||
      sources.some(
        (source) =>
          !ordinarySources.has(source) ||
          [...(flow.callablePublications.get(source) ?? [])].some(
            (publication) => publication === null || !nativeObservation(publication, source)
          )
      )
    )
      return null
    // The published writer carrier is the slot's one storage; this census
    // only re-decides whether its blockers admit an observed-presence read.
    const choices = sources.map((source) => {
      const schema = census.schemas.get(source)?.get(text)
      return schema === undefined || !nativeCallableDataBlockersAdmit(schema, schema.blockers, 'observed-presence')
        ? null
        : (input.nativeCallableData.storageOf(source, text) ?? input.nativeCallableData.storageOfSchema(schema)).observedPresence()
    })
    const storage = choices[0]
    if (
      !storage ||
      choices.some(
        (choice) =>
          choice === null ||
          representationKey(choice.storage) !== representationKey(storage.storage) ||
          choice.writers.length !== storage.writers.length ||
          choice.writers.some((writer, ordinal) => writer.writer.mutation.operation !== storage.writers[ordinal]!.writer.mutation.operation)
      ) ||
      storage.writers.some(({ writer }) => protocolFor(writer.mutation.operation, sources, key) === null)
    )
      return null
    return { owners: sources, storage }
  }
  const dynamicObservationAt: NativeCallableDataOwnerAuthority['dynamicObservationAt'] = (operation, semantic, receiver, key) => {
    if (protocolAt(operation, semantic, receiver, key) === null) return null
    const sources = sourcesOf(receiver, semantic)
    if (sources.length === 0) return null
    // An open observation may read any property. It is not discarded merely
    // because the known key's direct native reads are all typed. A
    // constructed instance reaches its constructor dynamically.
    if (
      sources.some((source) =>
        [...(flow.callablePublications.get(source) ?? [])].some(
          (publication) => publication === null || publication.kind === 'construct' || !nativeObservation(publication, source)
        )
      )
    )
      return true
    return operations.some((read) => {
      const source = semanticOf(read)
      if (source === undefined) return false
      const actualReceiver =
        read.kind === 'get'
          ? read.receiver
          : read.kind === 'call' &&
              source.family === 'invocation' &&
              (source.intrinsicReflection === 'get' || source.intrinsicReflection === 'getOwnPropertyDescriptor')
            ? read.arguments[0]
            : undefined
      if (actualReceiver === undefined || !sourcesOf(actualReceiver, source).some((owner) => sources.includes(owner))) return false
      const expectedKey = operandOf(source, source.family === 'property' ? 'key' : 'argument', source.family === 'property' ? 0 : 1)
      const writtenKey = operandOf(semantic, semantic.family === 'property' ? 'key' : 'argument', semantic.family === 'property' ? 0 : 1)
      const knownKey = keyIdentityOf(expectedKey)
      if (expectedKey === undefined || (knownKey?.kind === 'constant' && !sameKeyIdentity(expectedKey, writtenKey))) return false
      // Reflective descriptors expose their public `value` through the
      // ordinary dynamic descriptor contract. A typed Get reads the holder.
      return read.kind === 'call' && source.family === 'invocation' && source.intrinsicReflection === 'getOwnPropertyDescriptor'
        ? true
        : (read.kind === 'get' || read.kind === 'call') && read.result?.representation.kind === 'dynamic'
    })
  }
  // A [[Set]] (direct, Reflect.set or Object.assign's) of '__proto__' or of
  // an unknown key may run the inherited __proto__ setter on any target the
  // inventory cannot exclude from being a Function.
  const chainReplacement = callableWriteTargetsOf(input.graph).some(
    (write) =>
      (write.key === null || write.key === '__proto__') &&
      (write.kind === 'set' || write.kind === 'reflect-set' || write.kind === 'object-assign') &&
      !disjointTargets.has(write.operation.id)
  )
  const ownTableAt: NativeCallableDataOwnerAuthority['ownTableAt'] = (operation, semantic, receiver, key) =>
    !chainReplacement &&
    semanticOf(operation) === semantic &&
    semantic.family === 'property' &&
    semantic.internalMethod === 'set' &&
    semantic.ordinaryCallableStockChainWrite === true &&
    operation.kind === 'set' &&
    operation.receiver.value === receiver.value &&
    operation.key.value === key.value &&
    key.representation.kind === 'string' &&
    sourcesOf(receiver, semantic).length === 0
  if (observedOperations !== undefined) return { protocolAt, storageAt, ownTableAt, dynamicObservationAt }
  const snapshots = new Map<IrOperation, NativeCallableDataOwnerAuthority | null>()
  const constructionTopology = [...input.bodies.values()]
  const definitions = new Map<IrValueId, IrOperation>()
  const sites = new Map<IrOperation, { readonly body: IrBody; readonly block: IrBlock; readonly index: number }>()
  const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const [index, operation] of block.operations.entries()) {
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        sites.set(operation, { body, block, index })
        if (operation.kind === 'binding-write') {
          const held = writes.get(operation.declaration) ?? []
          held.push(operation)
          writes.set(operation.declaration, held)
        }
      }
  const snapshotAt = (operation: IrOperation, receiver: IrOperand): NativeCallableDataOwnerAuthority | null => {
    if (snapshots.has(operation)) return snapshots.get(operation)!
    snapshots.set(operation, null)
    const at = sites.get(operation)
    if (!at || at.body.abi !== null || at.body.tryRegions.length !== 0) return null
    // Other region bodies would require their actual entry order. Within this
    // body every possible predecessor effect must survive the snapshot;
    // beginning a joined block as if it were the entry would erase them.
    if ([...input.bodies.values()].some((body) => body !== at.body && body.abi === null)) return null
    const predecessors = new Map<IrBlock['id'], IrBlock[]>()
    for (const block of at.body.blocks.values())
      for (const successor of successorsOfTerminator(block.terminator)) {
        const earlier = predecessors.get(successor) ?? []
        earlier.push(block)
        predecessors.set(successor, earlier)
      }
    const retained = new Set<IrBlock['id']>()
    const visiting = new Set<IrBlock['id']>()
    const retain = (block: IrBlock): boolean => {
      if (visiting.has(block.id)) return false
      if (retained.has(block.id)) return true
      visiting.add(block.id)
      for (const predecessor of predecessors.get(block.id) ?? []) if (!retain(predecessor)) return false
      visiting.delete(block.id)
      retained.add(block.id)
      return true
    }
    // A loop may execute a later write before this observation on another
    // iteration. A finite acyclic prefix cannot certify that history.
    if (!retain(at.block) || !retained.has(at.body.entry)) return null
    const before = (value: IrValueId, use: IrOperation, callable: boolean, seen = new Set<IrValueId>()): IrOperation | null => {
      if (seen.has(value)) return null
      seen.add(value)
      const definition = definitions.get(value)
      const definedAt = definition && sites.get(definition)
      const usedAt = sites.get(use)
      if (
        !definition ||
        !definedAt ||
        !usedAt ||
        definedAt.body !== usedAt.body ||
        definedAt.block !== usedAt.block ||
        definedAt.index >= usedAt.index
      )
        return null
      if (definition.kind === 'convert') {
        const node = input.conversions.nodeById(definition.conversionUse)
        if (
          callable
            ? nativeCallableIdentityTransportMatches(definition.source.representation, definition.result.representation, node)
            : nativeClassReferenceTransportMatches(definition.source.representation, definition.result.representation, node)
        )
          return before(definition.source.value, definition, callable, seen)
        return null
      }
      if (definition.kind === 'binding-read') {
        if (!['local', 'region'].includes(input.placements.get(definition.declaration)?.storage.kind ?? '')) return null
        const stored = writes.get(definition.declaration)
        const writer = stored?.length === 1 ? stored[0] : undefined
        const storedAt = writer && sites.get(writer)
        return writer && storedAt?.block === usedAt.block && storedAt.index < definedAt.index
          ? before(writer.value.value, writer, callable, seen)
          : null
      }
      return definition
    }
    const bySource = new Map<FunctionId, IrBody | null>()
    for (const body of input.bodies.values()) {
      const id = body.sourceOwner as FunctionId
      bySource.set(id, bySource.has(id) ? null : body)
    }
    const producer = before(receiver.value, operation, true)
    let read = producer?.kind === 'get' ? producer : null
    let originalReceiver = read?.receiver ?? null
    let getterCall: Extract<IrOperation, { kind: 'call' }> | null = null
    let getterReturn: Extract<IrOperation, { kind: 'return' }> | null = null
    if (producer?.kind === 'call' && producer.closedCallee?.kind === 'exact') {
      const getter = bySource.get(producer.closedCallee.functionId)
      if (
        !getter?.abi ||
        getter.abi.receiver !== null ||
        getter.async ||
        getter.generator ||
        getter.blocks.size !== 1 ||
        getter.tryRegions.length !== 0 ||
        getter.facts === undefined ||
        getter.facts.capturedDeclarations.length !== 0 ||
        getter.facts.capturedReceiver
      )
        return null
      const block = getter.blocks.get(getter.entry)!
      if (block.terminator.kind !== 'return' || block.terminator.value === null) return null
      // A getter-shaped native body can return a method through its exact
      // argument frame. Other effects and returns require their own proof.
      if (
        !block.operations.every((item) => ['parameter', 'binding-read', 'binding-write', 'constant', 'get', 'convert'].includes(item.kind))
      )
        return null
      let value = block.terminator.value.value
      const seen = new Set<IrValueId>()
      while (!seen.has(value)) {
        seen.add(value)
        const source = definitions.get(value)
        if (source?.kind !== 'convert') {
          read = source?.kind === 'get' ? source : null
          break
        }
        if (
          !nativeCallableIdentityTransportMatches(
            source.source.representation,
            source.result.representation,
            input.conversions.nodeById(source.conversionUse)
          )
        )
          return null
        value = source.source.value
      }
      if (!read) return null
      value = read.receiver.value
      seen.clear()
      let ordinal: number | null = null
      while (!seen.has(value)) {
        seen.add(value)
        const source = definitions.get(value)
        if (source?.kind === 'parameter') {
          ordinal = source.ordinal
          break
        }
        if (source?.kind === 'convert') {
          if (
            !nativeClassReferenceTransportMatches(
              source.source.representation,
              source.result.representation,
              input.conversions.nodeById(source.conversionUse)
            )
          )
            return null
          value = source.source.value
          continue
        }
        if (source?.kind !== 'binding-read' || input.placements.get(source.declaration)?.storage.kind !== 'local') return null
        const stored = writes.get(source.declaration)
        const writer = stored?.length === 1 ? stored[0] : undefined
        const writerAt = writer && sites.get(writer)
        const readAt = sites.get(source)
        if (
          !writer ||
          writerAt?.body !== getter ||
          readAt?.body !== getter ||
          writerAt.block !== readAt.block ||
          writerAt.index >= readAt.index
        )
          return null
        value = writer.value.value
      }
      if (ordinal === null || producer.argumentsAreSpread) return null
      originalReceiver = producer.arguments[ordinal] ?? null
      getterCall = producer
      getterReturn = block.terminator
    }
    if (!read || !originalReceiver || read.receiver.representation.kind !== 'class-ref') return null
    const key = definitions.get(read.key.value)
    if (key?.kind !== 'constant' || key.literal !== 'string') return null
    const construction = before(originalReceiver.value, getterCall ?? read, false)
    if (construction?.kind !== 'construct') return null
    const branches = nativeClassConstructionOf(construction, input.classes, (id) => bySource.get(id), input.conversions)
    const member = branches?.length === 1 ? classMemberOf(input.classes, branches[0]!.declaration, key.text) : null
    if (
      branches?.length !== 1 ||
      (member?.kind !== 'method' &&
        !(
          member?.kind === 'field' &&
          input.classes.get(member.owner)?.fields.some((field) => field.key === key.text && field.initializer !== null)
        ))
    )
      return null
    const prefix: IrBody = {
      ...at.body,
      blocks: new Map(
        [...at.body.blocks.values()]
          .filter((block) => retained.has(block.id))
          .map((block): readonly [IrBlock['id'], IrBlock] => [
            block.id,
            block === at.block
              ? { ...block, operations: block.operations.slice(0, at.index), terminator: { kind: 'return', lineage: null, value: null } }
              : block
          ])
      ),
      blockOrder: at.body.blockOrder.filter((id) => retained.has(id)),
      tryRegions: []
    }
    const bodies = new Map(input.bodies)
    bodies.set(prefix.owner, prefix)
    const selected = nativeCallableFlowOf(
      [...bodies.values()],
      input.placements,
      input.classes,
      input.conversions,
      undefined,
      input.deriver,
      undefined,
      constructionTopology
    )
    if (!selected.callableIdentityOrigins.has(receiver.value)) return null
    if (getterCall) {
      const entry = selected.callables.get(getterCall.callee.value)
      if (
        entry?.kind !== 'exact' ||
        getterCall.closedCallee?.kind !== 'exact' ||
        entry.functionId !== getterCall.closedCallee.functionId ||
        getterReturn === null ||
        !selected.closedCallableReturns.has(getterReturn)
      )
        return null
    }
    const effects = new Set<OperationId>()
    // The queried writer has no native receipt yet. Letting its opaque
    // fallback open every callable entry would circularly destroy the source
    // this receipt proves. Every evaluated operand and preceding effect is
    // already in the prefix; the canonical writer still participates in the
    // same owner/prototype inventory and final SSA authentication.
    const writer = semanticOf(operation)
    if (writer === undefined) return null
    effects.add(writer.id)
    for (const body of bodies.values()) {
      if (!selected.enteredBodies.has(body.owner)) continue
      for (const block of body.blocks.values())
        for (const actual of allOperationsOf(block)) {
          const semantic = semanticOf(actual)
          if (semantic) effects.add(semantic.id)
        }
    }
    const authority = createOwnerAuthority({ ...input, bodies, callableFlow: selected }, effects)
    snapshots.set(operation, authority)
    return authority
  }
  return {
    protocolAt: (operation, semantic, receiver, key) =>
      protocolAt(operation, semantic, receiver, key) ??
      snapshotAt(operation, receiver)?.protocolAt(operation, semantic, receiver, key) ??
      null,
    storageAt: (operation, semantic, receiver, key) =>
      storageAt(operation, semantic, receiver, key) ??
      snapshotAt(operation, receiver)?.storageAt(operation, semantic, receiver, key) ??
      null,
    ownTableAt,
    // The full inventory owns future callback demand; a prefix proves only
    // the installation and cannot erase an observation after that prefix.
    dynamicObservationAt: (operation, semantic, receiver, key) => {
      if (protocolAt(operation, semantic, receiver, key) !== null) return dynamicObservationAt(operation, semantic, receiver, key)
      return snapshotAt(operation, receiver)?.protocolAt(operation, semantic, receiver, key) === null ? null : true
    }
  }
}

export const nativeCallableDataOwnerAuthorityOf = (input: NativeCallableDataOwnerInput): NativeCallableDataOwnerAuthority =>
  createOwnerAuthority(input)
