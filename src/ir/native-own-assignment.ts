import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeFieldViewIdentityTransportOf } from '../conversion/native-field-view.js'
import { dictionaryEntryReadIsLive, dictionaryEntryWriteIsTotal } from '../conversion/dictionary-view.js'
import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import type { DeclarationId, IrValueId, OperationId, PhysicalBodyId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import { nativeObjectDataStorageOf, nativeObjectDataTableStorageOf } from '../projection/native-object-data.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { storedSourceValueOf } from '../representation/native-callable-data-storage.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { AllocationOperation } from '../semantics/model/operations.js'
import type { NativeOwnAssignmentValue } from '../semantics/native-own-assignment.js'
import { nativeObjectDataSlotSchemasOf, type NativeObjectDataSlotSchema } from '../semantics/native-object-data-slots.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { authenticatedNativeHostMethodReadOf, intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/** Exact all-writer proof for one allocation's physical slot.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnAssignmentStorageFit {
  readonly allocation: OperationId
  readonly source: Representation
  readonly storage: Representation
  readonly conversion: ConversionNodeId
}

/** A normal-path installing copy to the same original allocation.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnAssignmentPresence {
  readonly allocation: OperationId
  readonly assignment: SemanticResultId
  readonly owner: IrValueId
  readonly sourceOrdinal: number
}

/** Current native slot transport for one original Object.assign source.
 * Keys still enumerate at runtime in their current own-key order. Every
 * physical reader and destination belongs to an authenticated allocation.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnAssignmentRecipe {
  readonly operation: OperationId
  readonly allocation: OperationId
  readonly owner: IrOperand
  readonly sources: readonly {
    readonly ordinal: number
    readonly protocol: 'native-record' | 'dictionary-entry'
    /** The source's own carrier describes its keys: there is no original
     * allocation to recover, its typed fields are read off the evaluated
     * argument, and a run-time key outside them crosses as the Value it is. */
    readonly described?: true
    /** A described source's layout fields that already hold a Value: copied
     * by the same dynamic [[Get]]/[[Set]] as a run-time key. */
    readonly dynamicKeys?: readonly string[]
    readonly receiver: IrOperand
    readonly roots: readonly {
      readonly allocation: OperationId
      readonly carrier: Representation
      /** Each evaluated public arm either is this storage or retains it through this exact live plan. */
      readonly readers: readonly { readonly surface: Representation; readonly conversion: ConversionNodeId | null }[]
    }[]
    readonly fields: readonly {
      readonly key: string
      readonly storage: Representation
      readonly destination: 'held' | 'extension'
      readonly held: Representation
      readonly conversion: ConversionNodeId
      readonly storageFits: readonly NativeOwnAssignmentStorageFit[]
      readonly installations: readonly NativeOwnAssignmentPresence[]
      readonly copiedPresent: boolean
      /** An extension store whose allocation a dynamic reader observes carries its exact storage-to-Value recipe. */
      readonly materialization?: ConversionNodeId
      /** A described source's carrier can be a live view over a Document,
       * whose entry for this key is a Value: its exact live entry read. */
      readonly documentRead?: ConversionNodeId
    }[]
  }[]
}

export interface NativeOwnAssignmentInputs {
  readonly graph: SemanticGraph
  readonly deriver: RepresentationDeriver
  readonly conversions: ConversionCensus
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly selected: ReadonlyMap<SemanticResultId, Representation>
  readonly calleeRendering: CalleeRenderingInput | undefined
  /** Exact SSA definitions can precede a conditional argument's branch. */
  readonly definitionOf?: (value: IrValueId) => IrOperation | null
  readonly bodyOf?: (operation: CallOperation) => IrBody | null
}

export const nativeOwnAssignmentLayoutOf = (
  carrier: Representation,
  deriver: RepresentationDeriver
): Extract<Representation, { kind: 'record' }> | null => {
  const layout =
    carrier.kind === 'native-record-ref' && carrier.native === null ? deriver.layoutOf(carrier.shapeId as StructuralTypeId) : carrier
  return layout.kind === 'record' && layout.accessors.length === 0 ? layout : null
}

const sharedRecord = (value: Representation): boolean =>
  (value.kind === 'record' || (value.kind === 'native-record-ref' && value.native === null)) && value.ownership === 'shared-refcount'

