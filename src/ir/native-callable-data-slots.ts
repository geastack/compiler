import { nativeCallableReadonlySetsOf } from './native-callable-readonly-set.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNodeId } from '../conversion/algebra.js'
import {
  nativeCallableDynamicIdentityTransportMatches,
  nativeCallableIdentityTransportMatches
} from '../conversion/native-callable-adapter.js'
import type { DeclarationId, FunctionId, IrValueId, OperationId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import { nativeCallableDataWriteProtocolOf, type NativeCallableDataPlan } from '../representation/native-callable-data-storage.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { abiOfCallee } from '../projection/callee.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { abiKey, representationKey, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { identityOperandOf, immutableBindingInitializerOf, operandOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import {
  allOperationsOf,
  type CallOperation,
  type GetOperation,
  type IrBody,
  type IrOperand,
  type IrOperation,
  type SetOperation
} from './model.js'
import { ordinaryFunctionStoreResultMatches } from './native-callable-own-property.js'
import { nativeCallableFlowOf, type NativeCallableFlow } from './callable-class-flow.js'
import type { ProgramConversionRecipe } from './program-conversions.js'
import { resultOfIrOperation } from './queries.js'
import { nativeCallableDataWritesOf } from './native-callable-data-write.js'
import { nativeCallableIntegrityAuthorityOf } from './native-callable-integrity.js'
import { nativeCallableOptionalDataReadsOf, nativeCallableUninstalledKeyOf } from './native-callable-data-reads.js'
import {
  nativeCallablePrototypeDescriptorsOf,
  nativeCallablePrototypeObservationsOf,
  nativeCallablePrototypeReadsOf
} from './native-callable-prototype.js'

/** An exact native data installation; the original Set/Get remain observable.
 * Storage, successful installation and future invocation frame are separately authenticated.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableDataSlot {
  readonly owner: FunctionId
  readonly ownerSource: SemanticResultId
  readonly ownerAllocation: IrValueId
  readonly key: string
  readonly storage: Representation
  readonly installation: SemanticResultId
  readonly writer: OperationId
  readonly value: IrOperand
  /** Executed only when an already-dynamic owner actually reads the data.
   * Typed Set and typed Get do not execute this primitive boundary recipe. */
  readonly materialization: ConversionNodeId | null
  /** A same-block installing write and an effect-free interval prove the
   * current data value. The held source retains its native identity. */
  readonly presentRead?: {
    readonly conversion: ConversionNodeId
    readonly installations: readonly {
      readonly writer: OperationId
      readonly installation: SemanticResultId
      readonly conversion: ConversionNodeId
    }[]
  }
  /** Optional reads observe the actual table instead of inventing installation
   * presence from a shared source FunctionId or an annotation. */
  readonly optionalRead?: {
    readonly owners: readonly FunctionId[]
    readonly present: ConversionNodeId
    readonly absent: ConversionNodeId
    readonly installations: readonly {
      readonly writer: OperationId
      readonly installation: SemanticResultId
      readonly conversion: ConversionNodeId
    }[]
  }
}

export interface NativeCallableDataSlotInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly graph: SemanticGraph
  readonly deriver: RepresentationDeriver
  readonly conversions: Pick<ConversionCensus, 'nodeById' | 'nodeFor'>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly calleeRendering?: CalleeRenderingInput
  /** The published callable own-data storage (`RepresentationPublication`). */
  readonly nativeCallableData: NativeCallableDataPlan
  /** The one native callable flow every receipt below is derived from. */
  readonly callableFlow: NativeCallableFlow
}

/** Publication computes the flow once, over exactly the bodies it rewrites
 * and the program recipes published so far (none before the first shake). */
export type PublishNativeCallableDataSlotsInput = Omit<NativeCallableDataSlotInput, 'callableFlow'> & {
  readonly programConversions: readonly ProgramConversionRecipe[] | null
}

type DataOperation = GetOperation | SetOperation | CallOperation
const semanticOf = (graph: SemanticGraph, lineage: SemanticResultId): SemanticOperation | null => {
  const id = graph.results.get(lineage)
  return id === undefined ? null : (graph.operations.get(id) ?? null)
}
const argumentsOf = (
  operation: DataOperation
): { readonly receiver: IrOperand; readonly key: IrOperand; readonly value: IrOperand | null } | null => {
  if (operation.kind !== 'call')
    return { receiver: operation.receiver, key: operation.key, value: operation.kind === 'set' ? operation.value : null }
  if (operation.intrinsicReflection !== 'get' && operation.intrinsicReflection !== 'set') return null
  const receiver = operation.arguments[0]
  const key = operation.arguments[1]
  if (!receiver || !key || operation.argumentsAreSpread || operation.arguments.length !== (operation.intrinsicReflection === 'get' ? 2 : 3))
    return null
  return { receiver, key, value: operation.intrinsicReflection === 'set' ? operation.arguments[2]! : null }
}

/** Discover from actual SSA aliases and dominating stores, never from public nil ABI or structural signature equality. */
export const nativeCallableDataSlotsOf = (input: NativeCallableDataSlotInput): ReadonlyMap<IrOperation, NativeCallableDataSlot> => {
  const definitions = new Map<IrValueId, IrOperation>()
  const positions = new Map<IrOperation, { readonly block: object; readonly index: number }>()
  const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
  const operations: IrOperation[] = []
  const semanticWrites = new Map<DeclarationId, Extract<SemanticOperation, { family: 'binding' }>[]>()
  for (const operation of input.graph.operations.values()) {
    if (operation.family !== 'binding' || (operation.action !== 'initialize' && operation.action !== 'write')) continue
    const rows = semanticWrites.get(operation.declaration) ?? []
    rows.push(operation)
    semanticWrites.set(operation.declaration, rows)
  }
  const aliasesOf = (origin: SemanticResultId): ReadonlySet<SemanticResultId> => {
    const aliases = new Set<SemanticResultId>()
    let current: SemanticResultId | null = origin
    while (current !== null && !aliases.has(current)) {
      aliases.add(current)
      const source = semanticOf(input.graph, current)
      if (source === null) break
      let identity = identityOperandOf(source) ?? immutableBindingInitializerOf(input.graph, source)
      if (identity === undefined && source.family === 'binding' && source.action === 'read' && source.external === undefined) {
        const writers = semanticWrites.get(source.declaration)
        const writer = writers?.length === 1 ? writers[0] : undefined
        if (writer?.external === undefined && writer) identity = operandOf(writer, writer.action === 'initialize' ? 'initializer' : 'value')
      }
      current = identity?.source.kind === 'result' ? identity.source.result : null
    }
    return aliases
  }
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const [index, operation] of allOperationsOf(block).entries()) {
        positions.set(operation, { block, index })
        operations.push(operation)
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        if (operation.kind === 'binding-write') {
          const bucket = writes.get(operation.declaration) ?? []
          bucket.push(operation)
          writes.set(operation.declaration, bucket)
        }
      }
  const roots = new Map<IrValueId, IrValueId | null>()
  const identityOf = (producer: Extract<IrOperation, { kind: 'convert' }>): boolean => {
    const node = input.conversions.nodeById(producer.conversionUse)
    const from = abiOfCallee(producer.source.representation)
    const to = abiOfCallee(producer.result.representation)
    return (
      nativeCallableIdentityTransportMatches(producer.source.representation, producer.result.representation, node) ||
      nativeCallableDynamicIdentityTransportMatches(producer.source.representation, producer.result.representation, node) ||
      (node?.capability.kind === 'identity' &&
        from !== null &&
        to !== null &&
        abiKey(from) === abiKey(to) &&
        representationKey(node.source) === representationKey(producer.source.representation) &&
        representationKey(node.target) === representationKey(producer.result.representation))
    )
  }
  const rootOf = (value: IrValueId): IrValueId | null => {
    if (roots.has(value)) return roots.get(value)!
    roots.set(value, null)
    const producer = definitions.get(value)
    let root: IrValueId | null = null
    if (producer?.kind === 'allocate-callable') root = producer.result.id
    else if (producer?.kind === 'convert' && identityOf(producer)) root = rootOf(producer.source.value)
    else if (
      producer?.kind === 'binding-read' &&
      ['local', 'region'].includes(input.placements.get(producer.declaration)?.storage.kind ?? '')
    ) {
      const semantic = semanticOf(input.graph, producer.lineage)
      if (semantic?.family !== 'binding' || semantic.action !== 'read' || semantic.declaration !== producer.declaration) return null
      const actual = writes.get(producer.declaration)
      const write = actual?.length === 1 ? actual[0] : undefined
      const at = positions.get(producer)
      const before = write === undefined ? undefined : positions.get(write)
      if (write && at && before && at.block === before.block && before.index < at.index) root = rootOf(write.value.value)
    } else if (producer?.kind === 'set' && ordinaryFunctionStoreResultMatches(producer, semanticOf(input.graph, producer.lineage)))
      root = rootOf(producer.receiver.value)
    roots.set(value, root)
    return root
  }
  const keyOf = (value: IrValueId): string | null => {
    const producer = definitions.get(value)
    if (producer?.kind === 'constant') return producer.literal === 'string' ? producer.text : null
    // A const binding read (after its TDZ) evaluates to its one initializer.
    if (producer?.kind !== 'binding-read') return null
    const semantic = semanticOf(input.graph, producer.lineage)
    const initializer = semantic === null ? undefined : immutableBindingInitializerOf(input.graph, semantic)
    return initializer?.source.kind === 'constant' && initializer.source.literal === 'string' ? initializer.source.text : null
  }
  const actualSourceOf = (value: IrValueId): IrOperation | null => {
    const seen = new Set<IrValueId>()
    while (!seen.has(value)) {
      seen.add(value)
      const producer = definitions.get(value)
      if (!producer) return null
      if (producer.kind !== 'convert') return producer
      const node = input.conversions.nodeById(producer.conversionUse)
      const numericTransport =
        producer.source.representation.kind === 'scalar' &&
        producer.result.representation.kind === 'scalar' &&
        node !== null &&
        representationKey(node.source) === representationKey(producer.source.representation) &&
        representationKey(node.target) === representationKey(producer.result.representation) &&
        (node.capability.kind === 'atom' || node.capability.kind === 'static') &&
        node.capability.materializer.requiresSourceGuard !== true
      if (node?.capability.kind !== 'identity' && !identityOf(producer) && !numericTransport) return producer
      value = producer.source.value
    }
    return null
  }
  const results = new Map<IrOperation, NativeCallableDataSlot>()
  for (const operation of operations) {
    if (operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'call') continue
    const semantic = semanticOf(input.graph, operation.lineage)
    const args = argumentsOf(operation)
    if (
      !semantic ||
      !args ||
      (!isNativeCallableCarrier(args.receiver.representation.kind) && args.receiver.representation.kind !== 'dynamic')
    )
      continue
    const key = keyOf(args.key.value)
    const storage = input.nativeCallableData.routeAt(semantic.id)
    if (key === null || storage === null || storage.schema.key !== key) continue
    const sourceReceiver = semantic.family === 'property' ? operandOf(semantic, 'receiver') : operandOf(semantic, 'argument', 0)
    if (sourceReceiver?.source.kind !== 'result') continue
    const ownerAllocation = rootOf(args.receiver.value)
    const owner = ownerAllocation === null ? undefined : definitions.get(ownerAllocation)
    if (
      owner?.kind !== 'allocate-callable' ||
      owner.functionId !== storage.schema.functionId ||
      !aliasesOf(sourceReceiver.source.result).has(owner.lineage)
    )
      continue
    const writer = storage.writers[0]!.writer
    const installation = operations.find(
      (candidate) =>
        (candidate.kind === 'set' || candidate.kind === 'call') &&
        semanticOf(input.graph, candidate.lineage)?.id === writer.mutation.operation.id
    ) as SetOperation | CallOperation | undefined
    if (!installation) continue
    const installed = argumentsOf(installation)
    const installedSemantic = semanticOf(input.graph, installation.lineage)
    if (
      !installed?.value ||
      !isNativeCallableCarrier(installed.receiver.representation.kind) ||
      !installedSemantic ||
      rootOf(installed.receiver.value) !== ownerAllocation ||
      keyOf(installed.key.value) !== key ||
      !nativeCallableDataWriteProtocolOf(installedSemantic, key) ||
      representationKey(installed.value.representation) !== representationKey(storage.storage)
    )
      continue
    if (installation.kind === 'set' && !ordinaryFunctionStoreResultMatches(installation, installedSemantic)) continue
    const position = positions.get(operation)!
    const installedPosition = positions.get(installation)!
    const ownerPosition = positions.get(owner)!
    if (
      position.block !== installedPosition.block ||
      ownerPosition.block !== installedPosition.block ||
      ownerPosition.index >= installedPosition.index ||
      position.index < installedPosition.index ||
      (args.value === null && position.index === installedPosition.index)
    )
      continue
    if (
      args.value === null &&
      operation.result !== null &&
      representationKey(operation.result?.representation ?? { kind: 'void' }) !== representationKey(storage.storage)
    )
      continue
    if (args.value !== null && operation !== installation) continue
    const value = installed.value
    const semanticValue = writer.value?.operand
    if (!semanticValue) continue
    const actualSource = actualSourceOf(value.value)
    if (!actualSource) continue
    if (writer.value?.callable !== null && writer.value?.callable !== undefined) {
      const sourceRoot = rootOf(value.value)
      const allocation = sourceRoot === null ? undefined : definitions.get(sourceRoot)
      if (
        allocation?.kind !== 'allocate-callable' ||
        allocation.functionId !== writer.value.callable ||
        (writer.value.operand.source.kind === 'result' && !aliasesOf(writer.value.operand.source.result).has(allocation.lineage))
      )
        continue
    }
    const sourcePosition = positions.get(actualSource)!
    if (sourcePosition.block !== installedPosition.block || sourcePosition.index >= installedPosition.index) continue
    if (semanticValue.source.kind === 'result') {
      if (!aliasesOf(semanticValue.source.result).has(actualSource.lineage!)) continue
    } else if (semanticValue.source.kind === 'constant') {
      if (
        actualSource.kind !== 'constant' ||
        actualSource.literal !== semanticValue.source.literal ||
        actualSource.text !== semanticValue.source.text
      )
        continue
    } else continue
    const hasDynamicRead = operations.some((read) => {
      if (read.kind !== 'get' && read.kind !== 'call') return false
      const readArgs = argumentsOf(read)
      const readSource = semanticOf(input.graph, read.lineage)
      if (
        !readArgs ||
        readArgs.value !== null ||
        readArgs.receiver.representation.kind !== 'dynamic' ||
        rootOf(readArgs.receiver.value) !== ownerAllocation ||
        !readSource
      )
        return false
      const readStorage = input.nativeCallableData.routeAt(readSource.id)
      return readStorage?.schema === storage.schema
    })
    let materialization: ConversionNodeId | null = null
    if (hasDynamicRead) {
      if (!['scalar', 'string', 'symbol', 'null', 'undefined'].includes(storage.storage.kind)) continue
      const node = input.conversions.nodeFor(storage.storage, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
      if (
        (node.capability.kind !== 'atom' && node.capability.kind !== 'static') ||
        node.capability.materializer.requiresSourceGuard === true
      )
        continue
      materialization = node.id
    }
    results.set(operation, {
      owner: storage.schema.functionId,
      ownerSource: sourceReceiver.source.result,
      ownerAllocation: ownerAllocation!,
      key,
      storage: storage.storage,
      installation: installation.lineage,
      writer: writer.mutation.operation.id,
      value,
      materialization
    })
  }
  for (const [operation, receipt] of nativeCallableOptionalDataReadsOf(input, { rootOf, positions, aliasesOf }))
    results.set(operation, receipt)
  return results
}

export const nativeCallableDataSlotMatches = (
  expected: NativeCallableDataSlot | undefined,
  actual: NativeCallableDataSlot | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  expected.owner === actual.owner &&
  expected.ownerSource === actual.ownerSource &&
  expected.ownerAllocation === actual.ownerAllocation &&
  expected.key === actual.key &&
  expected.installation === actual.installation &&
  expected.writer === actual.writer &&
  expected.materialization === actual.materialization &&
  (expected.presentRead === undefined
    ? actual.presentRead === undefined
    : actual.presentRead !== undefined &&
      expected.presentRead.conversion === actual.presentRead.conversion &&
      expected.presentRead.installations.length === actual.presentRead.installations.length &&
      expected.presentRead.installations.every((row, ordinal) => {
        const other = actual.presentRead!.installations[ordinal]!
        return row.writer === other.writer && row.installation === other.installation && row.conversion === other.conversion
      })) &&
  (expected.optionalRead === undefined
    ? actual.optionalRead === undefined
    : actual.optionalRead !== undefined &&
      expected.optionalRead.present === actual.optionalRead.present &&
      expected.optionalRead.absent === actual.optionalRead.absent &&
      expected.optionalRead.installations.length === actual.optionalRead.installations.length &&
      expected.optionalRead.installations.every((installation, ordinal) => {
        const other = actual.optionalRead!.installations[ordinal]!
        return (
          installation.writer === other.writer &&
          installation.installation === other.installation &&
          installation.conversion === other.conversion
        )
      }) &&
      expected.optionalRead.owners.length === actual.optionalRead.owners.length &&
      expected.optionalRead.owners.every((owner, ordinal) => owner === actual.optionalRead!.owners[ordinal])) &&
  expected.value.value === actual.value.value &&
  representationKey(expected.storage) === representationKey(actual.storage) &&
  representationKey(expected.value.representation) === representationKey(actual.value.representation)

/** Preserve original evaluation and descriptor mutation; receipts only select
 * native data storage and native reads. Publication is idempotent after rewrites.
 */
export const nativeCallableDataSlotInputOf = (published: PublishNativeCallableDataSlotsInput): NativeCallableDataSlotInput => {
  const { programConversions, ...rest } = published
  return {
    ...rest,
    callableFlow: nativeCallableFlowOf(
      [...rest.bodies.values()],
      rest.placements,
      rest.classes,
      rest.conversions,
      undefined,
      rest.deriver,
      programConversions ?? undefined
    )
  }
}

export const publishNativeCallableDataSlots = (published: PublishNativeCallableDataSlotsInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const input = nativeCallableDataSlotInputOf(published)
  const receipts = nativeCallableDataSlotsOf(input)
  const writes = nativeCallableDataWritesOf(input)
  const readonlySets = nativeCallableReadonlySetsOf(input)
  const integrity = nativeCallableIntegrityAuthorityOf(input).receipts
  const prototypes = nativeCallablePrototypeReadsOf(input).receipts
  const observations = nativeCallablePrototypeObservationsOf(input)
  const descriptors = nativeCallablePrototypeDescriptorsOf(input).receipts
  return new Map(
    [...input.bodies].map(([id, body]) => {
      const constants = new Map<IrValueId, IrOperation>()
      for (const block of body.blocks.values())
        for (const operation of block.operations) if (operation.kind === 'constant') constants.set(operation.result.id, operation)
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([key, block]) => [
              key,
              {
                ...block,
                operations: block.operations.map((operation) => {
                  if (operation.kind === 'convert') {
                    const { nativeCallablePrototypeObservation: _observation, ...current } = operation
                    const observation = observations.get(operation)
                    return observation === undefined ? current : { ...current, nativeCallablePrototypeObservation: observation }
                  }
                  if (operation.kind !== 'get' && operation.kind !== 'set' && operation.kind !== 'call') return operation
                  if (operation.kind === 'call') {
                    const { nativeCallableIntegrity: _integrity, nativeCallablePrototypeDescriptor: _descriptor, ...current } = operation
                    const descriptor = descriptors.get(operation)
                    if (descriptor) return { ...current, nativeCallablePrototypeDescriptor: descriptor }
                    const proof = integrity.get(operation)
                    if (proof) return { ...current, nativeCallableIntegrity: proof }
                    if (operation.nativeCallableIntegrity !== undefined || operation.nativeCallablePrototypeDescriptor !== undefined)
                      return current
                  }
                  if (operation.kind === 'set') {
                    const proof = readonlySets.get(operation)
                    if (proof !== undefined) {
                      const {
                        nativeCallableDataWrite: _write,
                        nativeCallableDataSlot: _slot,
                        nativeCallableReadonlySet: _readonly,
                        ...current
                      } = operation
                      return { ...current, nativeCallableReadonlySet: proof }
                    }
                  }
                  const { nativeCallableDataSlot: _previous, ...ordinarySlot } = operation
                  const ordinary =
                    operation.kind === 'get'
                      ? ordinarySlot
                      : (() => {
                          const { nativeCallableDataWrite: _write, ...rest } = operation
                          if (operation.kind === 'set') {
                            const { nativeCallableReadonlySet: _readonly, ...held } = rest as SetOperation
                            return held
                          }
                          return rest
                        })()
                  const receipt = receipts.get(operation)
                  if (receipt !== undefined) return { ...ordinary, nativeCallableDataSlot: receipt }
                  if (operation.kind === 'get') {
                    const {
                      nativeCallablePrototype: _prototype,
                      nativeCallableUninstalledKey: _uninstalled,
                      ...current
                    } = ordinary as GetOperation
                    const prototype = prototypes.get(operation)
                    if (prototype !== undefined) return { ...current, nativeCallablePrototype: prototype }
                    const keyProducer = constants.get(current.key.value)
                    const uninstalled = nativeCallableUninstalledKeyOf(
                      current,
                      keyProducer?.kind === 'constant' && keyProducer.literal === 'string' ? keyProducer.text : null,
                      input.bodies,
                      input.graph
                    )
                    return uninstalled === null ? current : { ...current, nativeCallableUninstalledKey: uninstalled }
                  }
                  const write = writes.get(operation)
                  return write === undefined ? ordinary : { ...ordinary, nativeCallableDataWrite: write }
                })
              }
            ])
          )
        }
      ] as const
    })
  )
}
