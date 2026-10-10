import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeFieldViewIdentityTransportOf } from '../conversion/native-field-view.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import type { DeclarationId, IrValueId, OperationId, PhysicalBodyId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import {
  nativeObjectDataExtensionAt,
  nativeObjectDataExtensionSchemaAt,
  nativeObjectDataExtensionSchemaFor,
  nativeObjectDataStorageOf,
  nativeObjectDataTableStorageOf
} from '../projection/native-object-data.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf } from '../semantics/model/operands.js'
import { nativeObjectDataSlotSchemasOf, type NativeObjectDataSlotSchema } from '../semantics/native-object-data-slots.js'
import type { SemanticOperation } from '../semantics/model/operations.js'

type NativeObjectDataSlotSchemaWriter = NativeObjectDataSlotSchema['writers'][number]
import { recordObjectShapeOf } from '../representation/unwritten-record-members.js'
import { allOperationsOf, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/** Exact source allocation and native extension carrier. The public view's
 * field declaration never chooses storage; absence is a separate read lane.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectDataSlot {
  readonly allocation: OperationId
  /** Every allocation an aliased callee-frame receiver can hold; absent for one exact allocation. */
  readonly allocations?: readonly OperationId[]
  readonly owner: IrOperand
  readonly key: string
  readonly keyDomain?: readonly string[]
  /** Authenticated native origin projection of the actual selected alias. */
  readonly original?: Representation
  readonly storage: Representation
  readonly writers: readonly OperationId[]
  readonly read: readonly { readonly source: Representation; readonly conversion: ConversionNodeId }[]
  readonly write: { readonly value: IrOperand; readonly conversion: ConversionNodeId } | null
  /** The stored carrier's Value boundary, present exactly when an accounted
   * dynamic observer (an unknown-key get, an intact values/entries/stringify)
   * can read the descriptor this store installs. */
  readonly materialization?: ConversionNodeId
}

export interface NativeObjectDataSlotInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly graph: SemanticGraph
  readonly deriver: RepresentationDeriver
  readonly conversions: Pick<ConversionCensus, 'nodeById' | 'nodeFor'>
}

/** Required candidates and admitted receipts share the actual allocation
 * protocol. An indexed entry, owned copy or preallocated fixed optional slot
 * cannot become an extension merely because its literal omitted that key.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectDataSlotAuthority {
  readonly required: ReadonlySet<IrOperation>
  readonly receipts: ReadonlyMap<IrOperation, NativeObjectDataSlot>
}

const sharedRecord = (value: Representation): boolean =>
  (value.kind === 'record' || (value.kind === 'native-record-ref' && value.native === null)) && value.ownership === 'shared-refcount'

// Property lookup runs only on the present owner. The native selector still
// performs the nullish receiver throw; this predicate licenses no conversion
// of the absent arm and says nothing about stored undefined field values.
const projectedSharedRecord = (value: Representation): boolean =>
  sharedRecord(value) || (value.kind === 'optional' && sharedRecord(value.payload))

const observedDynamically: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

/** An observed store publishes its exact storage-to-Value recipe; an
 * unobserved one publishes none. `null` refuses the store. */
const materializationOf = (
  storage: Representation,
  observed: boolean,
  conversions: NativeObjectDataSlotInput['conversions']
): { readonly materialization?: ConversionNodeId } | null => {
  if (!observed) return {}
  const node = conversions.nodeFor(storage, observedDynamically)
  return recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById) ? { materialization: node.id } : null
}

/** The semantic schema accounts every alias consumer and writer. This second
 * proof authenticates its actual SSA allocation and evaluation order, including
 * conversions that retain the native source behind a live structural view.
 */