const declaredDynamicDictionary = (value: Representation): value is Extract<Representation, { kind: 'dictionary' }> =>
  value.kind === 'dictionary' &&
  value.key === 'string' &&
  value.ownership === 'shared-refcount' &&
  value.value.kind === 'dynamic' &&
  value.value.reason === 'declared-any-never-narrowed'

const surfacesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? surfacesOf(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.flatMap((arm) => surfacesOf(arm.value))
      : value.kind === 'null' || value.kind === 'undefined'
        ? []
        : [value]

export const nativeOwnAssignmentValueRepresentationOf = (
  value: NativeOwnAssignmentValue,
  deriver: RepresentationDeriver
): Representation | null =>
  storedSourceValueOf(deriver, { callable: value.source.kind === 'function' ? value.source.callable : null, type: value.type })

/** Every actual writer fits this exact native slot by a complete canonical
 * recipe. Optional physical storage need not equal its present initializer,
 * but cannot acquire a writer requiring an unavailable source proof.
 */
export const nativeOwnAssignmentStoredValueConversionsOf = (
  values: readonly NativeOwnAssignmentValue[],
  storage: Representation,
  input: Pick<NativeOwnAssignmentInputs, 'deriver' | 'conversions'>
): readonly Omit<NativeOwnAssignmentStorageFit, 'allocation'>[] | null => {
  if (values.length === 0) return null
  const nodes = new Map<ConversionNodeId, Omit<NativeOwnAssignmentStorageFit, 'allocation'>>()
  for (const value of values) {
    const source = nativeOwnAssignmentValueRepresentationOf(value, input.deriver)
    if (source === null) return null
    const node = input.conversions.nodeFor(source, storage)
    if (
      representationKey(node.source) !== representationKey(source) ||
      representationKey(node.target) !== representationKey(storage) ||
      !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById) ||
      !recipeHasNormalResult(node, input.conversions.nodeById) ||
      !recipePreservesNativePayload(node, input.conversions.nodeById)
    )
      return null
    nodes.set(node.id, { source, storage, conversion: node.id })
  }
  return [...nodes.values()]
}

/** An actual declared-any table entry is a dynamic value boundary. This
 * proof sizes no owner or expando from a target shape: the source dictionary
 * already stores this exact lane and retains its native Ref identity.
 */
const dictionaryStoredValueConversionsOf = (
  values: readonly NativeOwnAssignmentValue[],
  storage: Representation,
  input: Pick<NativeOwnAssignmentInputs, 'deriver' | 'conversions'>
): readonly Omit<NativeOwnAssignmentStorageFit, 'allocation'>[] | null => {
  if (values.length === 0 || storage.kind !== 'dynamic' || storage.reason !== 'declared-any-never-narrowed') return null
  const nodes = new Map<ConversionNodeId, Omit<NativeOwnAssignmentStorageFit, 'allocation'>>()
  for (const value of values) {
    const source = nativeOwnAssignmentValueRepresentationOf(value, input.deriver)
    if (source === null) return null
    const node = input.conversions.nodeFor(source, storage)
    if (
      representationKey(node.source) !== representationKey(source) ||
      representationKey(node.target) !== representationKey(storage) ||
      !recipeHasNormalResult(node, input.conversions.nodeById) ||
      !dictionaryEntryWriteIsTotal(node, input.conversions.nodeById)
    )
      return null
    nodes.set(node.id, { source, storage, conversion: node.id })
  }
  return [...nodes.values()]
}

/** The intact stock callee lookup is part of the next copy's evaluated
 * frame. Its exact ambient binding/Get may be skipped by the template;
 * unrelated property reads cannot borrow that source identity.
 */
const ownAssignmentCalleePreludeOf = (
  operation: CallOperation,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs
): ReadonlySet<IrOperation> => {
  const prelude = new Set<IrOperation>()
  const definitions = new Map(
    operations.flatMap((one) => {
      const result = resultOfIrOperation(one)
      return result === null ? [] : [[result.id, one] as const]
    })
  )
  const definitionOf = input.definitionOf ?? ((value: IrValueId): IrOperation | null => definitions.get(value) ?? null)
  const semanticId = input.graph.results.get(operation.lineage)
  const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
  if (semantic?.family !== 'invocation' || semantic.intrinsicMutation !== 'object-assign') return prelude
  const read = authenticatedNativeHostMethodReadOf(operation, semantic, input.calleeRendering, definitionOf, undefined, 'object-assign')
  if (read !== null) {
    prelude.add(read.key)
    prelude.add(read.receiver)
    prelude.add(read.read)
  }
  return prelude
}

