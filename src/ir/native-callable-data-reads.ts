import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { carriesUndefined, representationKey, walkRepresentation } from '../representation/model.js'
import { operandOf } from '../semantics/model/operands.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import { nativeCallableDataOwnerAuthorityOf } from './native-callable-data-owner.js'
import type { NativeCallableDataSlot, NativeCallableDataSlotInput } from './native-callable-data-slots.js'
import { nativeCallableDataWritesOf } from './native-callable-data-write.js'
import { resultOfIrOperation } from './queries.js'
import { nativeHostMethodReadMatches } from './intrinsic-call-facts.js'
import { nativeHostMethodReadProofsOf } from './native-host-method-reads.js'
import { nativeCallableIdentityTransportMatches } from '../conversion/native-callable-adapter.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { nonExpandoFunctionMemberNames } from './certify/property-access-keys.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import type { Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'

const declaredDynamicResult = (value: Representation): boolean =>
  (value.kind === 'dynamic' && value.reason === 'declared-any-never-narrowed') ||
  (value.kind === 'optional' && declaredDynamicResult(value.payload))

/** A typed sidecar observation cannot run a lazy declared-any materializer
 * and then decode its result. Stock Function/Object members have separate
 * entry/descriptor protocols; every other native Function read needs its
 * actual source-owned storage receipt, even when discovery is incomplete.
 * @semanticCategory generic-primitive
 */
export const nativeCallableTypedDataReadRequiresAuthority = (operation: IrOperation, key: string | null): boolean =>
  operation.kind === 'get' &&
  isNativeCallableCarrier(operation.receiver.representation.kind) &&
  (key === null || operation.nativeCallableUninstalledKey !== key) &&
  !declaredDynamicResult(operation.result.representation) &&
  (key === null ||
    (!['name', 'length', 'prototype'].includes(key) && !nonExpandoFunctionMemberNames.has(key) && !objectPrototypeMemberNames.has(key)))

const holdsNativeCallable = (value: Representation): boolean =>
  [...walkRepresentation(value)].some((carrier) => isNativeCallableCarrier(carrier.kind) || carrier.kind === 'callable-identity')

const installedKeyCensuses = new WeakMap<object, { readonly keys: ReadonlySet<string>; readonly unknown: boolean }>()

/** Every constant key some operation may install as own data on a native
 * Function, or `unknown` when a write's key (or a bulk definition's key set)
 * is not a constant. A write through a declared-any receiver crosses its own
 * dynamic boundary first and installs no typed native storage.
 * @semanticCategory generic-primitive
 */
export const nativeCallableInstalledKeysOf = (
  bodies: ReadonlyMap<unknown, IrBody>,
  graph: Pick<SemanticGraph, 'operations' | 'results'>
): { readonly keys: ReadonlySet<string>; readonly unknown: boolean } => {
  const cached = installedKeyCensuses.get(bodies)
  if (cached) return cached
  const keys = new Set<string>()
  let unknown = false
  for (const body of bodies.values()) {
    const constants = new Map<IrValueId, string>()
    const operations = [...body.blocks.values()].flatMap(allOperationsOf)
    for (const operation of operations)
      if (operation.kind === 'constant' && (operation.literal === 'string' || operation.literal === 'number'))
        constants.set(operation.result.id, operation.text)
    const install = (key: IrValueId | undefined): void => {
      const text = key === undefined ? undefined : constants.get(key)
      if (text === undefined) unknown = true
      else keys.add(text)
    }
    for (const operation of operations) {
      if ((operation.kind === 'set' || operation.kind === 'define-own-property') && holdsNativeCallable(operation.receiver.representation))
        install(operation.key.value)
      if (operation.kind !== 'call') continue
      const id = graph.results.get(operation.lineage)
      const semantic = id === undefined ? undefined : graph.operations.get(id)
      const mutation = semantic?.family === 'invocation' ? semantic.intrinsicMutation : undefined
      if (mutation === undefined && operation.intrinsicReflection !== 'set') continue
      const target = operation.arguments[0]
      if (!target || !holdsNativeCallable(target.representation)) continue
      if (
        !operation.argumentsAreSpread &&
        (mutation === 'object-define-property' || mutation === 'reflect-set' || operation.intrinsicReflection === 'set')
      )
        install(operation.arguments[1]?.value)
      else unknown = true
    }
  }
  const census = { keys, unknown }
  installedKeyCensuses.set(bodies, census)
  return census
}

/** The read's constant key when no program operation can install it as own
 * data on a native Function: only absence or a declared-any write can be
 * observed, so the ordinary checked dynamic lookup is its native protocol.
 * Publication and certification share this one recomputed census.
 * @semanticCategory generic-primitive
 */
export const nativeCallableUninstalledKeyOf = (
  operation: IrOperation,
  key: string | null,
  bodies: ReadonlyMap<unknown, IrBody>,
  graph: Pick<SemanticGraph, 'operations' | 'results'>
): string | null => {
  if (operation.kind !== 'get' || operation.nativeCallableDataSlot !== undefined || key === null) return null
  const { nativeCallableUninstalledKey: _claimed, ...unclaimed } = operation
  if (!nativeCallableTypedDataReadRequiresAuthority(unclaimed, key)) return null
  const installed = nativeCallableInstalledKeysOf(bodies, graph)
  return installed.unknown || installed.keys.has(key) ? null : key
}

/** The existing slot discovery's exact allocation aliases are replayed here,
 * rather than inferring an owner from a signature or a source FunctionId.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableReadPositions {
  readonly rootOf: (value: IrValueId) => IrValueId | null
  readonly aliasesOf: (origin: SemanticResultId) => ReadonlySet<SemanticResultId>
  readonly positions: ReadonlyMap<IrOperation, { readonly block: object; readonly index: number }>
}

/** An optional read observes actual own-property presence. The common source
 * writer domain cannot prove that another allocation of the same source Fn
 * owns the key; its missing-property result remains undefined.
 */
export const nativeCallableOptionalDataReadsOf = (
  input: NativeCallableDataSlotInput,
  aliases?: NativeCallableReadPositions
): ReadonlyMap<IrOperation, NativeCallableDataSlot> => {
  const result = new Map<IrOperation, NativeCallableDataSlot>()
  const operations = [...input.bodies.values()].flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  if (!operations.some((operation) => operation.kind === 'get' && isNativeCallableCarrier(operation.receiver.representation.kind)))
    return result
  const definitions = new Map<IrValueId, IrOperation>()
  const byLineage = new Map<SemanticResultId, IrOperation | null>()
  const writes = nativeCallableDataWritesOf(input)
  for (const operation of operations) {
    const value = resultOfIrOperation(operation)
    if (value !== null) definitions.set(value.id, operation)
    // Inline keys and conversion temporaries share the write's lineage. Only
    // authenticated actual Set/Reflect.set operations can install the slot.
    if (operation.lineage !== null && writes.has(operation))
      byLineage.set(operation.lineage, byLineage.has(operation.lineage) ? null : operation)
  }
  const owners = nativeCallableDataOwnerAuthorityOf(input)
  const hostReads = new Map([...input.bodies.values()].flatMap((body) => [...nativeHostMethodReadProofsOf(body, input.calleeRendering)]))
  for (const operation of operations) {
    if (operation.kind !== 'get' || !isNativeCallableCarrier(operation.receiver.representation.kind)) continue
    const key = definitions.get(operation.key.value)
    if (key?.kind !== 'constant' || key.literal !== 'string') continue
    const sourceId = input.graph.results.get(operation.lineage)
    const semantic = sourceId === undefined ? undefined : input.graph.operations.get(sourceId)
    const receiver = semantic && operandOf(semantic, 'receiver')
    if (semantic?.family !== 'property' || semantic.internalMethod !== 'get' || receiver?.source.kind !== 'result') continue
    const sourceKey = operandOf(semantic, 'key')
    if (sourceKey?.source.kind !== 'constant' || sourceKey.source.literal !== 'string' || sourceKey.source.text !== key.text) continue
    let actualReceiver = operation.receiver
    const receiverValues = new Set<IrValueId>()
    while (!receiverValues.has(actualReceiver.value)) {
      receiverValues.add(actualReceiver.value)
      const producer = definitions.get(actualReceiver.value)
      if (
        producer?.kind !== 'convert' ||
        !nativeCallableIdentityTransportMatches(
          producer.source.representation,
          producer.result.representation,
          input.conversions.nodeById(producer.conversionUse)
        )
      )
        break
      actualReceiver = producer.source
    }
    const receiverProducer = definitions.get(actualReceiver.value)
    const actualResult = receiverProducer && resultOfIrOperation(receiverProducer)
    if (
      !actualResult ||
      actualResult.id !== actualReceiver.value ||
      representationKey(actualResult.representation) !== representationKey(actualReceiver.representation) ||
      receiverProducer?.lineage === null ||
      receiverProducer?.lineage === undefined ||
      !nativeCallableSourceAliasesOf(input.graph, receiver.source.result).has(receiverProducer.lineage)
    )
      continue
    const held = owners.storageAt(operation, semantic, operation.receiver, operation.key)
    if (!held || held.storage.writers.length === 0) continue
    const installed = held.storage.writers.map(({ writer }) => {
      const installation = writer.mutation.operation.results.find((value) => value.role === 'value')
      const actual = installation && byLineage.get(installation.id)
      const write = actual && writes.get(actual)
      return { writer, installation, actual, write }
    })
    // A builtin such as `call` exists on Function.prototype even when no own
    // descriptor exists. Only the independently sealed absent-key protocol
    // can use undefined as this read's missing-property branch.
    if (installed.some(({ installation, actual, write }) => !write || write.prototypeProtocol !== 'absent' || !actual || !installation))
      continue
    const { writer, installation, write } = installed[0]!
    if (!write || !installation) continue
    const storage = held.storage.storage
    if (installed.some(({ write }) => !write || representationKey(write.storage) !== representationKey(storage))) continue
    const installations = installed.map(({ writer, installation, write }) => ({
      writer: writer.mutation.operation.id,
      installation: installation!.id,
      conversion: write!.storageConversion
    }))
    if (!carriesUndefined(operation.result.representation)) {
      const owner = aliases?.rootOf(operation.receiver.value)
      const at = aliases?.positions.get(operation)
      const allocation = owner === null || owner === undefined ? undefined : definitions.get(owner)
      const allocatedAt = allocation && aliases?.positions.get(allocation)
      if (
        !aliases ||
        allocation?.kind !== 'allocate-callable' ||
        !at ||
        !allocatedAt ||
        allocatedAt.block !== at.block ||
        !aliases.aliasesOf(receiver.source.result).has(allocation.lineage) ||
        !held.owners.includes(allocation.functionId)
      )
        continue
      const candidates = installed
        .filter(({ actual, write }) => {
          const before = actual && aliases.positions.get(actual)
          // A definition's holder is its descriptor's field, not an SSA value.
          return (
            actual &&
            write &&
            write.definition !== true &&
            aliases.rootOf(write.receiver.value) === owner &&
            before?.block === at.block &&
            allocatedAt.index < before.index &&
            before.index < at.index
          )
        })
        .sort((left, right) => aliases.positions.get(right.actual!)!.index - aliases.positions.get(left.actual!)!.index)
      const selected = candidates[0]
      if (!selected?.actual || !selected.write || !selected.installation) continue
      const installedAt = aliases.positions.get(selected.actual)!
      const pure = (actual: IrOperation): boolean => {
        if (['constant', 'parameter', 'binding-read', 'allocate-callable', 'allocate-record'].includes(actual.kind)) return true
        if (actual.kind === 'binding-write')
          return ['local', 'region'].includes(input.placements.get(actual.declaration)?.storage.kind ?? '')
        if (actual.kind === 'convert') {
          const node = input.conversions.nodeById(actual.conversionUse)
          return (
            node !== null &&
            representationKey(node.source) === representationKey(actual.source.representation) &&
            representationKey(node.target) === representationKey(actual.result.representation) &&
            recipeHasNormalResult(node, input.conversions.nodeById) &&
            recipePreservesNativePayload(node, input.conversions.nodeById) &&
            recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
          )
        }
        if (actual.kind !== 'get' || !actual.nativeHostMethodRead) return false
        return nativeHostMethodReadMatches(actual, hostReads.get(actual) ?? null)
      }
      // The full source-owned data schema rejects integrity/descriptor/escape
      // effects, so this absent-key Set installs on the actual fresh owner.
      // Only pure native transfers may retain presence from that write to
      // this read; a later delete or invocation is not a presence proof.
      if (
        operations.some((actual) => {
          const position = aliases.positions.get(actual)
          if (position?.block !== at.block || position.index <= installedAt.index || position.index >= at.index) return false
          return actual !== selected.actual && !pure(actual)
        })
      )
        continue
      const source = selected.write.storedValue
      const present = input.conversions.nodeFor(source.representation, operation.result.representation)
      if (
        !recipeHasNormalResult(present, input.conversions.nodeById) ||
        !recipePreservesNativePayload(present, input.conversions.nodeById) ||
        !recipeIsMaterializableWithoutPriorSourceGuard(present, input.conversions.nodeById)
      )
        continue
      result.set(operation, {
        owner: allocation.functionId,
        ownerSource: receiver.source.result,
        ownerAllocation: owner!,
        key: key.text,
        storage,
        installation: selected.installation.id,
        writer: selected.writer.mutation.operation.id,
        value: source,
        materialization: null,
        presentRead: { conversion: present.id, installations }
      })
      continue
    }
    const present = input.conversions.nodeFor(storage, operation.result.representation)
    const absent = input.conversions.nodeFor({ kind: 'undefined' }, operation.result.representation)
    if (
      (!nativePayloadTransportMatches(storage, operation.result.representation, present) &&
        !recipePreservesNativePayload(present, input.conversions.nodeById)) ||
      ![present, absent].every(
        (node) =>
          recipeHasNormalResult(node, input.conversions.nodeById) &&
          recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
      )
    )
      continue
    result.set(operation, {
      owner: held.owners[0]!,
      ownerSource: receiver.source.result,
      ownerAllocation: write.receiver.value,
      key: key.text,
      storage,
      installation: installation.id,
      writer: writer.mutation.operation.id,
      value: write.value,
      materialization: null,
      optionalRead: {
        owners: held.owners,
        present: present.id,
        absent: absent.id,
        installations
      }
    })
  }
  return result
}