export const nativeObjectDataSlotAuthorityOf = (input: NativeObjectDataSlotInput): NativeObjectDataSlotAuthority => {
  const source = nativeObjectDataSlotSchemasOf(input.graph)
  const result = new Map<IrOperation, NativeObjectDataSlot>()
  const required = new Set<IrOperation>()
  const semanticOf = (lineage: SemanticResultId) => {
    const id = input.graph.results.get(lineage)
    return id === undefined ? undefined : input.graph.operations.get(id)
  }
  const allocations = new Map<OperationId, Extract<IrOperation, { kind: 'allocate-record' }>[]>()
  for (const body of input.bodies.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'allocate-record') continue
        const id = semanticOf(operation.lineage)?.id
        if (id !== undefined) allocations.set(id, [...(allocations.get(id) ?? []), operation])
      }
  for (const body of input.bodies.values()) {
    const definitions = new Map<IrValueId, IrOperation>()
    const positions = new Map<IrOperation, { readonly block: object; readonly index: number }>()
    const writes = new Map<DeclarationId, Extract<IrOperation, { kind: 'binding-write' }>[]>()
    const operations: IrOperation[] = []
    for (const block of body.blocks.values())
      for (const [index, operation] of allOperationsOf(block).entries()) {
        operations.push(operation)
        positions.set(operation, { block, index })
        const value = resultOfIrOperation(operation)
        if (value) definitions.set(value.id, operation)
        if (operation.kind === 'binding-write') {
          const rows = writes.get(operation.declaration) ?? []
          rows.push(operation)
          writes.set(operation.declaration, rows)
        }
      }
    const dominates = (before: IrOperation, after: IrOperation): boolean => {
      const a = positions.get(before)
      const b = positions.get(after)
      return a !== undefined && b !== undefined && a.block === b.block && a.index < b.index
    }
    const roots = new Map<IrValueId, Extract<IrOperation, { kind: 'allocate-record' }> | null>()
    const rootOf = (id: IrValueId): Extract<IrOperation, { kind: 'allocate-record' }> | null => {
      if (roots.has(id)) return roots.get(id)!
      roots.set(id, null)
      const producer = definitions.get(id)
      let root: Extract<IrOperation, { kind: 'allocate-record' }> | null = null
      if (producer?.kind === 'allocate-record' && sharedRecord(producer.result.representation)) root = producer
      else if (producer?.kind === 'convert') {
        const node = input.conversions.nodeById(producer.conversionUse)
        if (
          node &&
          representationKey(node.source) === representationKey(producer.source.representation) &&
          representationKey(node.target) === representationKey(producer.result.representation) &&
          (node.capability.kind === 'identity' || nativeFieldViewIdentityTransportOf(node))
        )
          root = rootOf(producer.source.value)
      } else if (
        producer?.kind === 'binding-read' &&
        ['local', 'region'].includes(input.placements.get(producer.declaration)?.storage.kind ?? '')
      ) {
        const rows = writes.get(producer.declaration)
        const before = rows?.length === 1 ? rows[0] : undefined
        if (before && dominates(before, producer)) root = rootOf(before.value.value)
      } else if (producer?.kind === 'set' || producer?.kind === 'define-own-property') {
        // Literal initialization threads the receiver through its native
        // definitions. Those results retain the allocation, just as Set does;
        // AllocateRecord.fields is not the complete initializer sequence.
        root = rootOf(producer.receiver.value)
      }
      roots.set(id, root)
      return root
    }
    // The stored operand behind identity-preserving conversions, when it is
    // the very value the schema's writer cites and dominates the store.
    const authenticStoredValueOf = (
      operation: Extract<IrOperation, { kind: 'set' }>,
      stated: NonNullable<NativeObjectDataSlotSchemaWriter['value']>
    ): IrOperand | null => {
      let value = operation.value
      const seen = new Set<IrValueId>()
      while (!seen.has(value.value)) {
        seen.add(value.value)
        const producer = definitions.get(value.value)
        if (producer?.kind !== 'convert') break
        const node = input.conversions.nodeById(producer.conversionUse)
        if (!node || !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) break
        value = producer.source
      }
      const actual = definitions.get(value.value)
      const authentic =
        stated.operand.source.kind === 'constant'
          ? actual?.kind === 'constant' && actual.literal === stated.operand.source.literal && actual.text === stated.operand.source.text
          : stated.operand.source.kind === 'result' && actual?.lineage === stated.operand.source.result
      return actual && dominates(actual, operation) && authentic ? value : null
    }
    // A receiver in a callee frame (a followed parameter, or a closed call's
    // result) holds one of several source allocations. The census lists them
    // completely, so the actual object's own descriptor is read or written
    // natively: every allocation must agree on the one storage carrier, and
    // an allocation without the key answers the ordinary absent read. Any
    // extension reached through an incomplete alias set stays required and
    // unreceipted, so it refuses rather than falling back to a boxed slot.
    const aliasedReceiptOf = (
      operation: Extract<IrOperation, { kind: 'get' | 'set' }>,
      semantic: SemanticOperation,
      receiver: SemanticResultId,
      keyDomain: readonly string[]
    ): NativeObjectDataSlot | null => {
      const held = source.aliases.get(receiver)
      if (!held?.size) return null
      const members = [...held].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const schemas = members.map((member) => keyDomain.map((text) => nativeObjectDataExtensionSchemaFor(input.graph, member, text)))
      const originals = members.map((member) => {
        const matching = allocations.get(member.id)
        return matching?.length === 1 && sharedRecord(matching[0]!.result.representation) ? matching[0]! : null
      })
      // The census lists a schema for every own key, declared literal keys
      // included. Only a key some member writes and whose allocated layout lacks
      // it is stored as native object data; a declared field is read from the
      // record, and a key nothing writes is never stored.
      const extendsSomeMember = members.some((_, index) => {
        const original = originals[index]
        if (!original || schemas[index]!.every((schema) => (schema?.writers.length ?? 0) === 0)) return false
        const allocated = original.result.representation
        const shape = allocated.kind === 'native-record-ref' ? input.deriver.layoutOf(allocated.shapeId as StructuralTypeId) : allocated
        return (
          shape.kind === 'record' &&
          !shape.fields.some((field) => keyDomain.includes(field.key)) &&
          !shape.accessors.some((field) => keyDomain.includes(field.key))
        )
      })
      // A receiver lowered to any other carrier (a dictionary, a dynamic
      // value) answers the access through that carrier, not native data.
      // A blocked member keeps its data on the dynamic descriptor path
      // (defineProperty, an exposed alias); that path answers the access, so
      // following the frame must not turn it into an unreceiptable demand.
      const blocked = schemas.some((row) => row.some((schema) => (schema?.blockers.length ?? 0) > 0))
      if (!extendsSomeMember || blocked || !projectedSharedRecord(operation.receiver.representation)) return null
      required.add(operation)
      if (!source.complete.has(receiver) || keyDomain.length !== 1 || objectPrototypeMemberNames.has(keyDomain[0]!)) return null
      if (originals.some((one) => one === null)) return null
      const carrier = originals[0]!.result.representation
      if (originals.some((one) => representationKey(one!.result.representation) !== representationKey(carrier))) return null
      const layout = carrier.kind === 'native-record-ref' ? input.deriver.layoutOf(carrier.shapeId as StructuralTypeId) : carrier
      if (
        layout.kind !== 'record' ||
        layout.fields.some((field) => keyDomain.includes(field.key)) ||
        layout.accessors.some((field) => keyDomain.includes(field.key))
      )
        return null
      const storages = schemas.map((row) => (row[0] === null ? null : nativeObjectDataStorageOf(row[0]!, input.deriver)))
      if (schemas.some((row, index) => row[0] !== null && storages[index] === null)) return null
      const present = storages.filter((one): one is NonNullable<typeof one> => one !== null)
      const storage = present[0]
      if (!storage || present.some((one) => representationKey(one.storage) !== representationKey(storage.storage))) return null
      const read: NativeObjectDataSlot['read'][number][] = []
      let write: NativeObjectDataSlot['write'] = null
      let materialization: ConversionNodeId | undefined
      if (operation.kind === 'get') {
        if (operation.result.representation.kind === 'dynamic') return null
        for (const physical of [storage.storage, { kind: 'undefined' } as const]) {
          const node = input.conversions.nodeFor(physical, operation.result.representation)
          if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return null
          read.push({ source: physical, conversion: node.id })
        }
      } else {
        // The schema lists this store as a writer of every allocation it can
        // reach; the stored operand must be the one it cites.
        if (present.length !== members.length) return null
        const writer = storage.writers.find(({ writer }) => writer.mutation.operation.id === semantic.id)
        if (!writer?.writer.value) return null
        const value = authenticStoredValueOf(operation, writer.writer.value)
        if (value === null) return null
        const node = input.conversions.nodeFor(value.representation, storage.storage)
        if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return null
        write = { value, conversion: node.id }
        const observed = materializationOf(
          storage.storage,
          present.some((one) => one.schema.observers.length > 0),
          input.conversions
        )
        if (observed === null) return null
        materialization = observed.materialization
      }
      return {
        allocation: members[0]!.id,
        allocations: members.map((member) => member.id),
        owner: operation.receiver,
        // A receiver already carried as the allocation's own record is that
        // object, not a live view over it; it has no separate origin to select.
        ...(representationKey(operation.receiver.representation) === representationKey(carrier) ? {} : { original: carrier }),
        key: keyDomain[0]!,
        storage: storage.storage,
        writers: [...new Set(present.flatMap((one) => one.writers.map(({ writer }) => writer.mutation.operation.id)))],
        read,
        write,
        ...(materialization === undefined ? {} : { materialization })
      }
    }
    // A store into a key whose storage is the object's dynamic own-property
    // table (`nativeObjectDataTableStorageOf`): an open bulk copy or unknown
    // code reaches the same descriptor, so the store installs its exact
    // carrier there with a mandatory materializer, and publishes no typed
    // read lane -- the open writers can leave a Value under the key.
    const tableStoreReceiptOf = (
      operation: Extract<IrOperation, { kind: 'set' }>,
      semantic: SemanticOperation,
      allocation: OperationId,
      carrier: Representation,
      key: string
    ): NativeObjectDataSlot | null => {
      if (!projectedSharedRecord(operation.receiver.representation) || objectPrototypeMemberNames.has(key)) return null
      const schema = nativeObjectDataExtensionSchemaAt(input.graph, semantic.id, key)
      const storage = schema === null ? null : nativeObjectDataTableStorageOf(schema, input.deriver)
      if (storage === null) return null
      const writer = storage.writers.find(({ writer }) => writer.mutation.operation.id === semantic.id)
      if (!writer?.writer.value) return null
      const value = authenticStoredValueOf(operation, writer.writer.value)
      if (value === null) return null
      const node = input.conversions.nodeFor(value.representation, storage.storage)
      if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) return null
      const observed = materializationOf(storage.storage, true, input.conversions)
      if (observed?.materialization === undefined) return null
      return {
        allocation,
        owner: operation.receiver,
        ...(representationKey(operation.receiver.representation) === representationKey(carrier) ? {} : { original: carrier }),
        key,
        storage: storage.storage,
        writers: [...new Set(storage.writers.map(({ writer }) => writer.mutation.operation.id))],
        read: [],
        write: { value, conversion: node.id },
        materialization: observed.materialization
      }
    }
    // A dynamic result the source itself declares: a string index of any or
    // unknown on the receiver's static type, or an explicit any read.
    const declaredDynamicReadOf = (operation: IrOperation & { kind: 'get' | 'set' }, semantic: SemanticOperation): boolean => {
      if (operation.kind !== 'get' || operation.result.representation.kind !== 'dynamic') return false
      if (operation.result.representation.reason !== 'declared-any-never-narrowed') return false
      if (semantic.family === 'property' && semantic.sourceAnyRead === true) return true
      const receiver = operandOf(semantic, 'receiver')
      const body = receiver && recordObjectShapeOf(input.graph.structuralTypes, receiver.type)
      const shape = body ? input.graph.structuralTypes.get(body)?.shape : undefined
      return (
        shape?.kind === 'object' &&
        shape.index.some((index) => {
          const value = input.graph.structuralTypes.get(index.value)?.shape
          return index.key === 'string' && value?.kind === 'primitive' && ['any', 'unknown'].includes(value.primitive)
        })
      )
    }
    for (const operation of operations) {
      if (operation.kind !== 'get' && operation.kind !== 'set') continue
      // Owned products carry their own physical fields. A sampled copy must
      // not inherit extension obligations from the original shared allocation.
      const receiverCarrier = operation.receiver.representation
      if ((receiverCarrier.kind === 'record' || receiverCarrier.kind === 'native-record-ref') && receiverCarrier.ownership === 'owned')
        continue
      const semantic = semanticOf(operation.lineage)
      const key = definitions.get(operation.key.value)
      if (semantic?.family !== 'property') continue
      const keyDomain = key?.kind === 'constant' && key.literal === 'string' ? [key.text] : semantic.provenKeyTexts
      if (!keyDomain?.length) continue
      if (
        !(key?.kind === 'constant' && key.literal === 'string') &&
        (operation.key.representation.kind !== 'string' ||
          !operation.provenKeyTexts ||
          operation.provenKeyTexts.length !== keyDomain.length ||
          operation.provenKeyTexts.some((text) => !keyDomain.includes(text)))
      )
        continue
      const keyText = keyDomain[0]!
      const receiver = operandOf(semantic, 'receiver')
      const sourceType = receiver && input.graph.structuralTypes.get(receiver.type)?.shape
      if (
        operation.receiver.representation.kind === 'dynamic' &&
        operation.receiver.representation.reason === 'declared-any-never-narrowed' &&
        receiver?.asserted !== true &&
        sourceType?.kind === 'primitive' &&
        (sourceType.primitive === 'any' || sourceType.primitive === 'unknown')
      )
        continue
      const allocation = receiver?.source.kind === 'result' ? source.origins.get(receiver.source.result) : undefined
      if (!allocation && receiver?.source.kind === 'result') {
        const aliased = aliasedReceiptOf(operation, semantic, receiver.source.result, keyDomain)
        if (aliased !== null) result.set(operation, aliased)
        continue
      }
      if (!allocation || keyDomain.some((text) => nativeObjectDataExtensionSchemaAt(input.graph, semantic.id, text) === null)) continue
      const matching = allocations.get(allocation.id)
      const original = matching?.length === 1 ? matching[0] : undefined
      if (!original || !sharedRecord(original.result.representation)) continue
      const carrier = original.result.representation
      const layout = carrier.kind === 'native-record-ref' ? input.deriver.layoutOf(carrier.shapeId as StructuralTypeId) : carrier
      // AllocateRecord.fields is an initializer list; the canonical carrier
      // layout includes declared optional slots even while they are absent.
      if (layout.kind === 'record-with-index' || layout.kind === 'dictionary') continue
      if (
        layout.kind === 'record' &&
        (layout.fields.some((field) => keyDomain.includes(field.key)) || layout.accessors.some((field) => keyDomain.includes(field.key)))
      )
        continue
      // An exposed allocation keeps every value of this key on the ordinary
      // descriptor path, which no typed writer can reach (a typed store into
      // it is itself refused). A read the source declares dynamic observes
      // that path directly; it holds no typed extension to fall back from.
      if (
        operation.kind === 'get' &&
        declaredDynamicReadOf(operation, semantic) &&
        keyDomain.every((text) => (nativeObjectDataExtensionSchemaAt(input.graph, semantic.id, text)?.blockers.length ?? 0) > 0)
      )
        continue
      required.add(operation)
      const storage = nativeObjectDataExtensionAt(input.graph, semantic.id, keyText, input.deriver)
      const alternatives = keyDomain.map((text) => nativeObjectDataExtensionAt(input.graph, semantic.id, text, input.deriver))
      if (!storage || alternatives.some((one) => !one || representationKey(one.storage) !== representationKey(storage.storage))) {
        const table =
          operation.kind === 'set' && keyDomain.length === 1
            ? tableStoreReceiptOf(operation, semantic, allocation.id, original.result.representation, keyText)
            : null
        if (table !== null) result.set(operation, table)
        continue
      }
      const owner = rootOf(operation.receiver.value)
      const direct = owner === original && dominates(original, operation)
      const projected =
        !direct &&
        projectedSharedRecord(operation.receiver.representation) &&
        keyDomain.every((text) => {
          const slot =
            semantic.nativeOwnSlot?.key === text ? semantic.nativeOwnSlot : semantic.nativeOwnSlots?.find((one) => one.key === text)
          return slot?.roots.length === 1 && input.graph.results.get(slot.roots[0]!.allocation) === allocation.id
        })
      if (layout.kind !== 'record') continue
      // A receiver evaluated in another frame (a captured cell, a closed
      // call's result) is not dominated by the allocation, but the census
      // still names its one exact allocation; it answers like an aliased one.
      if (!direct && !projected) {
        const aliased = receiver?.source.kind === 'result' ? aliasedReceiptOf(operation, semantic, receiver.source.result, keyDomain) : null
        if (aliased !== null) result.set(operation, aliased)
        continue
      }
      const read: NativeObjectDataSlot['read'][number][] = []
      let write: NativeObjectDataSlot['write'] = null
      let materialization: ConversionNodeId | undefined
      if (operation.kind === 'get') {
        // A library's ambient any result is not a source-declared dynamic
        // boundary. Native descriptor observation must publish its exact
        // carrier upstream before this typed slot can be read there.
        if (operation.result.representation.kind === 'dynamic') {
          if (
            !declaredDynamicReadOf(operation, semantic) ||
            !['string', 'scalar', 'symbol', 'undefined', 'null'].includes(storage.storage.kind)
          )
            continue
        }
        const present =
          direct &&
          keyDomain.length === 1 &&
          storage.writers.some(({ writer }) => {
            const installed = operations.find((one) => one.kind === 'set' && semanticOf(one.lineage)?.id === writer.mutation.operation.id)
            // A strict successful ordinary store installs the data or throws.
            // Its schema excludes descriptor/prototype mutation and unknown use.
            return (
              installed?.kind === 'set' && installed.strict && rootOf(installed.receiver.value) === owner && dominates(installed, operation)
            )
          })
        let admitted = true
        for (const physical of present ? [storage.storage] : [storage.storage, { kind: 'undefined' } as const]) {
          const node = input.conversions.nodeFor(physical, operation.result.representation)
          if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) {
            admitted = false
            break
          }
          read.push({ source: physical, conversion: node.id })
        }
        if (!admitted) continue
      } else {
        const writer = storage.writers.find(({ writer }) => writer.mutation.operation.id === semantic.id)
        if (!writer?.writer.value) continue
        const value = authenticStoredValueOf(operation, writer.writer.value)
        if (value === null) continue
        const node = input.conversions.nodeFor(value.representation, storage.storage)
        if (!recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)) continue
        write = { value, conversion: node.id }
        const observed = materializationOf(storage.storage, storage.schema.observers.length > 0, input.conversions)
        if (observed === null) continue
        materialization = observed.materialization
      }
      result.set(operation, {
        allocation: allocation.id,
        owner: direct ? { value: original.result.id, representation: carrier } : operation.receiver,
        ...(direct ? {} : { original: carrier }),
        key: keyText,
        ...(keyDomain.length === 1 ? {} : { keyDomain }),
        storage: storage.storage,
        writers: [...new Set(alternatives.flatMap((one) => one!.writers.map(({ writer }) => writer.mutation.operation.id)))],
        read,
        write,
        ...(materialization === undefined ? {} : { materialization })
      })
    }
  }
  return { required, receipts: result }
}