/** A total conversion is not necessarily effect-free. This normal-edge
 * proof admits only native identity transports, with exact source/result
 * carriers; a Get, user call, descriptor change or value conversion stops it.
 */
export const nativeOwnAssignmentEffectFreeInterval = (
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs,
  entry?: { readonly operation: CallOperation; readonly operations: readonly IrOperation[] }
): boolean => {
  const prelude = entry === undefined ? new Set<IrOperation>() : ownAssignmentCalleePreludeOf(entry.operation, entry.operations, input)
  return operations.every((operation) => {
    if (prelude.has(operation)) return true
    if (operation.kind === 'constant' || operation.kind === 'test') return true
    if (operation.kind === 'binding-read' || operation.kind === 'binding-write')
      return ['local', 'region'].includes(input.placements.get(operation.declaration)?.storage.kind ?? '')
    if (operation.kind !== 'convert') return false
    const node = input.conversions.nodeById(operation.conversionUse)
    return (
      node !== null &&
      representationKey(node.source) === representationKey(operation.source.representation) &&
      representationKey(node.target) === representationKey(operation.result.representation) &&
      (node.capability.kind === 'identity' || nativeFieldViewIdentityTransportOf(node)) &&
      recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
    )
  })
}

/** Only an earlier instruction in this exact block may establish presence.
 * Its complete recipe is reconstructed rather than trusting an IR marker.
 */
export const nativeOwnAssignmentInstalledPresenceOf = (
  allocation: OperationId,
  key: string,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs,
  entry?: { readonly operation: CallOperation; readonly operations: readonly IrOperation[] }
): NativeOwnAssignmentPresence | null => {
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index]!
    if (operation.kind !== 'call') continue
    if (!nativeOwnAssignmentEffectFreeInterval(operations.slice(index + 1), input, entry)) return null
    const recipe = nativeOwnAssignmentRecipeOf(operation, operations.slice(0, index + 1), input)
    if (recipe?.allocation !== allocation) return null
    const source = recipe.sources.find((source) => source.fields.some((field) => field.key === key && field.copiedPresent))
    return source === undefined
      ? null
      : { allocation, assignment: operation.lineage, owner: recipe.owner.value, sourceOrdinal: source.ordinal }
  }
  return null
}

const allocationOf = (graph: SemanticGraph, result: SemanticResultId): AllocationOperation | null => {
  const id = graph.results.get(result)
  const allocation = id === undefined ? undefined : graph.operations.get(id)
  return allocation?.family === 'allocation' && allocation.allocated === 'object-literal' && resultOf(allocation, 'value')?.id === result
    ? allocation
    : null
}

/** The same-block SSA identity spine. A live view can retain the original
 * allocation, but its public placeholder fields are never its held storage.
 */
export const nativeOwnAssignmentRootOf = (
  value: IrValueId,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs
): Extract<IrOperation, { kind: 'allocate-record' }> | null => {
  const definitions = new Map(
    operations.flatMap((operation) => {
      const result = resultOfIrOperation(operation)
      return result === null ? [] : [[result.id, operation] as const]
    })
  )
  const order = new Map(operations.map((operation, index) => [operation, index]))
  const active = new Set<IrValueId>()
  const rootOf = (id: IrValueId): Extract<IrOperation, { kind: 'allocate-record' }> | null => {
    if (active.has(id)) return null
    active.add(id)
    const operation = definitions.get(id)
    if (operation?.kind === 'allocate-record' && sharedRecord(operation.result.representation)) return operation
    if (operation?.kind === 'set' || operation?.kind === 'define-own-property') return rootOf(operation.receiver.value)
    if (operation?.kind === 'convert') {
      const node = input.conversions.nodeById(operation.conversionUse)
      return node &&
        representationKey(node.source) === representationKey(operation.source.representation) &&
        representationKey(node.target) === representationKey(operation.result.representation) &&
        (node.capability.kind === 'identity' || nativeFieldViewIdentityTransportOf(node))
        ? rootOf(operation.source.value)
        : null
    }
    if (
      operation?.kind === 'binding-read' &&
      ['local', 'region'].includes(input.placements.get(operation.declaration)?.storage.kind ?? '')
    ) {
      const writes = operations.filter(
        (one): one is Extract<IrOperation, { kind: 'binding-write' }> =>
          one.kind === 'binding-write' && one.declaration === operation.declaration
      )
      const writer = writes.length === 1 ? writes[0] : undefined
      return writer && order.get(writer)! < order.get(operation)! ? rootOf(writer.value.value) : null
    }
    if (operation?.kind === 'call') {
      const receipt = nativeOwnAssignmentRecipeOf(operation, operations.slice(0, order.get(operation)! + 1), input)
      return receipt === null ? null : rootOf(receipt.owner.value)
    }
    return null
  }
  return rootOf(value)
}

/** A described source's typed own keys are its carrier's declared fields,
 * on every object surface it can hold (they must agree on one storage).
 * Each lands in the target's fixed field of that key, or else in the
 * target allocation's census storage, which every writer of the key
 * (this copy included) must agree on. A dynamic field, like any run-time
 * key outside the layout, is copied as the Value it already is.
 */
const describedSourceFieldsOf = (
  receiver: Representation,
  keys: readonly string[],
  target: Extract<Representation, { kind: 'record' }>,
  schemas: ReadonlyMap<string, NativeObjectDataSlotSchema> | undefined,
  input: NativeOwnAssignmentInputs
): Pick<NativeOwnAssignmentRecipe['sources'][number], 'fields' | 'dynamicKeys'> | null => {
  const surfaces = surfacesOf(receiver)
  if (surfaces.length === 0 || !surfaces.every(sharedRecord)) return null
  const layouts = surfaces.map((surface) => nativeOwnAssignmentLayoutOf(surface, input.deriver))
  if (layouts.some((layout) => layout === null)) return null
  const declared = new Set(keys)
  const documentEntry: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const documentReadOf = (storage: Representation): { readonly documentRead?: ConversionNodeId } => {
    const node = input.conversions.dictionaryReadFor(documentEntry, storage)
    return node !== null &&
      representationKey(node.source) === representationKey(documentEntry) &&
      representationKey(node.target) === representationKey(storage) &&
      dictionaryEntryReadIsLive(node, input.conversions.nodeById) &&
      recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
      ? { documentRead: node.id }
      : {}
  }
  const fields: NativeOwnAssignmentRecipe['sources'][number]['fields'][number][] = []
  const dynamicKeys: string[] = []
  const seen = new Set<string>()
  for (const layout of layouts)
    for (const field of layout!.fields) {
      if (seen.has(field.key)) continue
      seen.add(field.key)
      const storages = layouts.flatMap((one) => one!.fields.filter((other) => other.key === field.key).map((other) => other.value))
      if (storages.some((storage) => representationKey(storage) !== representationKey(field.value))) return null
      const storage = field.value
      if (storage.kind === 'dynamic' || (storage.kind === 'optional' && storage.payload.kind === 'dynamic')) {
        dynamicKeys.push(field.key)
        continue
      }
      const fixed = target.fields.find((one) => one.key === field.key)
      const exact = (node: ReturnType<typeof input.conversions.nodeFor>, from: Representation, to: Representation): boolean =>
        representationKey(node.source) === representationKey(from) &&
        representationKey(node.target) === representationKey(to) &&
        recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
      if (fixed) {
        const node = input.conversions.nodeFor(storage, fixed.value)
        if (!exact(node, storage, fixed.value)) return null
        fields.push({
          key: field.key,
          storage,
          destination: 'held',
          held: fixed.value,
          conversion: node.id,
          storageFits: [],
          installations: [],
          copiedPresent: false,
          ...documentReadOf(storage)
        })
        continue
      }
      // A layout key the source's type does not declare has no census writer
      // to agree with; it cannot size target storage.
      const schema = declared.has(field.key) ? schemas?.get(field.key) : undefined
      if (schema === undefined) return null
      const extension =
        schema.blockers.length === 0
          ? nativeObjectDataStorageOf(schema, input.deriver)
          : nativeObjectDataTableStorageOf(schema, input.deriver)
      if (extension === null) return null
      const node = input.conversions.nodeFor(storage, extension.storage)
      if (!exact(node, storage, extension.storage)) return null
      // A table key is read by the open writers' dynamic protocol too: its
      // descriptor always carries the Value materializer.
      const observed =
        schema.blockers.length > 0 || schema.observers.length > 0
          ? input.conversions.nodeFor(extension.storage, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
          : null
      if (observed !== null && !recipeIsMaterializableWithoutPriorSourceGuard(observed, input.conversions.nodeById)) return null
      fields.push({
        key: field.key,
        storage,
        destination: 'extension',
        ...(observed === null ? {} : { materialization: observed.id }),
        held: extension.storage,
        conversion: node.id,
        storageFits: [],
        installations: [],
        copiedPresent: false,
        ...documentReadOf(storage)
      })
    }
  return { fields, ...(dynamicKeys.length === 0 ? {} : { dynamicKeys }) }
}

/** The portable source inventory closes aliases and every writer; this proof
 * binds it to the actual native input/result SSA and exact descriptor readers.
 */
export const nativeOwnAssignmentRecipeOf = (
  operation: CallOperation,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs
): NativeOwnAssignmentRecipe | null => {
  const semanticId = input.graph.results.get(operation.lineage)
  const semantic = semanticId === undefined ? undefined : input.graph.operations.get(semanticId)
  if (
    semantic?.family !== 'invocation' ||
    semantic.intrinsicMutation !== 'object-assign' ||
    !semantic.nativeOwnAssignment ||
    operation.argumentsAreSpread
  )
    return null
  const fact = semantic.nativeOwnAssignment
  const operationIndex = operations.indexOf(operation)
  if (operationIndex < 0) return null
  const before = operations.slice(0, operationIndex)
  const definitions = new Map(
    operations.flatMap((one) => {
      const result = resultOfIrOperation(one)
      return result === null ? [] : [[result.id, one] as const]
    })
  )
  const definitionOf = input.definitionOf ?? ((id: IrValueId): IrOperation | null => definitions.get(id) ?? null)
  // A described copy names no session target: the same-block identity spine
  // below is its only exact original allocation.
  const describedFact = fact.sources.some((source) => source.described !== undefined)
  if (
    !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
    (describedFact ? fact.targets.length !== 0 : fact.targets.length !== 1)
  )
    return null
  for (let ordinal = 0; ordinal < operation.arguments.length; ordinal++)
    if (!intrinsicCallArgumentMatches(operation, semantic, ordinal, definitionOf)) return null
  const target = operation.arguments[0]
  if (
    !target ||
    !sharedRecord(target.representation) ||
    (operation.result && representationKey(operation.result.representation) !== representationKey(target.representation))
  )
    return null
  const local = nativeOwnAssignmentRootOf(target.value, operations, input)
  if (describedFact && local === null) return null
  const targetResult = describedFact ? local!.lineage : fact.targets[0]!
  const allocation = allocationOf(input.graph, targetResult)
  const body = input.bodyOf?.(operation)
  // A conditional source argument splits the call from its already evaluated
  // target. The source fact owns the complete target family; its one original
  // allocation must still be an actual native producer in this body. Retain
  // the evaluated argument, rather than inventing a dominating allocation SSA.
  const producers = local || !body ? [] : [...body.blocks.values()].flatMap(allOperationsOf)
  const originals = producers.filter(
    (one): one is Extract<IrOperation, { kind: 'allocate-record' }> => one.kind === 'allocate-record' && one.lineage === targetResult
  )
  const original = local ?? (producers.includes(operation) && originals.length === 1 ? originals[0] : null)
  if (
    !original ||
    !allocation ||
    original.lineage !== targetResult ||
    representationKey(original.result.representation) !== representationKey(target.representation)
  )
    return null
  const layout = nativeOwnAssignmentLayoutOf(original.result.representation, input.deriver)
  if (layout === null) return null
  const census = nativeObjectDataSlotSchemasOf(input.graph)
  const targetSlots = fact.targetSlots.find((entry) => entry.allocation === fact.targets[0])
  if (targetSlots === undefined && !describedFact) return null
  const sources: NativeOwnAssignmentRecipe['sources'][number][] = []
  for (const source of fact.sources) {
    const receiver = operation.arguments[source.ordinal]
    const semanticSource = operandOf(semantic, 'argument', source.ordinal)
    if (!receiver || !semanticSource || semanticSource.source !== source.source) return null
    if (source.described !== undefined) {
      const described = describedSourceFieldsOf(
        receiver.representation,
        source.described.keys,
        layout,
        census.schemas.get(allocation.id),
        input
      )
      if (described === null) return null
      sources.push({ ordinal: source.ordinal, protocol: 'native-record', described: true, ...described, receiver, roots: [] })
      continue
    }
    if (targetSlots === undefined) return null
    const surfaces = surfacesOf(receiver.representation)
    const protocol =
      surfaces.length > 0 && surfaces.every(declaredDynamicDictionary)
        ? 'dictionary-entry'
        : surfaces.every(sharedRecord)
          ? 'native-record'
          : null
    if (protocol === null) return null
    const roots: NativeOwnAssignmentRecipe['sources'][number]['roots'][number][] = []
    const keys = new Set(source.roots.flatMap((root) => root.slots.map((slot) => slot.key)))
    const fields: NativeOwnAssignmentRecipe['sources'][number]['fields'][number][] = []
    for (const root of source.roots) {
      const allocation = allocationOf(input.graph, root.allocation)
      const carrier = input.selected.get(root.allocation)
      if (!allocation || !carrier) return null
      if (protocol === 'dictionary-entry') {
        // The bounded table route owns initial data slots only. A descriptor
        // replacement or later-added key loses this exact source witness.
        if (!declaredDynamicDictionary(carrier) || root.slots.some((slot) => !slot.copyPresent)) return null
      } else if (!sharedRecord(carrier) || nativeOwnAssignmentLayoutOf(carrier, input.deriver) === null) return null
      const readers: NativeOwnAssignmentRecipe['sources'][number]['roots'][number]['readers'][number][] = []
      for (const surface of surfaces) {
        if (representationKey(surface) === representationKey(carrier)) readers.push({ surface, conversion: null })
        else if (protocol === 'native-record') {
          const node = input.conversions.nodeFor(carrier, surface)
          if (
            representationKey(node.source) === representationKey(carrier) &&
            representationKey(node.target) === representationKey(surface) &&
            nativeFieldViewIdentityTransportOf(node) &&
            recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
          )
            readers.push({ surface, conversion: node.id })
        }
      }
      if (readers.length === 0) return null
      roots.push({ allocation: allocation.id, carrier, readers })
    }
    if (
      surfaces.some(
        (surface) => !roots.some((root) => root.readers.some((reader) => representationKey(reader.surface) === representationKey(surface)))
      )
    )
      return null
    for (const key of keys) {
      const slots = source.roots.flatMap((root) => root.slots.filter((slot) => slot.key === key))
      const values = slots.flatMap((slot) => slot.values).map((value) => nativeOwnAssignmentValueRepresentationOf(value, input.deriver))
      if (values.length === 0 || values.some((value) => value === null)) return null
      let storage: Representation | undefined
      const storageFits: NativeOwnAssignmentStorageFit[] = []
      const installations: NativeOwnAssignmentPresence[] = []
      // Every native root either holds this exact carrier in its own layout,
      // or in a closed native descriptor slot. Public view fields alone do
      // not authenticate that source storage.
      for (const [index, root] of source.roots.entries()) {
        if (!root.slots.some((slot) => slot.key === key)) continue
        const actual = roots[index]!
        const dictionary = protocol === 'dictionary-entry' && declaredDynamicDictionary(actual.carrier) ? actual.carrier : null
        const fixedStorage = nativeOwnAssignmentLayoutOf(actual.carrier, input.deriver)?.fields.find((field) => field.key === key)?.value
        const schema = census.schemas.get(actual.allocation)?.get(key)
        if (dictionary === null && (schema === undefined || schema.blockers.length !== 0)) return null
        const extension = fixedStorage || dictionary || schema === undefined ? null : nativeObjectDataStorageOf(schema, input.deriver)
        const readStorage = dictionary?.value ?? fixedStorage ?? extension?.storage
        const sourceFits = readStorage
          ? (dictionary ? dictionaryStoredValueConversionsOf : nativeOwnAssignmentStoredValueConversionsOf)(
              root.slots.find((slot) => slot.key === key)!.values,
              readStorage,
              input
            )
          : null
        if (!readStorage || (storage !== undefined && representationKey(readStorage) !== representationKey(storage)) || sourceFits === null)
          return null
        storageFits.push(...sourceFits.map((fit) => ({ ...fit, allocation: actual.allocation })))
        if (!root.slots.find((slot) => slot.key === key)!.copyPresent) {
          const installed = nativeOwnAssignmentInstalledPresenceOf(actual.allocation, key, before, input, { operation, operations })
          if (installed !== null) installations.push(installed)
        }
        // A contextual optional field can hold only present values in this
        // closed source family. Its native reader still returns the physical
        // Optional carrier, rather than the initializer's narrower bool/number.
        storage = readStorage
      }
      const fixed = layout.fields.find((field) => field.key === key)
      const targetSchema = census.schemas.get(allocation.id)?.get(key)
      const extension = fixed || targetSchema === undefined ? null : nativeObjectDataStorageOf(targetSchema, input.deriver)
      const held = fixed?.value ?? extension?.storage
      const domain = targetSlots.slots.find((slot) => slot.key === key)
      const targetFits = held && domain ? nativeOwnAssignmentStoredValueConversionsOf(domain.values, held, input) : null
      if (!held || !storage || targetSchema === undefined || targetSchema.blockers.length !== 0 || !domain || targetFits === null)
        return null
      storageFits.push(...targetFits.map((fit) => ({ ...fit, allocation: allocation.id })))
      const node =
        protocol === 'dictionary-entry' ? input.conversions.dictionaryReadFor(storage, held) : input.conversions.nodeFor(storage, held)
      if (
        node === null ||
        !recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById) ||
        (protocol === 'dictionary-entry' && !dictionaryEntryReadIsLive(node, input.conversions.nodeById))
      )
        return null
      const observed =
        !fixed && targetSchema.observers.length > 0
          ? input.conversions.nodeFor(held, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
          : null
      if (observed !== null && !recipeIsMaterializableWithoutPriorSourceGuard(observed, input.conversions.nodeById)) return null
      fields.push({
        key,
        storage,
        destination: fixed ? 'held' : 'extension',
        ...(observed === null ? {} : { materialization: observed.id }),
        held,
        conversion: node.id,
        storageFits,
        installations,
        copiedPresent:
          !source.nullable &&
          source.roots.length > 0 &&
          source.roots.every((root, index) =>
            root.slots.some(
              (slot) =>
                slot.key === key &&
                (slot.copyPresent || installations.some((installed) => installed.allocation === roots[index]!.allocation))
            )
          )
      })
    }
    sources.push({ ordinal: source.ordinal, protocol, receiver, roots, fields })
  }
  // A described source keeps the open copy wherever the target's own layout
  // already homes every typed key: only a key it lacks owes native storage.
  if (
    describedFact &&
    !sources.some((source) => source.described === true && source.fields.some((field) => field.destination === 'extension'))
  )
    return null
  return {
    operation: semantic.id,
    allocation: allocation.id,
    owner: local ? { value: original.result.id, representation: original.result.representation } : target,
    sources
  }
}

export const nativeOwnAssignmentRecipesMatch = (
  expected: NativeOwnAssignmentRecipe | null,
  actual: NativeOwnAssignmentRecipe | undefined
): boolean => expected !== null && actual !== undefined && JSON.stringify(expected) === JSON.stringify(actual)

export const publishNativeOwnAssignments = (
  input: NativeOwnAssignmentInputs & { readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody> }
): ReadonlyMap<PhysicalBodyId, IrBody> =>
  new Map(
    [...input.bodies].map(([id, body]) => {
      const definitions = new Map(
        [...body.blocks.values()].flatMap((block) =>
          allOperationsOf(block).flatMap((operation) => {
            const result = resultOfIrOperation(operation)
            return result === null ? [] : [[result.id, operation] as const]
          })
        )
      )
      const bodyInput = { ...input, definitionOf: (value: IrValueId) => definitions.get(value) ?? null, bodyOf: () => body }
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => {
              const operations = allOperationsOf(block)
              return [
                blockId,
                {
                  ...block,
                  operations: block.operations.map((operation) => {
                    if (operation.kind !== 'call') return operation
                    const { nativeOwnAssignment: old, ...ordinary } = operation
                    const receipt = nativeOwnAssignmentRecipeOf(operation, operations, bodyInput)
                    if (receipt === null) return ordinary
                    const { hostObjectWalkPlan: walk, ...native } = ordinary
                    return {
                      ...native,
                      nativeOwnAssignment: receipt,
                      conversionRecipes: operation.conversionRecipes?.filter((recipe) => recipe.role !== 'prototype-argument') ?? []
                    }
                  })
                }
              ]
            })
          )
        }
      ]
    })
  )