export const nativeObjectDataSlotsOf = (input: NativeObjectDataSlotInput): ReadonlyMap<IrOperation, NativeObjectDataSlot> =>
  nativeObjectDataSlotAuthorityOf(input).receipts

export const nativeObjectDataSlotMatches = (
  expected: NativeObjectDataSlot | undefined,
  actual: NativeObjectDataSlot | undefined
): boolean =>
  expected !== undefined &&
  actual !== undefined &&
  expected.allocation === actual.allocation &&
  JSON.stringify(expected.allocations) === JSON.stringify(actual.allocations) &&
  expected.owner.value === actual.owner.value &&
  representationKey(expected.owner.representation) === representationKey(actual.owner.representation) &&
  expected.key === actual.key &&
  JSON.stringify(expected.keyDomain) === JSON.stringify(actual.keyDomain) &&
  (expected.original === undefined
    ? actual.original === undefined
    : actual.original !== undefined && representationKey(expected.original) === representationKey(actual.original)) &&
  representationKey(expected.storage) === representationKey(actual.storage) &&
  expected.writers.length === actual.writers.length &&
  expected.writers.every((id, index) => id === actual.writers[index]) &&
  expected.read.length === actual.read.length &&
  expected.read.every((entry, index) => {
    const other = actual.read[index]!
    return entry.conversion === other.conversion && representationKey(entry.source) === representationKey(other.source)
  }) &&
  expected.materialization === actual.materialization &&
  (expected.write === null
    ? actual.write === null
    : actual.write !== null &&
      expected.write.value.value === actual.write.value.value &&
      expected.write.conversion === actual.write.conversion &&
      representationKey(expected.write.value.representation) === representationKey(actual.write.value.representation))

export const publishNativeObjectDataSlots = (input: NativeObjectDataSlotInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const receipts = nativeObjectDataSlotsOf(input)
  return new Map(
    [...input.bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) => {
                if (operation.kind !== 'get' && operation.kind !== 'set') return operation
                const { nativeObjectDataSlot: previous, ...ordinary } = operation
                const receipt = receipts.get(operation)
                return receipt === undefined
                  ? ordinary
                  : {
                      ...ordinary,
                      nativeObjectDataSlot: receipt,
                      conversionRecipes:
                        operation.conversionRecipes?.filter(
                          (recipe) => recipe.role !== (operation.kind === 'get' ? 'field-read' : 'field-write')
                        ) ?? []
                    }
              })
            }
          ])
        )
      }
    ])
  )
}
