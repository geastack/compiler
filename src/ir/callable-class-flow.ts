import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'
import { nativeConstructorMethodBodiesOf } from './native-constructor-reads.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { classLayoutOfCopy, classLayoutsConstructedBy, constructedBaseOf, type ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { abiOfCallee } from '../projection/callee.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodMutableOf } from '../projection/fields.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNode, ConversionNodeId } from '../conversion/algebra.js'
import { nativeDocumentEntryViewOf } from '../conversion/document-record-view.js'
import { nativeDocumentArrayEntryOf, type NativeDocumentArrayEntry } from './native-document-array-entries.js'
import { nativeArrayViewIdentityTransportOf, nativeArrayRootViewPlansOf } from '../conversion/array-view.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import {
  nativeCallableEntryReceiverOf,
  nativeCallableDynamicIdentityTransportMatches,
  nativeCallableIdentityTransportMatches,
  nativeCallableLogicalReceiverTransportMatches,
  type NativeCallableEntryReceiver
} from '../conversion/native-callable-adapter.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import { dynamicResultCarriersOf } from '../conversion/dynamic-result-carriers.js'
import { nativeMergePayloadTransportMatches } from './native-merge-transport.js'
import { nativeArrayTransportOf } from './native-array-transport.js'
import { nativeArrayInsertionOf, type NativeArrayInsertion } from './native-array-insertion.js'
import { nativeDictionaryTransportOf } from './native-dictionary-transport.js'
import { nativeFieldViewIdentityTransportOf, nativeFieldViewLiveLeavesOf, nativeFieldViewPlansOf } from '../conversion/native-field-view.js'
import { nativeRecordProductsOf } from '../conversion/native-record-products.js'
import { nativeFieldViewCarrierNeedsReceipt, nativeFieldViewBodyCitationsOf } from './native-field-view-facts.js'
import { nativeFieldViewDomainsOf, type NativeFieldStorageDomain } from './native-field-view-domains.js'
import { NATIVE_SUM_MATERIALIZER } from '../conversion/native-sum.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { nativeSequenceTransportOf } from './native-sequence-transport.js'
import { nativeClassInitializationOf, nativeSuperInitializationOf } from './native-class-initialization.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import { nativeOrdinaryPropertyPreservesPresence } from './native-property-presence-effects.js'
import { nativeClassAccessorEntryOf } from './native-class-accessor.js'
import { nativeConstructorAccessorEntryOf, nativeConstructorStaticCellOf } from './native-constructor-static.js'
import { censusClassStaticFieldSlots, staticStorageOwnerOf } from './class-static-fields.js'
import { hasNativePropertyLayout } from './native-fixed-layout.js'
import { nativeKeyQueryOf } from './native-key-query.js'
import { nativeCarrierPredicateOf } from './native-carrier-predicate.js'
import {
  nativePropertyPresenceAuthorityOf,
  nativePropertyPresenceStorageCandidatesOf,
  type NativePropertyPresenceGuard
} from './native-property-presence.js'
import { abiKey, representationKey, walkRepresentation, type CallableAbi, type Representation } from '../representation/model.js'
import { allOperationsOf, type CallCalleeIdentity, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { nativeArgumentsMatch, receivedCallArguments } from './call-entry.js'
import { nativeGenericCallEntriesOf, nativeGenericSelectorMatches } from './generic-call-entry.js'
import {
  classConstructorBodyMatches,
  constructMatchesAbi,
  explicitObjectConstructEntryOf,
  ordinaryConstructBodyMatches
} from './construct-entry.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import type { ProgramConversionRecipe } from './program-conversions.js'
import { nativeCallablePrimitiveDataWritePreservesOwner } from './native-callable-data-flow.js'

interface OriginCell {
  readonly index: number
  readonly incoming: Set<OriginCell>
  queued: boolean
  readonly functions: Set<FunctionId>
  readonly heaps: Set<NativeHeap>
  /** Null transfers every origin; native selection can exclude incompatible heaps. */
  readonly edges: Map<OriginCell, readonly NativeHeap[] | null>
  readonly documents: Map<string, Representation>
  /** Possible installed array callbacks survive unknown/mixed aliases too. */
  readonly arrayViews: Set<string>
  readonly descriptorSnapshots: Set<IrValueId>
  /** Installed readers can retain an allocation while changing its access protocol. */
  readonly fieldViews: Set<ConversionNodeId>
  documentInstalled: boolean
  documentBlocked: boolean
  unknown: boolean
  /** Null is unrestricted; a canonical checked sum can bound its unknown normal destinations. */
  unknownHeaps: Set<NativeHeap> | null
  escaped: boolean
  readonly escapeSources: Set<IrOperation | null>
  /**
   * How many of each escaped alias target's `escapeSources` this cell has
   * already absorbed. The set only grows, so an unchanged size means nothing
   * new to absorb: re-walking every target's whole set on every pop was nearly a
   * third of a large program's compile time.
   */
  escapeAbsorbed?: Map<OriginCell, number>
  /** `escapeSources` in insertion order, so an absorber can resume where it stopped. */
  readonly escapeSourceList: (IrOperation | null)[]
  logicalReceiver: boolean
  dynamicReceiver: boolean
  ignoresLogicalReceiver: boolean
  unknownReason?: string
  escapeReason?: string
  /** Bumped by every `changed(cell)`; see `heapEffect`. */
  version: number
}

interface NativeHeap {
  /** Internal proxy slots are not ordinary source property names. */
  readonly proxy?: true
  readonly declaration: DeclarationId | null
  readonly fields: Map<string, { readonly cell: OriginCell; readonly representation: Representation }>
  readonly layoutKey: string | null
  /** Absent on the external summary; local allocations share only its layout. */
  readonly template?: NativeHeap
  valid: boolean
}

export interface NativeCallableFlow {
  /** Complete identity families, independent of whether a composed adapter is
   * executable as the original physical frame. No unknown arm is omitted. */
  readonly callableIdentityOrigins: ReadonlyMap<IrValueId, readonly FunctionId[]>
  /** Actual publications of each native Function identity, including through
   * containers. Null denotes an external or implicit entry without a source operation. */
  readonly callablePublications: ReadonlyMap<FunctionId, ReadonlySet<IrOperation | null>>
  /** Returns in bodies whose complete entry domain stays native and closed. */
  readonly closedCallableReturns: ReadonlySet<IrOperation>
  /** Every normal source installs the same original declared-any Document entry protocol. */
  readonly nativeDocumentEntryValues?: ReadonlyMap<IrValueId, { readonly entry: Representation; readonly views: readonly string[] }>
  readonly nativeDocumentArrayEntryValues?: ReadonlyMap<IrValueId, NativeDocumentArrayEntry>
  /** Potential live storage, not a proof that every source has that protocol. */
  readonly nativeArrayViewValues?: ReadonlySet<IrValueId>
  /** Exact installed root recipes, retained for original storage consumers. */
  readonly nativeArrayViewOrigins?: ReadonlyMap<IrValueId, readonly ConversionNode[]>
  readonly nativeDescriptorSnapshotValues?: ReadonlyMap<IrValueId, readonly IrValueId[]>
  readonly nativeDescriptorSnapshotOpenValues?: ReadonlySet<IrValueId>
  readonly nativeFieldViewOrigins?: ReadonlyMap<IrValueId, readonly ConversionNodeId[]>
  /** A guarded property observation selects original allocation descriptors,
   * rather than changing the carrier-wide mutable storage bound. */
  readonly nativeFieldOperationStorageValues?: ReadonlyMap<IrOperation, ReadonlyMap<string, readonly NativeFieldStorageDomain[]>>
  /** Installed physical descriptors; independent of mutable Function implementation provenance. */
  readonly nativeFieldViewStorageValues: ReadonlyMap<IrValueId, ReadonlyMap<string, readonly NativeFieldStorageDomain[]>>
  /** A static key no installed descriptor of the value's live carrier names (`NativeFieldViewDomains.absentRoutesOf`). */
  readonly nativeFieldViewAbsentRoutesOf?: (receiver: IrValueId, key: string | null) => readonly NativeFieldStorageDomain[] | null
  /** Complete physical data-slot carriers of the same native allocation/alias census. */
  readonly nativeFieldStorageValues: ReadonlyMap<IrValueId, ReadonlyMap<string, readonly Representation[]>>
  readonly nativeFieldMethodValues: ReadonlyMap<IrValueId, ReadonlyMap<string, Representation>>
  readonly nativeAccessorStorageValues: ReadonlyMap<
    IrValueId,
    ReadonlyMap<string, readonly { readonly read: Representation; readonly write: Representation | null }[]>
  >
  readonly callables: ReadonlyMap<IrValueId, CallCalleeIdentity>
  /** Includes every implicit or unmodeled entry; only closed, uninvoked allocations are absent. */
  readonly enteredBodies: ReadonlySet<PhysicalBodyId>
  /** Positive invocation-protocol provenance, transported through the same native SSA and heap edges as function identity. */
  readonly logicalReceiverValues: ReadonlySet<IrValueId>
  readonly dynamicReceiverValues: ReadonlySet<IrValueId>
  /** Exact source bodies and admitted adapters whose complete receiver origin family ignores logical this. */
  readonly ignoredLogicalReceiverValues: ReadonlySet<IrValueId>
}

/**
 * Flow-insensitive native field provenance. A field write contributes
 * every implementation it can store; it never establishes an immutable-field
 * fact. Unknown calls and publications poison the affected heap, including
 * functions written there in a later solver round. Calls are resolved from
 * allocator identities before treating still-unresolved entries as external.
 *
 * This authority does not consume reflection demand: it proves the origins
 * which that demand needs. Unsupported transports fail closed. In particular,
 * an arbitrary matching callable signature is never an implementation source.
 */
const computeNativeCallableFlow = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions?: Pick<ConversionCensus, 'nodeById'> & Partial<Pick<ConversionCensus, 'nodeFor'>>,
  trace?: (read: Extract<IrOperation, { kind: 'get' }>, reason: string) => void,
  deriver?: Pick<RepresentationDeriver, 'layoutOf'> | null,
  programConversions?: readonly ProgramConversionRecipe[],
  constructionTopology?: readonly IrBody[]
): NativeCallableFlow => {
  const propertyLayoutCache = new Map<string, boolean>()
  const nativePropertyLayoutOf = (representation: Representation): boolean =>
    hasNativePropertyLayout(representation, deriver ?? null, classes, new Set<string>(), propertyLayoutCache)
  const cells: OriginCell[] = []
  const pendingCells: OriginCell[] = []
  const nextSweep: OriginCell[] = []
  let sweepIndex: number | null = null
  let revision = 0
  // Bumped whenever an existing heap changes what `slotsOf` can answer: it
  // loses validity, gains a field, or becomes an ordinary allocation.
  let heapEpoch = 0
  // Set when a heap selection consulted a presence guard, which reads cells
  // other than the receiver; see `heapEffect`.
  let presenceConsulted = false
  // Preserve the old sweep's cell order, including its backwards edges, while
  // visiting only changed cells. This also preserves closed-family ordering.
  const pushCell = (cell: OriginCell): void => {
    let index = pendingCells.length
    pendingCells.push(cell)
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (pendingCells[parent]!.index <= cell.index) break
      pendingCells[index] = pendingCells[parent]!
      index = parent
    }
    pendingCells[index] = cell
  }
  const popCell = (): OriginCell => {
    const first = pendingCells[0]!
    const last = pendingCells.pop()!
    if (pendingCells.length > 0) {
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        if (left >= pendingCells.length) break
        const right = left + 1
        const child = right < pendingCells.length && pendingCells[right]!.index < pendingCells[left]!.index ? right : left
        if (last.index <= pendingCells[child]!.index) break
        pendingCells[index] = pendingCells[child]!
        index = child
      }
      pendingCells[index] = last
    }
    first.queued = false
    return first
  }
  const schedule = (cell: OriginCell): void => {
    if (cell.queued) return
    cell.queued = true
    if (sweepIndex !== null && cell.index <= sweepIndex) nextSweep.push(cell)
    else pushCell(cell)
  }
  const changed = (cell: OriginCell): void => {
    revision++
    cell.version++
    schedule(cell)
  }
  const addFunction = (cell: OriginCell, id: FunctionId): void => {
    if (!cell.documentInstalled && !cell.documentBlocked) {
      cell.documentBlocked = true
      changed(cell)
    }
    if (cell.functions.has(id)) return
    cell.functions.add(id)
    changed(cell)
  }
  const addHeap = (cell: OriginCell, heap: NativeHeap): void => {
    if (cell.heaps.has(heap)) return
    cell.heaps.add(heap)
    changed(cell)
  }
  const markUnknown = (cell: OriginCell, reason?: string, admitted?: readonly NativeHeap[], installedDocumentSource = false): void => {
    if (!installedDocumentSource && !cell.documentInstalled && !cell.documentBlocked) {
      cell.documentBlocked = true
      changed(cell)
    }
    if (!cell.unknown) {
      cell.unknown = true
      cell.unknownHeaps = admitted === undefined ? null : new Set(admitted)
      changed(cell)
    } else if (cell.unknownHeaps !== null) {
      if (admitted === undefined) {
        cell.unknownHeaps = null
        changed(cell)
      } else
        for (const heap of admitted)
          if (!cell.unknownHeaps.has(heap)) {
            cell.unknownHeaps.add(heap)
            changed(cell)
          }
    }
    if (trace && reason !== undefined) cell.unknownReason ??= reason
  }
  const markEscaped = (cell: OriginCell, reason?: string, sources: Iterable<IrOperation | null> = [null]): void => {
    // One reschedule per call, not one per new source: nothing pops between
    // them, so every repeat was already a no-op on a queued cell.
    let grew = !cell.escaped
    cell.escaped = true
    for (const source of sources)
      if (!cell.escapeSources.has(source)) {
        cell.escapeSources.add(source)
        cell.escapeSourceList.push(source)
        grew = true
      }
    if (grew) {
      changed(cell)
      for (const incoming of cell.incoming) schedule(incoming)
    }
    if (trace && reason !== undefined) cell.escapeReason ??= reason
  }
  const absorbEscape = (cell: OriginCell, target: OriginCell): void => {
    const list = target.escapeSourceList
    const from = cell.escapeAbsorbed?.get(target) ?? 0
    if (from === list.length && cell.escaped) {
      if (trace && target.escapeReason !== undefined) cell.escapeReason ??= target.escapeReason
      return
    }
    // Exactly `markEscaped(cell, reason, target.escapeSources)`: every source
    // before `from` is already in this cell, so only the tail can add one,
    // and it adds them in the same order.
    let grew = !cell.escaped
    cell.escaped = true
    for (let at = from; at < list.length; at++) {
      const source = list[at]!
      if (!cell.escapeSources.has(source)) {
        cell.escapeSources.add(source)
        cell.escapeSourceList.push(source)
        grew = true
      }
    }
    if (grew) {
      changed(cell)
      for (const incoming of cell.incoming) schedule(incoming)
    }
    if (trace && target.escapeReason !== undefined) cell.escapeReason ??= target.escapeReason
    ;(cell.escapeAbsorbed ??= new Map()).set(target, list.length)
  }
  const markLogicalReceiver = (cell: OriginCell, dynamic = false): void => {
    if (!cell.logicalReceiver) {
      cell.logicalReceiver = true
      changed(cell)
    }
    if (dynamic && !cell.dynamicReceiver) {
      cell.dynamicReceiver = true
      changed(cell)
    }
  }
  const markIgnoredLogicalReceiver = (cell: OriginCell): void => {
    if (!cell.ignoresLogicalReceiver) {
      cell.ignoresLogicalReceiver = true
      changed(cell)
    }
  }
  const fresh = (): OriginCell => {
    const cell: OriginCell = {
      index: cells.length,
      incoming: new Set(),
      queued: false,
      functions: new Set(),
      heaps: new Set(),
      edges: new Map(),
      documents: new Map(),
      arrayViews: new Set(),
      descriptorSnapshots: new Set(),
      fieldViews: new Set(),
      documentInstalled: false,
      documentBlocked: false,
      unknown: false,
      unknownHeaps: new Set(),
      escaped: false,
      escapeSources: new Set(),
      escapeSourceList: [],
      version: 0,
      logicalReceiver: false,
      dynamicReceiver: false,
      ignoresLogicalReceiver: false
    }
    cells.push(cell)
    return cell
  }
  const values = new Map<IrValueId, OriginCell>()
  const value = (id: IrValueId): OriginCell => {
    const found = values.get(id)
    if (found) return found
    const cell = fresh()
    values.set(id, cell)
    return cell
  }
  const bindings = new Map<DeclarationId, OriginCell>()
  const binding = (id: DeclarationId): OriginCell => {
    const found = bindings.get(id)
    if (found) return found
    const cell = fresh()
    bindings.set(id, cell)
    return cell
  }
  const classHeaps = new Map<DeclarationId, NativeHeap>()
  const recordHeaps = new Map<string, NativeHeap>()
  const arrayHeaps = new Map<string, NativeHeap>()
  const dictionaryHeaps = new Map<string, NativeHeap>()
  const proxyHeaps = new Map<string, NativeHeap>()
  const recordViews = new WeakMap<Representation, NativeHeap>()
  const adaptedFrames = new Map<string, Map<string, NativeCallableEntryReceiver>>()
  const transportsCallablePrefix = (from: Representation, to: Representation, node: ConversionNode | null | undefined): boolean => {
    const receiver = nativeCallableEntryReceiverOf(from, to, node)
    if (receiver === null) return false
    const source = abiKey(abiOfCallee(from)!)
    const target = abiKey(abiOfCallee(to)!)
    const targets = adaptedFrames.get(source) ?? new Map<string, NativeCallableEntryReceiver>()
    targets.set(target, receiver === 'logical' || targets.get(target) === 'logical' ? 'logical' : 'physical')
    adaptedFrames.set(source, targets)
    return true
  }
  const adaptedReceiverOf = (source: CallableAbi, target: CallableAbi): NativeCallableEntryReceiver | null => {
    const destination = abiKey(target)
    const pending: [string, NativeCallableEntryReceiver][] = [[abiKey(source), 'physical']]
    const visited = new Set<string>()
    for (let index = 0; index < pending.length; index++) {
      const [current, receiver] = pending[index]!
      if (visited.has(current)) continue
      visited.add(current)
      for (const [next, entry] of adaptedFrames.get(current) ?? []) {
        const forwarded = receiver === 'logical' || entry === 'logical' ? 'logical' : 'physical'
        if (next === destination) return forwarded
        pending.push([next, forwarded])
      }
    }
    return null
  }
  const methodFallback = (declaration: DeclarationId, key: string): FunctionId | null => {
    if (!classMethodOverrideOf(classes, declaration, key) || classPrototypeMethodMutableOf(classes, declaration, key)) return null
    const member = classMemberOf(classes, declaration, key)
    return member?.kind === 'method' ? member.method.callable : null
  }
  for (const layout of classes.values()) {
    const slots = new Map<string, { readonly cell: OriginCell; readonly representation: Representation }>()
    for (const field of layout.nativeStorage?.fields ?? []) {
      const cell = fresh()
      const fallback = methodFallback(layout.declaration, field.key)
      if (fallback) {
        addFunction(cell, fallback)
        const member = classMemberOf(classes, layout.declaration, field.key)
        const source = member?.kind === 'method' ? member.method.representation : undefined
        if (source && conversions?.nodeFor) transportsCallablePrefix(source, field.value, conversions.nodeFor(source, field.value))
      }
      slots.set(field.key, { cell, representation: field.value })
    }
    classHeaps.set(layout.declaration, { declaration: layout.declaration, fields: slots, layoutKey: null, valid: true })
  }
  const operations = bodies.flatMap((body) => [...body.blocks.values()].flatMap((block) => [...block.operations, block.terminator]))
  const staticSlots = censusClassStaticFieldSlots(bodies, classes)
  const staticHeaps = new Map<DeclarationId, NativeHeap>(
    [...staticSlots.slots].map(([declaration, slots]) => [
      declaration,
      {
        declaration: null,
        layoutKey: `constructor-static:${declaration}`,
        valid: true,
        fields: new Map([...slots].map(([key, representation]) => [key, { cell: fresh(), representation }]))
      }
    ])
  )
  const constructorHeapsOf = (declaration: DeclarationId): readonly NativeHeap[] => {
    const found = new Set<NativeHeap>()
    const walked = new Set<DeclarationId>()
    let current: DeclarationId | null = declaration
    while (current !== null && !walked.has(current)) {
      walked.add(current)
      const heap = staticHeaps.get(staticStorageOwnerOf(classes, current))
      if (heap) found.add(heap)
      current = classes.get(current)?.base ?? null
    }
    return [...found]
  }
  const citedViewNodes = bodies
    .flatMap((body) => nativeFieldViewBodyCitationsOf(body).map((id) => conversions?.nodeById(id)))
    .filter((node): node is ConversionNode => node !== null && node !== undefined)
  for (const recipe of programConversions ?? [])
    if (conversions?.nodeById(recipe.conversion.id) === recipe.conversion) citedViewNodes.push(recipe.conversion)
  const viewNodes = [...recipeClosureOf(citedViewNodes, conversions?.nodeById).values()]
  const viewShapes = new Set(nativeFieldViewPlansOf(viewNodes).map((plan) => plan.target.shapeId))
  const viewMethodFields = new Map<string, Map<string, Representation>>()
  for (const node of viewNodes) {
    if (!nativeFieldViewIdentityTransportOf(node) || !('materializer' in node.capability)) continue
    for (const [plan, fields] of node.capability.materializer.recordView?.fieldViews ?? []) {
      if (plan.kind !== 'fields') continue
      const methods = viewMethodFields.get(fields.target.shapeId) ?? new Map<string, Representation>()
      for (const { field, read } of plan.fields)
        if (read.kind === 'bound-method' || read.kind === 'method-value') methods.set(field.key, field.value)
      viewMethodFields.set(fields.target.shapeId, methods)
    }
  }
  const valueCarriers = new Map(bodies.flatMap((body) => [...body.values]))
  const producers = new Map<IrValueId, IrOperation>()
  const bodyById = new Map<FunctionId, IrBody | null>()
  const physicalBodiesBySource = new Map<FunctionId, IrBody[]>()
  const returns = new Map<FunctionId, OriginCell>()
  // super() consumes the frame receiver even when the body never spells this
  // and lowering therefore produces no receiver SSA operation.
  const frameReceivers = new Map<FunctionId, OriginCell>()
  const parameters = new Map<FunctionId, Extract<IrOperation, { kind: 'parameter' | 'receiver' }>[]>()
  const owner = new Map<IrOperation, FunctionId>()
  const physicalOwner = new Map<IrOperation, IrBody>()
  for (const body of bodies) {
    const id = body.sourceOwner as FunctionId
    const physicalBodies = physicalBodiesBySource.get(id) ?? []
    physicalBodies.push(body)
    physicalBodiesBySource.set(id, physicalBodies)
    bodyById.set(id, bodyById.has(id) ? null : body)
    returns.set(id, fresh())
    if (body.abi?.receiver) frameReceivers.set(id, fresh())
    const inputs: Extract<IrOperation, { kind: 'parameter' | 'receiver' }>[] = []
    for (const block of body.blocks.values())
      for (const operation of [...block.operations, block.terminator]) {
        owner.set(operation, id)
        physicalOwner.set(operation, body)
        if (operation.kind === 'parameter' || operation.kind === 'receiver') inputs.push(operation)
      }
    parameters.set(id, inputs)
  }
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result) producers.set(result.id, operation)
    // These immutable recipes describe entry points even in dormant bodies.
    // Collect them before solving calls so a later body visit cannot change
    // whether an earlier call's frame has an admitted adapter path.
    if (operation.kind === 'convert')
      transportsCallablePrefix(
        operation.source.representation,
        operation.result.representation,
        conversions?.nodeById(operation.conversionUse)
      )
    if (operation.kind === 'get') {
      for (const recipe of operation.conversionRecipes ?? [])
        if (recipe.role === 'method-frame') transportsCallablePrefix(recipe.source, recipe.target, conversions?.nodeById(recipe.conversion))
      for (const recipe of operation.methodValueRecipes ?? [])
        transportsCallablePrefix(recipe.source, recipe.target, conversions?.nodeById(recipe.conversion))
    }
  }
  const arrayInsertions = new Map<IrOperation, NativeArrayInsertion>()
  const insertionReads = new Set<IrOperation>()
  const uses = new Map<IrValueId, Set<IrOperation>>()
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) {
      const users = uses.get(operand.value) ?? new Set<IrOperation>()
      users.add(operation)
      uses.set(operand.value, users)
    }
    if (operation.kind !== 'call') continue
    const insertion = nativeArrayInsertionOf(operation, (id) => producers.get(id) ?? null, classes, conversions)
    if (insertion !== null) arrayInsertions.set(operation, insertion)
  }
  // An extracted method can be published or rebound. Only the exact fused
  // uses above can keep its receiver's allocation closed.
  for (const insertion of arrayInsertions.values()) {
    const users = uses.get(insertion.read.result.id)
    if (
      users !== undefined &&
      [...users].every((user) => user.kind === 'call' && user.callee.value === insertion.read.result.id && arrayInsertions.has(user))
    )
      insertionReads.add(insertion.read)
  }
  const recordHeapOf = (representation: Representation): NativeHeap | null => {
    if (representation.kind !== 'record' && representation.kind !== 'record-with-index' && representation.kind !== 'native-record-ref')
      return null
    const known = recordViews.get(representation)
    if (known) return known
    const layout =
      representation.kind === 'native-record-ref'
        ? representation.native === null
          ? deriver?.layoutOf(representation.shapeId as StructuralTypeId)
          : null
        : representation
    const fields = layout?.kind === 'record' || layout?.kind === 'record-with-index' ? layout.fields : []
    const valid = layout?.kind === 'record' && layout.accessors.length === 0
    const layoutKey = layout ? representationKey(layout) : null
    let heap = recordHeaps.get(representation.shapeId)
    if (!heap) {
      heap = { declaration: null, fields: new Map(), layoutKey, valid }
      recordHeaps.set(representation.shapeId, heap)
    } else if (!valid || heap.layoutKey !== layoutKey) {
      heap.valid = false
      heapEpoch++
      slotCache.clear()
    }
    for (const field of fields)
      if (!heap.fields.has(field.key)) {
        heap.fields.set(field.key, { cell: fresh(), representation: field.value })
        heapEpoch++
      }
    recordViews.set(representation, heap)
    return heap
  }
  const arrayHeapOf = (representation: Extract<Representation, { kind: 'array-object' }>): NativeHeap => {
    // Extension views share element storage. Indexing by the whole array
    // representation would let writes through one view evade another's proof.
    const key = representationKey(representation.element)
    let heap = arrayHeaps.get(key)
    if (!heap) {
      heap = {
        declaration: null,
        fields: new Map([['', { cell: fresh(), representation: representation.element }]]),
        layoutKey: null,
        valid: representation.ownership === 'shared-refcount'
      }
      arrayHeaps.set(key, heap)
    } else if (representation.ownership !== 'shared-refcount') {
      heap.valid = false
      heapEpoch++
    }
    return heap
  }
  const nativeReferences = (representation: Representation): { readonly heaps: readonly NativeHeap[]; readonly complete: boolean } => {
    if (representation.kind === 'constructor-family')
      return {
        heaps: representation.members.flatMap((id) => [...constructorHeapsOf(id), ...(classHeaps.has(id) ? [classHeaps.get(id)!] : [])]),
        complete: representation.members.length > 0 && representation.members.every((id) => classes.get(id)?.nativeBase === null)
      }
    if (representation.kind === 'proxy-object') {
      const key = representationKey(representation)
      let heap = proxyHeaps.get(key)
      if (!heap) {
        heap = {
          proxy: true,
          declaration: null,
          fields: new Map([
            ['target', { cell: fresh(), representation: representation.target }],
            ['handler', { cell: fresh(), representation: representation.handler }]
          ]),
          layoutKey: key,
          valid: true
        }
        proxyHeaps.set(key, heap)
      }
      return { heaps: [heap], complete: true }
    }
    if (representation.kind === 'class-ref') {
      const heap = classHeaps.get(representation.declaration)
      return { heaps: heap ? [heap] : [], complete: heap !== undefined }
    }
    if (representation.kind === 'optional') return nativeReferences(representation.payload)
    if (representation.kind === 'borrowed-ref') return nativeReferences(representation.referent)
    if (representation.kind === 'tagged-union') {
      const arms = representation.arms.map((arm) => nativeReferences(arm.value))
      return { heaps: arms.flatMap((arm) => arm.heaps), complete: arms.every((arm) => arm.complete) }
    }
    if (representation.kind === 'dictionary') {
      const key = representationKey(representation.value)
      let heap = dictionaryHeaps.get(key)
      if (!heap) {
        heap = {
          declaration: null,
          fields: new Map([['', { cell: fresh(), representation: representation.value }]]),
          layoutKey: null,
          valid: representation.ownership === 'shared-refcount'
        }
        dictionaryHeaps.set(key, heap)
      } else if (representation.ownership !== 'shared-refcount') {
        heap.valid = false
        heapEpoch++
      }
      return { heaps: [heap], complete: heap.valid }
    }
    if (representation.kind === 'array-object') {
      const heap = arrayHeapOf(representation)
      return { heaps: [heap], complete: heap.valid }
    }
    const heap = recordHeapOf(representation)
    return heap
      ? { heaps: [heap], complete: heap.valid }
      : { heaps: [], complete: representation.kind === 'null' || representation.kind === 'undefined' }
  }
  const related = (a: DeclarationId, b: DeclarationId): boolean => a === b || extendsClass(classes, a, b) || extendsClass(classes, b, a)
  // The class map is fixed before solving, and this answer depends on nothing
  // else, but it is asked once per published heap per family candidate -- each
  // time a walk of every class and its ancestry.
  const methodLayoutsByDeclaration = new Map<DeclarationId, readonly ClassLayout[]>()
  const methodLayoutsOf = (declaration: DeclarationId): readonly ClassLayout[] => {
    let held = methodLayoutsByDeclaration.get(declaration)
    if (!held) {
      held = [...classes.values()].filter(
        (layout) => layout.declaration === declaration || extendsClass(classes, declaration, layout.declaration)
      )
      methodLayoutsByDeclaration.set(declaration, held)
    }
    return held
  }
  const families = new WeakMap<NativeHeap, readonly NativeHeap[]>()
  const familyOf = (heap: NativeHeap): readonly NativeHeap[] => {
    const known = families.get(heap)
    if (known) return known
    // All class summaries are installed before solving. Field validity may
    // change, but class ancestry and allocation identity do not.
    const family =
      heap.template !== undefined || heap.declaration === null
        ? [heap]
        : [...classHeaps.values()].filter(
            (candidate) => candidate.declaration !== null && related(heap.declaration!, candidate.declaration)
          )
    families.set(heap, family)
    return family
  }
  const keyOf = (operand: IrOperand): string | null => {
    const producer = producers.get(operand.value)
    return producer?.kind === 'constant' && producer.literal === 'string' ? producer.text : null
  }
  const propertyPresence = new Map(
    conversions === undefined ? [] : bodies.map((body) => [body, nativePropertyPresenceAuthorityOf(body, conversions)] as const)
  )
  const ordinaryAllocated = (heap: NativeHeap): boolean =>
    ordinaryObjectAllocations.has(heap) &&
    heap.template !== undefined &&
    heap.declaration === null &&
    heap.valid &&
    heap.template.valid &&
    !heap.proxy &&
    heap.layoutKey !== null &&
    !heap.fields.has('__proto__')
  const originalDescriptorAbsent = (operation: Extract<IrOperation, { kind: 'get' }>, key: string, heap: NativeHeap): boolean => {
    const receiver = value(operation.receiver.value)
    return (
      operation.ordinaryObjectPrototypeKeyAbsent === true &&
      !receiver.unknown &&
      !receiver.escaped &&
      !escapedHeaps.has(heap) &&
      ordinaryAllocated(heap) &&
      !heap.fields.has(key)
    )
  }
  const preservesPresence = (operation: IrOperation, key: string, guard: NativePropertyPresenceGuard): boolean => {
    if (operation.kind === 'get') {
      const name = keyOf(operation.key)
      const receiver = value(operation.receiver.value)
      return (
        name !== null &&
        nativeOrdinaryPropertyPreservesPresence(operation, name, guard) &&
        !receiver.unknown &&
        receiver.heaps.size > 0 &&
        [...receiver.heaps].every((heap) => ordinaryAllocated(heap) && (name === key ? guard.present : heap.fields.has(name)))
      )
    }
    if (operation.kind === 'set' || operation.kind === 'define-own-property') {
      const name = keyOf(operation.key)
      const receiver = value(operation.receiver.value)
      return (
        name !== null &&
        operation.kind === 'set' &&
        nativeOrdinaryPropertyPreservesPresence(operation, name, guard) &&
        !receiver.unknown &&
        receiver.heaps.size > 0 &&
        [...receiver.heaps].every((heap) => ordinaryAllocated(heap) && (name === key ? guard.present : heap.fields.has(name)))
      )
    }
    if (operation.kind === 'convert') {
      const node = conversions?.nodeById(operation.conversionUse)
      return (
        node?.capability.kind === 'identity' ||
        nativeFieldViewIdentityTransportOf(node) ||
        nativePayloadTransportMatches(operation.source.representation, operation.result.representation, node)
      )
    }
    // Arithmetic over native primitive carriers cannot call a user coercion.
    if (operation.kind === 'compute')
      return operandsOfIrOperation(operation).every((operand) =>
        ['scalar', 'string', 'symbol', 'null', 'undefined'].includes(operand.representation.kind)
      )
    return false
  }
  const heapSelectionAt = (
    receiver: IrOperand,
    key: string,
    at?: IrOperation
  ): { readonly heaps: readonly NativeHeap[] | null; readonly present: boolean } => {
    const cell = value(receiver.value)
    const heaps = [...cell.heaps]
    if (at === undefined || cell.unknown || cell.escaped || heaps.length === 0 || !heaps.every(ordinaryAllocated))
      return { heaps, present: false }
    presenceConsulted = true
    const guard = propertyPresence.get(physicalOwner.get(at)!)?.(receiver, key, at, (operation, guard) =>
      preservesPresence(operation, key, guard)
    )
    if (guard === undefined || guard === null) return { heaps, present: false }
    // The sealed standard-prototype absence fact plus this complete ordinary
    // allocation domain turns full Has into an own-descriptor selection.
    const selected = nativePropertyPresenceStorageCandidatesOf(guard, heaps, (heap, key) => heap.fields.has(key))
    return { heaps: selected.length > 0 ? selected : null, present: guard.present }
  }
  const heapsAt = (receiver: IrOperand, key: string, at?: IrOperation): readonly NativeHeap[] | null =>
    heapSelectionAt(receiver, key, at).heaps
  const slotCache = new Map<string, Map<string, readonly OriginCell[] | null>>()
  const slotTemplatesOf = (receiver: Representation, key: string): readonly OriginCell[] | null => {
    // Carrier keys can be large. Nest the property map instead of serializing
    // the complete carrier into a new JSON string on every solver visit.
    const receiverKey = representationKey(receiver)
    const cached = slotCache.get(receiverKey)
    if (cached?.has(key)) return cached.get(key)!
    const remember = (answer: readonly OriginCell[] | null): readonly OriginCell[] | null => {
      let slots = slotCache.get(receiverKey)
      if (!slots) slotCache.set(receiverKey, (slots = new Map()))
      slots.set(key, answer)
      return answer
    }
    const { heaps, complete } = nativeReferences(receiver)
    const family = [...new Set(heaps.flatMap(familyOf))]
    if (
      !complete ||
      heaps.length === 0 ||
      heaps.some((heap) => heap.proxy === true || !heap.valid || !heap.fields.has(key)) ||
      family.some((heap) => {
        if (heap.declaration === null) return !heap.valid
        const layout = classes.get(heap.declaration)!
        const member = classMemberOf(classes, layout.declaration, key)
        return (
          layout.nativeStorage === undefined ||
          layout.nativeBase !== null ||
          (member !== null && member.kind !== 'field' && methodFallback(layout.declaration, key) === null)
        )
      })
    ) {
      return remember(null)
    }
    const sources = family.flatMap((heap) => {
      const slot = heap.fields.get(key)
      return slot ? [slot.cell] : []
    })
    return remember(sources)
  }
  const seedHeaps = (cell: OriginCell, representation: Representation): void => {
    for (const heap of nativeReferences(representation).heaps) addHeap(cell, heap)
  }
  const external = (cell: OriginCell, representation: Representation, reason = 'unattributed-input'): void => {
    markUnknown(cell, reason)
    seedHeaps(cell, representation)
  }
  const escape = (cell: OriginCell, reason: string, operation?: IrOperation): void => {
    markEscaped(cell, reason, [operation ?? null])
  }
  const link = (from: OriginCell, to: OriginCell): void => {
    if (from.edges.get(to) === null) return
    from.edges.set(to, null)
    to.incoming.add(from)
    changed(from)
  }
  const linkPayload = (from: OriginCell, to: OriginCell, representations: readonly Representation[]): void => {
    const references = representations.map(nativeReferences)
    // Only a sealed payload-preserving conversion calls this. Layouts bound
    // which input allocations can survive its native tag/identity selection;
    // they never create an origin for an allocation not present in the input.
    if (references.some((reference) => !reference.complete) || from.edges.has(to)) link(from, to)
    else {
      from.edges.set(
        to,
        references.flatMap((reference) => reference.heaps)
      )
      to.incoming.add(from)
      changed(from)
    }
  }
  const heapAdmitted = (heap: NativeHeap, allowed: readonly NativeHeap[]): boolean => {
    const template = heap.template ?? heap
    return allowed.some(
      (target) =>
        template === target ||
        (heap.declaration !== null &&
          target.declaration !== null &&
          (heap.declaration === target.declaration || extendsClass(classes, heap.declaration, target.declaration)))
    )
  }
  const allocations = new Map<IrValueId, readonly NativeHeap[]>()
  const ordinaryObjectAllocations = new WeakSet<NativeHeap>()
  const seedAllocation = (
    id: IrValueId,
    representation: Representation,
    selected?: readonly Representation[],
    ordinaryObject = false
  ): readonly NativeHeap[] => {
    const allocated = value(id)
    if (!allocated.documentBlocked) {
      allocated.documentBlocked = true
      changed(allocated)
    }
    const known = allocations.get(id)
    if (known) return known
    const templatesOfAllocation =
      selected === undefined ? nativeReferences(representation).heaps : selected.flatMap((item) => nativeReferences(item).heaps)
    const heaps = [...new Set(templatesOfAllocation)].map((template): NativeHeap => {
      const fields = new Map<string, { readonly cell: OriginCell; readonly representation: Representation }>()
      const templates =
        template.declaration === null
          ? [template]
          : familyOf(template).filter(
              (candidate) =>
                candidate.declaration !== null &&
                (candidate.declaration === template.declaration || extendsClass(classes, template.declaration!, candidate.declaration))
            )
      for (const parent of [...templates].reverse())
        for (const [key, slot] of parent.fields) fields.set(key, { cell: fresh(), representation: slot.representation })
      for (const [key, slot] of template.fields) fields.set(key, { cell: fresh(), representation: slot.representation })
      const heap: NativeHeap = {
        declaration: template.declaration,
        layoutKey: template.layoutKey,
        valid: template.valid,
        template,
        fields,
        ...(template.proxy === true ? { proxy: true as const } : {})
      }
      // A fresh instance owns no override yet. Seed its prototype alternative
      // before stores add replacement bodies; otherwise a later assignment
      // would falsely prove that all reads, including earlier ones, name it.
      if (heap.declaration !== null)
        for (const [key, slot] of fields) {
          const fallback = methodFallback(heap.declaration, key)
          if (fallback) addFunction(slot.cell, fallback)
        }
      if (heap.declaration !== null)
        for (const parent of templates)
          for (const field of classes.get(parent.declaration!)!.fields) {
            const returned = field.initializer === null ? undefined : returns.get(field.initializer)
            const slot = fields.get(field.key)
            if (returned && slot) link(returned, slot.cell)
          }
      return heap
    })
    allocations.set(id, heaps)
    for (const heap of heaps) {
      if (ordinaryObject) {
        ordinaryObjectAllocations.add(heap)
        heapEpoch++
      }
      addHeap(value(id), heap)
    }
    return heaps
  }
  const slotsOf = (receiver: IrOperand, key: string, at?: IrOperation): readonly OriginCell[] | null => {
    if (slotTemplatesOf(receiver.representation, key) === null) return null
    const slots: OriginCell[] = []
    const heaps = heapsAt(receiver, key, at)
    if (heaps === null) return null
    for (const heap of heaps) {
      if (!heap.valid || heap.template?.valid === false || !heap.fields.has(key)) return null
      slots.push(heap.fields.get(key)!.cell)
    }
    return slots
  }
  // Field edges wait for receiver origins. A type supplies a layout, never an
  // alias to every allocation of that type. The same worklist handles stores,
  // loads and array copies as new call/return origins arrive.
  const heapEffects: { readonly operation: IrOperation; readonly apply: () => boolean; readonly reject?: () => void }[] = []
  /**
   * `receiver` names the one cell an effect reads, when that is all it reads:
   * its `slotsOf` answer is then a function of that cell and of the heaps'
   * state, and every write it makes (`link`, `untrusted`) is idempotent. Such
   * an effect is replayed only after its receiver or a heap changed. Re-running
   * every effect on every settle round was most of what this solver cost on
   * a large program. A selection that consulted a presence guard read other cells, so
   * it is always re-run, as is one whose receiver cell does not exist yet
   * (creating it early would renumber the cells).
   */
  const heapEffect = (operation: IrOperation, apply: () => boolean, reject?: () => void, receiver?: IrValueId): void => {
    if (receiver === undefined) {
      heapEffects.push({ operation, apply, ...(reject ? { reject } : {}) })
      return
    }
    let seenVersion = -1
    let seenEpoch = -1
    let answer = false
    const replayed = (): boolean => {
      const cell = values.get(receiver)
      if (cell !== undefined && cell.version === seenVersion && heapEpoch === seenEpoch) return answer
      const version = cell?.version ?? -1
      const epoch = heapEpoch
      presenceConsulted = false
      answer = apply()
      seenVersion = cell === undefined || presenceConsulted ? -1 : version
      seenEpoch = epoch
      return answer
    }
    heapEffects.push({ operation, apply: replayed, ...(reject ? { reject } : {}) })
  }
  const citedEntriesOf = (operation: Extract<IrOperation, { kind: 'call' }>): ReadonlySet<FunctionId> =>
    new Set([
      ...(operation.family ?? []).map((member) => member.functionId),
      ...(operation.target?.kind === 'direct' ? [operation.target.functionId] : []),
      ...(operation.closedCallee === undefined
        ? []
        : operation.closedCallee.kind === 'exact'
          ? [operation.closedCallee.functionId]
          : operation.closedCallee.functionIds)
    ])
  const constructionEntriesOf = (layout: ClassLayout, seen = new Set<DeclarationId>()): readonly FunctionId[] => {
    if (seen.has(layout.declaration)) return []
    seen.add(layout.declaration)
    const constructed = constructedBaseOf(layout)
    const base = constructed === null ? undefined : classes.get(constructed)
    return [
      ...(layout.constructor === null ? [] : [layout.constructor]),
      ...layout.fields.flatMap((field) => (field.initializer === null ? [] : [field.initializer])),
      ...(base ? constructionEntriesOf(base, seen) : [])
    ]
  }
  const externalEntries = new Set<FunctionId>()
  const externalEntry = (id: FunctionId, reason: string): void => {
    externalEntries.add(id)
    enter(id)
    const receiver = frameReceivers.get(id)
    const representation = bodyById.get(id)?.abi?.receiver
    if (receiver && representation) external(receiver, representation, reason)
    for (const input of parameters.get(id) ?? []) external(value(input.result.id), input.result.representation, reason)
    const returned = returns.get(id)
    if (returned) escape(returned, reason)
  }
  // Convert results holding only a Value injected into a union's own `dynamic`
  // arm (see the `convert` case): their unknown origin is that arm's, never
  // an uninstalled source of the union's Document arm.
  const documentNeutralCells = new Set<OriginCell>()
  const untrusted = (
    operation: IrOperation,
    normalCarriers?: readonly Representation[],
    identityResult?: IrOperand,
    documentNeutral = false
  ): void => {
    const reason = `${operation.kind}:${operation.lineage}`
    const operands =
      operation.kind === 'call'
        ? [operation.callee, ...(operation.receiver ? [operation.receiver] : []), ...receivedCallArguments(operation)]
        : operandsOfIrOperation(operation)
    for (const operand of operands) escape(value(operand.value), reason, operation)
    // super() also receives this even though the IR operation lists only
    // explicit arguments. An unmodeled base entry may publish that receiver.
    if (operation.kind === 'super-initialize') {
      const receiver = frameReceivers.get(owner.get(operation)!)
      if (receiver) escape(receiver, reason, operation)
      for (const input of parameters.get(owner.get(operation)!) ?? [])
        if (input.kind === 'receiver') escape(value(input.result.id), reason, operation)
      for (const layout of classes.values())
        if (layout.constructor === owner.get(operation)) for (const id of constructionEntriesOf(layout)) externalEntry(id, reason)
    }
    if (operation.kind === 'construct') {
      const targets =
        operation.target.kind === 'exact'
          ? [operation.target.target]
          : operation.target.kind === 'closed-family'
            ? operation.target.targets
            : []
      for (const target of targets) {
        const layouts = [...classes.values()].filter((layout) =>
          target.kind === 'function' ? layout.constructor === target.functionId : layout.declaration === target.classDeclaration
        )
        for (const layout of layouts) for (const id of constructionEntriesOf(layout)) externalEntry(id, reason)
      }
    }
    const result = resultOfIrOperation(operation)
    if (result && identityResult !== undefined) link(value(identityResult.value), value(result.id))
    else if (result) {
      const destinations = normalCarriers?.map(nativeReferences)
      if (destinations !== undefined && destinations.every((destination) => destination.complete)) {
        const heaps = destinations.flatMap((destination) => destination.heaps.flatMap(familyOf))
        markUnknown(value(result.id), reason, heaps, documentNeutral)
        for (const heap of heaps) addHeap(value(result.id), heap)
      } else if (documentNeutral) {
        markUnknown(value(result.id), reason, undefined, true)
        seedHeaps(value(result.id), result.representation)
      } else external(value(result.id), result.representation, reason)
    }
    // A physical/semantic citation can enter a body even when its callable SSA
    // value has no modeled provenance. Preserve that entry without pretending
    // the unknown caller's arguments were part of a closed native frame.
    if (operation.kind === 'call') for (const id of citedEntriesOf(operation)) externalEntry(id, reason)
  }
  const called = new Set<FunctionId>()
  // Retaining an allocation or native prototype method does not execute it.
  // Calls and publications open those bodies through the same provenance
  // lattice. Implicit accessors, host entries and ambiguous variants remain
  // roots; an unentered recursive cycle stays dormant.
  const allocated = new Set(operations.flatMap((operation) => (operation.kind === 'allocate-callable' ? [operation.functionId] : [])))
  const instanceMethods = new Set<FunctionId>()
  const instanceAccessors = new Set<FunctionId>()
  for (const layout of classes.values()) {
    const family = familyOf(classHeaps.get(layout.declaration)!)
    if (family.some((heap) => heap.declaration !== null && classes.get(heap.declaration)?.nativeBase !== null)) continue
    for (const method of layout.methods) if (method.callable !== null) instanceMethods.add(method.callable)
    for (const accessor of layout.accessors) for (const id of [accessor.getter, accessor.setter]) if (id !== null) instanceAccessors.add(id)
  }
  const implicitEntries = new Set<FunctionId>()
  const constructionBodies = new Set<FunctionId>()
  // A prefix can omit a later class allocation without turning its retained
  // initializer into an unknown external entry. Recover only the allocation
  // topology from the complete program; calls and effects still come from
  // the bodies being solved. An actual publication opens these entries below.
  const allocatedClasses = new Set(
    (constructionTopology === undefined
      ? operations
      : constructionTopology.flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    ).flatMap((operation) => (operation.kind === 'allocate-constructor' ? [operation.declaration] : []))
  )
  for (const layout of classes.values()) {
    if (!allocatedClasses.has(layout.declaration) || layout.nativeBase !== null || layout.instance === null) continue
    const constructor = layout.constructor === null ? null : bodyById.get(layout.constructor)
    if (layout.constructor !== null && (!constructor || !classConstructorBodyMatches(layout, constructor))) continue
    for (const id of [layout.constructor, ...layout.fields.map((field) => field.initializer)])
      if (id !== null && bodyById.get(id)?.abi) constructionBodies.add(id)
  }
  const implicitAccessorEntries = new Set<FunctionId>()
  const implicitEntry = (id: FunctionId | null): void => {
    if (id !== null) implicitEntries.add(id)
  }
  const representations: Representation[] = []
  for (const layout of classes.values()) {
    if (layout.constructor !== null && !constructionBodies.has(layout.constructor)) implicitEntry(layout.constructor)
    for (const field of layout.fields)
      if (field.initializer !== null && !constructionBodies.has(field.initializer)) implicitEntry(field.initializer)
    for (const field of layout.staticFields) implicitEntry(field.initializer)
    for (const method of layout.methods)
      if (method.callable === null || !instanceMethods.has(method.callable)) implicitEntry(method.callable)
    for (const method of layout.staticMethods) implicitEntry(method.callable)
    for (const accessor of layout.accessors)
      for (const id of [accessor.getter, accessor.setter])
        if (id !== null && !instanceAccessors.has(id)) {
          implicitEntry(id)
          implicitAccessorEntries.add(id)
        }
    for (const accessor of layout.staticAccessors)
      for (const id of [accessor.getter, accessor.setter])
        if (id !== null) {
          implicitEntry(id)
          implicitAccessorEntries.add(id)
        }
    if (layout.instance) representations.push(layout.instance)
    for (const field of layout.nativeStorage?.fields ?? []) representations.push(field.value)
  }
  for (const operation of operations) {
    for (const operand of operandsOfIrOperation(operation)) representations.push(operand.representation)
    const result = resultOfIrOperation(operation)
    if (result) representations.push(result.representation)
  }
  const visited = new Set<Representation>()
  let implicitEntriesComplete = true
  for (const representation of representations)
    for (const carrier of walkRepresentation(representation, visited)) {
      if (
        carrier.kind === 'function' &&
        !instanceMethods.has(carrier.functionId) &&
        !instanceAccessors.has(carrier.functionId) &&
        !constructionBodies.has(carrier.functionId)
      )
        implicitEntry(carrier.functionId)
      if (carrier.kind === 'function-family' || carrier.kind === 'function-value-family')
        for (const id of carrier.members)
          if (!instanceMethods.has(id) && !instanceAccessors.has(id) && !constructionBodies.has(id)) implicitEntry(id)
      const layout = carrier.kind === 'native-record-ref' ? deriver?.layoutOf(carrier.shapeId as StructuralTypeId) : carrier
      if (carrier.kind === 'native-record-ref') {
        if (layout) representations.push(layout)
        else implicitEntriesComplete = false
      }
      if (layout?.kind !== 'record') continue
      for (const accessor of layout.accessors) {
        implicitEntry(accessor.getter)
        implicitEntry(accessor.setter)
        if (accessor.getter) implicitAccessorEntries.add(accessor.getter)
        if (accessor.setter) implicitAccessorEntries.add(accessor.setter)
      }
    }
  const deferred = new Set(
    [...new Set([...allocated, ...instanceMethods, ...instanceAccessors, ...constructionBodies])].filter((id) => {
      const body = bodyById.get(id)
      return implicitEntriesComplete && body?.abi != null && body.construct === null && !implicitEntries.has(id)
    })
  )
  const entered = new Set<IrBody>()
  const pendingBodies: IrBody[] = []
  const enter = (id: FunctionId): void => {
    const body = bodyById.get(id)
    if (!body || entered.has(body)) return
    entered.add(body)
    revision++
    pendingBodies.push(body)
  }
  for (const body of bodies) {
    if (deferred.has(body.sourceOwner as FunctionId)) continue
    entered.add(body)
    pendingBodies.push(body)
  }
  const invoke = (id: FunctionId, args: readonly IrOperand[], receiver: OriginCell | null, result: OriginCell | null): void => {
    if (!called.has(id)) revision++
    called.add(id)
    enter(id)
    const frameReceiver = frameReceivers.get(id)
    if (receiver && frameReceiver) link(receiver, frameReceiver)
    for (const parameter of parameters.get(id) ?? []) {
      const incoming = parameter.kind === 'receiver' ? receiver : args[parameter.ordinal] ? value(args[parameter.ordinal]!.value) : null
      if (incoming) link(incoming, value(parameter.result.id))
    }
    const returned = returns.get(id)
    if (result && returned) link(returned, result)
  }
  const pendingCalls: Extract<IrOperation, { kind: 'call' }>[] = []
  const fieldReads: Extract<IrOperation, { kind: 'get' }>[] = []
  const seedMethodValue = (cell: OriginCell, representation: Representation): void => {
    if (representation.kind === 'optional') seedMethodValue(cell, representation.payload)
    else if (representation.kind === 'borrowed-ref') seedMethodValue(cell, representation.referent)
    else if (representation.kind === 'tagged-union') for (const arm of representation.arms) seedMethodValue(cell, arm.value)
    else if (representation.kind === 'function') {
      if (instanceMethods.has(representation.functionId)) addFunction(cell, representation.functionId)
    } else if (representation.kind === 'function-family' || representation.kind === 'function-value-family')
      for (const id of representation.members) if (instanceMethods.has(id)) addFunction(cell, id)
  }
  const processOperation = (operation: IrOperation): void => {
    const result = resultOfIrOperation(operation)
    // A method identity in a carrier describes the value, not an invocation.
    // Publish it when that value is produced/used so ordinary escape edges also
    // cover detached methods without rooting every method in every layout.
    for (const operand of operandsOfIrOperation(operation)) seedMethodValue(value(operand.value), operand.representation)
    if (result) seedMethodValue(value(result.id), result.representation)
    if (operation.kind === 'call' && operation.fixedDataDefinition?.nativeFieldProtocol === 'unused') {
      const recipe = operation.fixedDataDefinition
      const target = operation.arguments[0]
      const descriptor = operation.arguments[2]
      const node = recipe.conversion === null ? null : conversions?.nodeById(recipe.conversion)
      if (
        !target ||
        !descriptor ||
        representationKey(target.representation) !== recipe.target ||
        representationKey(descriptor.representation) !== recipe.descriptor ||
        (recipe.value === null
          ? recipe.attributesOnly === undefined ||
            recipe.conversion !== null ||
            (recipe.attributesOnly.absence === null && recipe.attributesOnly.initialized === null)
          : !node ||
            representationKey(node.source) !== representationKey(recipe.value.value) ||
            representationKey(node.target) !== representationKey(recipe.held))
      ) {
        untrusted(operation)
        return
      }
      if (recipe.value === null) {
        // Attribute changes neither observe nor replace the payload. The
        // independently replayed recipe owns initial presence/Undefined
        // creation, so a field implementation origin is retained as-is.
        if (operation.result) link(value(target.value), value(operation.result.id))
        return
      }
      // This is the same sealed native update reflection and emission consume,
      // not a call to an unknown implementation of Object.defineProperty.
      heapEffect(operation, () => {
        const targets = slotsOf(target, recipe.field.key)
        const sources = slotsOf(descriptor, recipe.value!.key)
        if (targets === null || sources === null) {
          untrusted(operation)
          return true
        }
        for (const destination of targets)
          if (nativePayloadTransportMatches(node!.source, node!.target, node!))
            for (const source of sources) linkPayload(source, destination, [node!.target])
          else if (
            representationKey(node!.source) === representationKey(node!.target) ||
            nativeClassReferenceTransportMatches(node!.source, node!.target, node!) ||
            transportsCallablePrefix(node!.source, node!.target, node!) ||
            nativeCallableIdentityTransportMatches(node!.source, node!.target, node!)
          )
            for (const source of sources) link(source, destination)
          else external(destination, recipe.held, 'unmodeled-native-definition-value')
        return targets.length > 0 && sources.length > 0
      })
      if (operation.result) link(value(target.value), value(operation.result.id))
      for (const operand of operandsOfIrOperation(operation))
        if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
      return
    }
    if (nativeDictionaryTransportOf(operation)) {
      if (operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object') {
        const heap = seedAllocation(operation.result.id, operation.result.representation)[0]
        const entries = heap?.fields.get('')?.cell
        if (!entries) untrusted(operation)
        else if (operation.kind === 'allocate-record') for (const field of operation.fields) link(value(field.value.value), entries)
      } else if (operation.kind === 'get' || operation.kind === 'set' || operation.kind === 'define-own-property') {
        if (operation.kind === 'get') fieldReads.push(operation)
        heapEffect(
          operation,
          () => {
            const slots = slotsOf(operation.receiver, '')
            if (slots === null) {
              untrusted(operation)
              return true
            }
            for (const slot of slots)
              if (operation.kind === 'get') link(slot, value(operation.result.id))
              else link(value(operation.value.value), slot)
            return slots.length > 0
          },
          undefined,
          operation.receiver.value
        )
        // Stores thread the container onward. The assignment expression's RHS
        // already has its own SSA value, as for native class accessor stores.
        if (operation.kind !== 'get' && operation.result)
          if (representationKey(operation.result.representation) === representationKey(operation.receiver.representation))
            link(value(operation.receiver.value), value(operation.result.id))
          else external(value(operation.result.id), operation.result.representation, 'unmodeled-dictionary-store-result')
      }
      // Deletion and existence queries only inspect native entry metadata.
      for (const operand of operandsOfIrOperation(operation))
        if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
      return
    }
    if (operation.kind === 'get' || operation.kind === 'set') {
      const receiver = operation.receiver.representation
      const viewKey = keyOf(operation.key)
      if (nativeFieldViewCarrierNeedsReceipt(receiver, viewShapes) && viewKey !== null) {
        if (operation.kind === 'get') fieldReads.push(operation)
        heapEffect(operation, () => {
          const original = value(operation.receiver.value)
          if (
            operation.kind === 'get' &&
            !original.unknown &&
            original.descriptorSnapshots.size > 0 &&
            ['value', 'writable', 'enumerable', 'configurable'].includes(viewKey)
          ) {
            // A captured descriptor owns a fresh native field table, rather
            // than an ordinary record heap. Losing a field value's identity
            // cannot publish that snapshot or execute the source accessor.
            external(value(operation.result.id), operation.result.representation, 'native-descriptor-snapshot-field')
            return true
          }
          const heaps = heapsAt(operation.receiver, viewKey, operation)
          if (heaps === null) return true
          if (heaps.length === 0) return false
          for (const heap of heaps) {
            const member = heap.declaration === null ? null : classMemberOf(classes, heap.declaration, viewKey)
            if (member?.kind === 'accessor') {
              const callable = operation.kind === 'get' ? member.accessor.getter : member.accessor.setter
              // Missing [[Set]] is an ordinary false result (and strict-mode
              // TypeError); it invokes neither half of this accessor.
              if (callable === null && operation.kind === 'set') continue
              if (callable === null || !bodyById.has(callable)) {
                untrusted(operation)
                return true
              }
              invoke(
                callable,
                operation.kind === 'get' ? [] : [operation.value],
                value(operation.receiver.value),
                operation.kind === 'get' ? value(operation.result.id) : null
              )
            } else if (member?.kind === 'method' && !heap.fields.has(viewKey) && operation.kind === 'get') {
              if (member.method.callable === null || classPrototypeMethodMutableOf(classes, heap.declaration!, viewKey)) {
                untrusted(operation)
                return true
              }
              addFunction(value(operation.result.id), member.method.callable)
            } else {
              const slot = heap.fields.get(viewKey)
              if (!heap.valid || !slot) {
                if (operation.kind === 'get' && originalDescriptorAbsent(operation, viewKey, heap)) continue
                // A read cannot reject its own missing-slot proof before
                // allocation and alias origins have reached the fixed point.
                // Unresolved effects are rejected by the final worklist.
                if (operation.kind === 'get') return false
                untrusted(operation)
                return true
              }
              if (operation.kind === 'get') link(slot.cell, value(operation.result.id))
              else link(value(operation.value.value), slot.cell)
            }
          }
          return true
        })
        if (operation.kind === 'set' && operation.result) link(value(operation.receiver.value), value(operation.result.id))
        return
      }
      const staticCell = nativeConstructorStaticCellOf(operation, keyOf(operation.key), classes, staticSlots, conversions)
      if (staticCell !== null) {
        const slot = staticHeaps.get(staticCell.owner)!.fields.get(staticCell.key)!
        if (operation.kind === 'get') {
          fieldReads.push(operation)
          linkPayload(slot.cell, value(operation.result.id), [operation.result.representation])
        } else {
          linkPayload(value(operation.value.value), slot.cell, [slot.representation])
          if (operation.result) link(value(operation.receiver.value), value(operation.result.id))
        }
        for (const operand of operandsOfIrOperation(operation))
          if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
        return
      }
      const staticEntry = nativeConstructorAccessorEntryOf(operation, keyOf(operation.key), classes, (id) => bodyById.get(id), conversions)
      if (staticEntry !== null) {
        if (operation.kind === 'get') fieldReads.push(operation)
        heapEffect(operation, () => {
          const constructor = value(operation.receiver.value)
          if (constructor.unknown || constructor.escaped) {
            untrusted(operation)
            return true
          }
          if (constructor.heaps.size === 0) return false
          invoke(
            staticEntry.functionId,
            staticEntry.arguments,
            staticEntry.receiver === null ? null : value(staticEntry.receiver.value),
            null
          )
          if (operation.kind === 'get') {
            const returned = returns.get(staticEntry.functionId)
            if (returned) linkPayload(returned, value(operation.result.id), [operation.result.representation])
          } else if (operation.result) link(value(operation.receiver.value), value(operation.result.id))
          return true
        })
        for (const operand of operandsOfIrOperation(operation))
          if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
        return
      }
      const entry = nativeClassAccessorEntryOf(operation, keyOf(operation.key), classes, (id) => bodyById.get(id), conversions)
      if (entry) {
        if (operation.kind === 'get') fieldReads.push(operation)
        invoke(
          entry.functionId,
          entry.arguments,
          value(operation.receiver.value),
          operation.kind === 'get' ? value(operation.result.id) : null
        )
        if (operation.kind === 'set' && operation.result) {
          // A lowered property store threads the receiver onward; the source
          // assignment expression already retains its RHS in a separate SSA.
          const source =
            representationKey(operation.result.representation) === representationKey(operation.receiver.representation)
              ? operation.receiver
              : null
          if (source) link(value(source.value), value(operation.result.id))
          else external(value(operation.result.id), operation.result.representation, 'unmodeled-setter-result')
        }
        for (const operand of operandsOfIrOperation(operation))
          if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
        return
      }
    }
    if (nativeSequenceTransportOf(operation)) {
      if (operation.kind === 'get-iterator') {
        const carried = operation.receiver.representation
        const source = carried.kind === 'optional' ? carried.payload : carried
        if (source.kind === 'array-object' || source.kind === 'iterator' || source.kind === 'record')
          // The cursor retains this allocation's storage, not every container
          // with the same element type. Publication of the cursor still flows
          // back to its source, just as publication of an ordinary alias does.
          link(value(operation.receiver.value), value(operation.result.id))
        else external(value(operation.result.id), operation.result.representation, 'unmodeled-native-sequence-storage')
      } else if (operation.kind === 'iterator-next') {
        const output = value(operation.result.id)
        const unknownResult = (): void => external(output, operation.result.representation, 'unmodeled-native-sequence-element')
        heapEffect(
          operation,
          () => {
            const cursor = value(operation.iterator.value)
            if (cursor.unknown) unknownResult()
            for (const heap of cursor.heaps) {
              if (!heap.valid) {
                unknownResult()
                continue
              }
              const elements = heap.fields.has('') ? [heap.fields.get('')!] : [...heap.fields.values()]
              for (const element of elements) link(element.cell, output)
            }
            return cursor.unknown || cursor.heaps.size > 0
          },
          unknownResult
        )
      }
      // Native stepping/metadata inspection cannot invoke an unknown getter.
      // A missing element origin loses only the result's identity, not the
      // identities of every method stored on the source's objects.
      return
    }
    switch (operation.kind) {
      case 'bind-callable':
        if (operation.sourceFunctionId !== null) addFunction(value(operation.source.value), operation.sourceFunctionId)
        untrusted(operation)
        break
      case 'allocate-callable':
        addFunction(value(operation.result.id), operation.functionId)
        // An ordinary constructor's implicit receiver is not its void return
        // cell. Publication still exposes instances created by external callers.
        if (bodyById.get(operation.functionId)?.construct)
          seedHeaps(value(operation.result.id), bodyById.get(operation.functionId)!.construct!.result)
        break
      case 'allocate-proxy': {
        const heap = seedAllocation(operation.result.id, operation.result.representation)[0]
        if (operation.result.representation.kind !== 'proxy-object' || heap?.proxy !== true) {
          untrusted(operation)
          break
        }
        link(value(operation.target.value), heap.fields.get('target')!.cell)
        link(value(operation.handler.value), heap.fields.get('handler')!.cell)
        break
      }
      case 'proxy-part': {
        heapEffect(operation, () => {
          const proxy = value(operation.proxy.value)
          if (proxy.unknown) {
            untrusted(operation)
            return true
          }
          for (const heap of proxy.heaps) {
            const part = heap.fields.get(operation.part)
            if (
              !heap.valid ||
              heap.proxy !== true ||
              !part ||
              representationKey(part.representation) !== representationKey(operation.result.representation)
            ) {
              untrusted(operation)
              return true
            }
            link(part.cell, value(operation.result.id))
          }
          return proxy.heaps.size > 0
        })
        break
      }
      case 'allocate-constructor': {
        const callable = value(operation.result.id)
        if (!callable.documentBlocked) {
          callable.documentBlocked = true
          changed(callable)
        }
        // Publishing the constructor publishes its future instances too.
        // Its ordinary return cell is void, so that escape cannot be found by
        // following constructor-body returns like an ordinary factory's.
        const heap = classHeaps.get(operation.declaration)
        if (heap) addHeap(value(operation.result.id), heap)
        for (const heap of constructorHeapsOf(operation.declaration)) addHeap(value(operation.result.id), heap)
        const layout = classLayoutOfCopy(classes, operation.declaration)
        if (layout) for (const id of constructionEntriesOf(layout)) addFunction(value(operation.result.id), id)
        break
      }
      case 'constant':
        if (operation.literal !== 'undefined' && operation.literal !== 'null') {
          const cell = value(operation.result.id)
          if (!cell.documentBlocked) {
            cell.documentBlocked = true
            changed(cell)
          }
        }
        break
      case 'parameter':
      case 'jump':
      case 'branch':
      case 'switch':
      case 'test':
      case 'proxy-arm-test':
      case 'proxy-trap-check':
        break
      case 'receiver': {
        const receiver = frameReceivers.get(owner.get(operation)!)
        if (receiver) link(receiver, value(operation.result.id))
        break
      }
      case 'allocate-ordinary-object':
      case 'allocate-record': {
        const references = nativeReferences(operation.result.representation)
        seedAllocation(operation.result.id, operation.result.representation, undefined, operation.ordinaryObjectPrototype === true)
        if (!references.complete || references.heaps.length !== 1 || !references.heaps[0]!.valid) {
          untrusted(operation)
          break
        }
        for (const field of operation.kind === 'allocate-record' ? operation.fields : []) {
          const slots = slotsOf({ value: operation.result.id, representation: operation.result.representation }, field.key)
          if (slots) for (const slot of slots) link(value(field.value.value), slot)
          else untrusted(operation)
        }
        break
      }
      case 'allocate-array-object': {
        const heap = seedAllocation(operation.result.id, operation.result.representation)[0]
        const elements = heap?.fields.get('')?.cell
        if (!elements || !nativeArrayTransportOf(operation, null)) {
          untrusted(operation)
          break
        }
        for (const slot of operation.elements) {
          if (slot.kind === 'element') link(value(slot.value.value), elements)
          else if (slot.kind === 'spread') {
            heapEffect(
              operation,
              () => {
                const sources = slotsOf(slot.value, '')
                if (sources === null) {
                  untrusted(operation)
                  return true
                }
                for (const source of sources) link(source, elements)
                return sources.length > 0
              },
              undefined,
              slot.value.value
            )
          }
        }
        break
      }
      case 'binding-write':
        link(value(operation.value.value), binding(operation.declaration))
        if (!['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? ''))
          markEscaped(value(operation.value.value), undefined, [operation])
        break
      case 'binding-read':
        link(binding(operation.declaration), value(operation.result.id))
        if (!['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? ''))
          external(value(operation.result.id), operation.result.representation)
        if (operation.closedCallable)
          for (const id of operation.closedCallable.kind === 'exact'
            ? [operation.closedCallable.functionId]
            : operation.closedCallable.functionIds)
            addFunction(value(operation.result.id), id)
        break
      case 'phi':
        for (const incoming of operation.incoming) link(value(incoming.value.value), value(operation.result.id))
        break
      case 'return':
        if (operation.value) link(value(operation.value.value), returns.get(owner.get(operation)!)!)
        break
      case 'get': {
        const privateSlot = operation.privateNativeCallableSlot
        if (privateSlot && representationKey(privateSlot.value.representation) === representationKey(operation.result.representation)) {
          link(value(privateSlot.value.value), value(operation.result.id))
          break
        }
        if (insertionReads.has(operation)) break
        if (operation.logicalReceiver === 'ignored') {
          markIgnoredLogicalReceiver(value(operation.result.id))
          break
        }
        if (operation.logicalReceiver === 'native' || operation.logicalReceiver === 'dynamic')
          markLogicalReceiver(value(operation.result.id), operation.logicalReceiver === 'dynamic')
        if ((operation.methodValueRecipes?.length ?? 0) > 0)
          markLogicalReceiver(
            value(operation.result.id),
            operation.methodValueRecipes!.some((recipe) => {
              const node = conversions?.nodeById(recipe.conversion)
              return (
                node !== undefined &&
                node !== null &&
                'materializer' in node.capability &&
                node.capability.materializer.nativeMethod?.receiver.kind === 'dynamic'
              )
            })
          )
        const key = keyOf(operation.key)
        const staticMethods = nativeConstructorMethodBodiesOf(operation, key, classes, operations, placements)
        if (staticMethods !== null) {
          for (const callable of staticMethods) addFunction(value(operation.result.id), callable)
          break
        }
        if (nativeArrayTransportOf(operation, key)) {
          if (key !== 'length') {
            fieldReads.push(operation)
            heapEffect(
              operation,
              () => {
                const sources = slotsOf(operation.receiver, '')
                if (sources === null) {
                  untrusted(operation)
                  return true
                }
                for (const source of sources) link(source, value(operation.result.id))
                return sources.length > 0
              },
              undefined,
              operation.receiver.value
            )
          }
          break
        }
        if (key !== null && slotTemplatesOf(operation.receiver.representation, key) !== null) {
          fieldReads.push(operation)
          heapEffect(
            operation,
            () => {
              const receiver = value(operation.receiver.value)
              if (
                !receiver.unknown &&
                receiver.descriptorSnapshots.size > 0 &&
                ['value', 'writable', 'enumerable', 'configurable'].includes(key)
              ) {
                // Captured descriptor fields are native data on a new object.
                // Their value's identity may be unknown without exposing the
                // snapshot owner or invoking the original accessor.
                external(value(operation.result.id), operation.result.representation, 'native-descriptor-snapshot-field')
                return true
              }
              const sources = slotsOf(operation.receiver, key, operation)
              if (sources === null) {
                untrusted(operation)
                return true
              }
              for (const source of sources) link(source, value(operation.result.id))
              return sources.length > 0
            },
            undefined,
            operation.receiver.value
          )
        } else if (operation.closedCallable) {
          for (const id of operation.closedCallable.kind === 'exact'
            ? [operation.closedCallable.functionId]
            : operation.closedCallable.functionIds)
            addFunction(value(operation.result.id), id)
        } else untrusted(operation)
        break
      }
      case 'set':
      case 'define-own-property': {
        if (
          operation.kind === 'set' &&
          conversions !== undefined &&
          nativeCallablePrimitiveDataWritePreservesOwner(operation, conversions, (id) => producers.get(id))
        ) {
          // The receipt models a data-only primitive store, not a call or an
          // owner publication. Retain the incoming identity without creating
          // one or clearing an earlier unknown/publication edge.
          if (operation.result) {
            const returned =
              representationKey(operation.result.representation) === representationKey(operation.receiver.representation)
                ? operation.receiver
                : representationKey(operation.result.representation) === representationKey(operation.value.representation)
                  ? operation.value
                  : null
            if (returned) link(value(returned.value), value(operation.result.id))
            else untrusted(operation)
          }
          break
        }
        if (operation.kind === 'set' && operation.privateNativeCallableSlot) {
          if (operation.result) link(value(operation.receiver.value), value(operation.result.id))
          break
        }
        const key = keyOf(operation.key)
        const staticCell = nativeConstructorStaticCellOf(operation, key, classes, staticSlots, conversions)
        if (staticCell !== null) {
          const slot = staticHeaps.get(staticCell.owner)!.fields.get(staticCell.key)!
          linkPayload(value(operation.value.value), slot.cell, [slot.representation])
          if (operation.result) link(value(operation.receiver.value), value(operation.result.id))
          break
        }
        if (operation.kind === 'set' && nativeArrayTransportOf(operation, key)) {
          if (key !== 'length')
            heapEffect(
              operation,
              () => {
                const targets = slotsOf(operation.receiver, '')
                if (targets === null) {
                  untrusted(operation)
                  return true
                }
                for (const target of targets) link(value(operation.value.value), target)
                return targets.length > 0
              },
              undefined,
              operation.receiver.value
            )
          if (operation.result && representationKey(operation.result.representation) === representationKey(operation.value.representation))
            link(value(operation.value.value), value(operation.result.id))
          break
        }
        if (key !== null && slotTemplatesOf(operation.receiver.representation, key) !== null) {
          heapEffect(
            operation,
            () => {
              const targets = slotsOf(operation.receiver, key, operation)
              if (targets === null) {
                untrusted(operation)
                return true
              }
              for (const target of targets) link(value(operation.value.value), target)
              return targets.length > 0
            },
            undefined,
            operation.receiver.value
          )
          if (
            operation.result &&
            representationKey(operation.result.representation) ===
              representationKey(operation.kind === 'set' ? operation.value.representation : operation.receiver.representation)
          )
            link(value(operation.kind === 'set' ? operation.value.value : operation.receiver.value), value(operation.result.id))
        } else untrusted(operation)
        break
      }
      case 'dead-logical-merge-value':
        // It has no normal value or observation. Certification authenticates
        // its exact impossible falsy edge; prior evaluation remains in IR.
        break
      case 'merge-live-arm-rebuild': {
        const source = operation.source.representation
        const payload = source.kind === 'optional' ? source.payload : source
        if (!conversions || payload.kind !== 'tagged-union' || !nativeMergePayloadTransportMatches(operation, conversions)) {
          untrusted(operation)
          break
        }
        // A live source arm and the destination must both admit an allocation.
        // Neither a discarded arm nor a type alone supplies a new origin.
        const live = fresh()
        linkPayload(
          value(operation.source.value),
          live,
          operation.liveArms.map((index) => payload.arms[index]!.value)
        )
        linkPayload(live, value(operation.result.id), [operation.result.representation])
        break
      }
      case 'convert': {
        const node = conversions?.nodeById(operation.conversionUse)
        const from = operation.source.representation
        const to = operation.result.representation
        // A Value injected into a union's own `dynamic` arm stays in that arm:
        // it is dispatched by its own [[Get]], never through an installed
        // Document entry protocol, so it does not withdraw the protocol every
        // value reaching the union's Document arm still carries.
        const dynamicArm =
          from.kind === 'dynamic' &&
          to.kind === 'tagged-union' &&
          node?.capability.kind === 'atom' &&
          node.capability.materializer.id === NATIVE_SUM_MATERIALIZER &&
          to.arms.some((arm) => representationKey(arm.value) === representationKey(from))
        if (dynamicArm) documentNeutralCells.add(value(operation.result.id))
        if (
          node &&
          nativeFieldViewIdentityTransportOf(node) &&
          representationKey(node.source) === representationKey(from) &&
          representationKey(node.target) === representationKey(to)
        ) {
          const cell = value(operation.result.id)
          if (!cell.fieldViews.has(node.id)) {
            cell.fieldViews.add(node.id)
            changed(cell)
          }
        }
        const document = node === null || node === undefined ? null : nativeDocumentEntryViewOf(node, conversions?.nodeById)
        if (
          document !== null &&
          node !== null &&
          node !== undefined &&
          representationKey(node.source) === representationKey(from) &&
          representationKey(node.target) === representationKey(to)
        ) {
          const cell = value(operation.result.id)
          cell.documentInstalled = true
          cell.documentBlocked = false
          if (!cell.documents.has(node.id)) {
            cell.documents.set(node.id, document)
            changed(cell)
          }
        }
        if (
          node !== undefined &&
          node !== null &&
          node.capability.kind !== 'never' &&
          representationKey(node.source) === representationKey(from) &&
          representationKey(node.target) === representationKey(to)
        ) {
          if (conversions && nativeArrayRootViewPlansOf(node, conversions.nodeById).length > 0) {
            const cell = value(operation.result.id)
            if (!cell.arrayViews.has(node.id)) {
              cell.arrayViews.add(node.id)
              changed(cell)
            }
          }
          const materializer = 'materializer' in node.capability ? node.capability.materializer : null
          if (materializer?.nativeMethod !== undefined)
            markLogicalReceiver(value(operation.result.id), materializer.nativeMethod.receiver.kind === 'dynamic')
          const callable = to.kind === 'optional' ? abiOfCallee(to.payload) : abiOfCallee(to)
          if (from.kind === 'dynamic' && callable?.receiver === null) markLogicalReceiver(value(operation.result.id), true)
          // A checked dynamic record product builds its callable members with
          // DynamicCarrier::in. Exact native class projections do not rebuild
          // their fields and therefore introduce no adapter provenance.
          if (
            from.kind === 'dynamic' &&
            (to.kind === 'record' || to.kind === 'record-with-index' || (to.kind === 'native-record-ref' && to.native === null))
          ) {
            for (const heap of nativeReferences(to).heaps)
              for (const slot of heap.fields.values()) {
                const field = slot.representation.kind === 'optional' ? slot.representation.payload : slot.representation
                if (abiOfCallee(field)?.receiver === null) markLogicalReceiver(slot.cell, true)
              }
          }
        }
        const native =
          node?.capability.kind === 'identity' ||
          ((node?.capability.kind === 'atom' || node?.capability.kind === 'static') &&
            node.capability.materializer.nativeFieldProtocol === 'unused')
        // Payload identity and the executable entry frame are independent proofs.
        // Register the frame even when native payload transfer wins below.
        const callableEntry = transportsCallablePrefix(from, to, node)
        const products = nativeRecordProductsOf(node).filter((product) => representationKey(product.source) === representationKey(from))
        if (
          products.length > 0 &&
          node &&
          representationKey(node.source) === representationKey(from) &&
          representationKey(node.target) === representationKey(to) &&
          (from.kind === 'record' || from.kind === 'native-record-ref') &&
          from.ownership === 'owned'
        ) {
          const heaps = seedAllocation(
            operation.result.id,
            to,
            products.map((plan) => plan.target),
            true
          )
          for (const product of products)
            for (const field of product.fields) {
              if (!field.identity) continue
              heapEffect(operation, () => {
                const inputs = slotsOf(operation.source, field.key)
                if (inputs === null) return true
                for (const heap of heaps)
                  if (heap.template === recordHeapOf(product.target)) {
                    const slot = heap.fields.get(field.key)
                    if (slot) for (const input of inputs) link(input, slot.cell)
                  }
                return inputs.length > 0
              })
            }
        } else if (nativePayloadTransportMatches(from, to, node))
          linkPayload(value(operation.source.value), value(operation.result.id), [to])
        else if (
          representationKey(from) === representationKey(to) ||
          nativeClassReferenceTransportMatches(from, to, node) ||
          nativeFieldViewIdentityTransportOf(node) ||
          (conversions !== undefined && nativeArrayViewIdentityTransportOf(node, conversions.nodeById)) ||
          callableEntry ||
          nativeGenericSelectorMatches(from, to, node) ||
          nativeCallableIdentityTransportMatches(from, to, node) ||
          nativeCallableDynamicIdentityTransportMatches(from, to, node) ||
          (native && (from.kind === 'undefined' || from.kind === 'null') && to.kind === 'dynamic') ||
          (native && abiOfCallee(from) !== null && abiOfCallee(to) !== null && abiKey(abiOfCallee(from)!) === abiKey(abiOfCallee(to)!))
        )
          link(value(operation.source.value), value(operation.result.id))
        else {
          const destinations =
            conversions === undefined ||
            node === null ||
            node === undefined ||
            representationKey(node.source) !== representationKey(from) ||
            representationKey(node.target) !== representationKey(to)
              ? null
              : dynamicResultCarriersOf(node, conversions.nodeById)
          untrusted(operation, destinations ?? undefined, undefined, dynamicArm)
        }
        break
      }
      case 'construct': {
        const branches = nativeClassConstructionOf(operation, classes, (id) => bodyById.get(id), conversions)
        if (branches !== null) {
          const heaps = seedAllocation(operation.result.id, operation.result.representation)
          for (const branch of branches) {
            const receiver = fresh()
            for (const heap of heaps) if (heap.declaration === branch.declaration) addHeap(receiver, heap)
            for (const entry of branch.entries) invoke(entry.functionId, entry.arguments, receiver, null)
          }
          break
        }
        const target = operation.target
        const constructor = target.kind === 'exact' && target.target.kind === 'function' ? target.target.functionId : null
        const layout =
          constructor !== null
            ? classLayoutsConstructedBy(classes, constructor)[0]
            : target.kind === 'exact' && target.target.kind === 'implicit-source-constructor'
              ? classLayoutOfCopy(classes, target.target.classDeclaration)
              : undefined
        const ordinaryBody = constructor === null ? null : bodyById.get(constructor)
        const ordinaryEntry = layout === undefined ? explicitObjectConstructEntryOf(operation, ordinaryBody?.abi ?? null) : undefined
        if (ordinaryEntry && constructMatchesAbi(operation, ordinaryEntry.abi, conversions)) {
          invoke(ordinaryEntry.functionId, operation.arguments, null, value(operation.result.id))
          break
        }
        if (layout === undefined && ordinaryBody && ordinaryConstructBodyMatches(operation, ordinaryBody, conversions)) {
          seedAllocation(operation.result.id, operation.result.representation)
          invoke(constructor!, operation.arguments, ordinaryBody.abi!.receiver === null ? null : value(operation.result.id), null)
          break
        }
        const entries =
          layout?.construct &&
          operation.callee.value === operation.newTarget.value &&
          constructMatchesAbi(operation, layout.construct, conversions)
            ? nativeClassInitializationOf(layout, operation.arguments, classes, (id) => bodyById.get(id), conversions)
            : null
        if (entries !== null) {
          seedAllocation(operation.result.id, operation.result.representation)
          for (const entry of entries) invoke(entry.functionId, entry.arguments, value(operation.result.id), null)
        } else untrusted(operation)
        break
      }
      case 'super-initialize': {
        const id = owner.get(operation)!
        const entries = nativeSuperInitializationOf(operation, bodyById.get(id), classes, (entry) => bodyById.get(entry), conversions)
        const receiver = frameReceivers.get(id)
        if (entries === null || !receiver) untrusted(operation)
        else for (const entry of entries) invoke(entry.functionId, entry.arguments, receiver, null)
        break
      }
      case 'has-property':
      case 'own-property-keys':
      case 'get-iterator':
        if (!nativeKeyQueryOf(operation, nativePropertyLayoutOf)) untrusted(operation)
        break
      case 'call':
        if (operation.nativeArrayDescriptorReinstallation) {
          if (operation.result) link(value(operation.nativeArrayDescriptorReinstallation.receiver.value), value(operation.result.id))
          break
        }
        if (operation.nativeArrayDescriptorSnapshot && operation.result) {
          const node = conversions?.nodeById(operation.nativeArrayDescriptorSnapshot.conversion)
          if (
            node &&
            'materializer' in node.capability &&
            node.capability.materializer.nativeDescriptorSnapshot &&
            representationKey(node.target) === representationKey(operation.result.representation)
          ) {
            const snapshot = value(operation.result.id)
            snapshot.descriptorSnapshots.add(operation.result.id)
            changed(snapshot)
            break
          }
        }
        if (nativeCarrierPredicateOf(operation)) break
        if (operation.intrinsicReturnIdentity === 'argument0' && operation.result && !operation.argumentsAreSpread) {
          const original = operation.arguments[0]
          if (original !== undefined && representationKey(original.representation) === representationKey(operation.result.representation)) {
            if (
              operation.intrinsicIntegrity !== undefined &&
              ![...walkRepresentation(original.representation)].some((value) => value.kind === 'proxy-object') &&
              (abiOfCallee(original.representation) !== null || nativeReferences(original.representation).complete)
            )
              link(value(original.value), value(operation.result.id))
            else untrusted(operation, undefined, original)
            break
          }
        }
        if (arrayInsertions.has(operation) && insertionReads.has(arrayInsertions.get(operation)!.read)) {
          const insertion = arrayInsertions.get(operation)!
          if (insertion.conversion) transportsCallablePrefix(insertion.source, insertion.target, insertion.conversion)
          heapEffect(operation, () => {
            const sources = slotsOf(insertion.packed, '')
            const targets = slotsOf(insertion.receiver, '')
            if (sources === null || targets === null) {
              untrusted(operation)
              return true
            }
            for (const source of sources)
              for (const target of targets)
                if (insertion.conversion && nativePayloadTransportMatches(insertion.source, insertion.target, insertion.conversion))
                  linkPayload(source, target, [insertion.target])
                else link(source, target)
            return sources.length > 0 && targets.length > 0
          })
          break
        }
        if (!nativeKeyQueryOf(operation, nativePropertyLayoutOf)) {
          // A call's citation is an execution edge of its containing body,
          // not a root. Opening it before frame matching is conservative;
          // failed matching subsequently publishes unknown inputs above.
          for (const id of citedEntriesOf(operation)) enter(id)
          if (operation.closedCallee)
            for (const id of operation.closedCallee.kind === 'exact'
              ? [operation.closedCallee.functionId]
              : operation.closedCallee.functionIds)
              addFunction(value(operation.callee.value), id)
          pendingCalls.push(operation)
        }
        break
      case 'compute':
        if (observesNativeCarrierOnly(operation)) {
          if (
            operation.form === 'require-object-coercible' ||
            operation.form === 'require-iterable-present' ||
            operation.form === 'require-tagged-union-arm'
          ) {
            const source = operation.operands[0]
            if (source) link(value(source.value), value(operation.result.id))
          }
          break
        }
        untrusted(operation)
        break
      default:
        untrusted(operation)
    }
    // An SSA operand without a producer cannot be invented by this analysis.
    for (const operand of operandsOfIrOperation(operation)) {
      if (!producers.has(operand.value)) external(value(operand.value), operand.representation)
    }
  }
  const escapedFunctions = new Set<FunctionId>()
  const escapedHeaps = new Set<NativeHeap>()
  const observedProxies = new Map<NativeHeap, string>()
  const observeProxy = (heap: NativeHeap, reason: string): void => {
    const target = heap.fields.get('target')
    const handler = heap.fields.get('handler')
    if (!target || !handler) return
    // [[ProxyHandler]] is an internal slot. Observing the Proxy can execute
    // its traps and expose their answers, but cannot replace handler fields.
    // A returned `this` or captured handler still exposes that ordinary heap
    // through the source body's return edges below.
    escape(target.cell, reason)
    for (const origin of handler.cell.heaps) {
      if (!origin.valid || origin.template?.valid === false) {
        external(handler.cell, handler.representation, reason)
        continue
      }
      // Open every callable field conservatively: an external observation may
      // invoke a trap outside the fixed native Get/Set/Has/Delete lowering.
      for (const trap of origin.fields.values()) {
        for (const id of trap.cell.functions) {
          const body = bodyById.get(id)
          if (!body?.abi) continue
          if (!called.has(id)) revision++
          called.add(id)
          enter(id)
          const receiver = frameReceivers.get(id)
          if (body.abi.receiver !== null) {
            if (receiver && representationKey(body.abi.receiver) === representationKey(handler.representation)) link(handler.cell, receiver)
            else external(handler.cell, handler.representation, reason)
          }
          for (const parameter of parameters.get(id) ?? [])
            if (parameter.kind !== 'receiver') external(value(parameter.result.id), parameter.result.representation, reason)
          const returned = returns.get(id)
          if (returned) escape(returned, reason)
        }
      }
    }
  }
  const matchedCalls = new Set<IrOperation>()
  const visitedCallTargets = new Map<IrOperation, Set<FunctionId>>()
  const unknownCalls = new Set<IrOperation>()
  const settle = (): void => {
    for (;;) {
      const before = revision
      while (pendingBodies.length > 0) {
        const body = pendingBodies.pop()!
        for (const block of body.blocks.values())
          for (const operation of [...block.operations, block.terminator]) processOperation(operation)
      }
      for (const [heap, reason] of observedProxies) observeProxy(heap, reason)
      for (const effect of heapEffects) effect.apply()
      // Conflicting physical views and unsupported record protocols cannot
      // retain facts inferred through an earlier plain view of the same shape.
      for (const heap of recordHeaps.values())
        if (!heap.valid) for (const slot of heap.fields.values()) external(slot.cell, slot.representation, 'unproven-record-layout')
      for (const heap of arrayHeaps.values())
        if (!heap.valid) for (const slot of heap.fields.values()) external(slot.cell, slot.representation, 'unproven-array-storage')
      while (pendingCells.length > 0) {
        const cell = popCell()
        sweepIndex = cell.index
        for (const [target, allowed] of cell.edges) {
          for (const id of cell.fieldViews)
            if (!target.fieldViews.has(id)) {
              target.fieldViews.add(id)
              changed(target)
            }
          for (const id of cell.descriptorSnapshots)
            if (!target.descriptorSnapshots.has(id)) {
              target.descriptorSnapshots.add(id)
              changed(target)
            }
          for (const id of cell.arrayViews)
            if (!target.arrayViews.has(id)) {
              target.arrayViews.add(id)
              changed(target)
            }
          if (!target.documentInstalled) {
            if (cell.documentBlocked && !target.documentBlocked && !documentNeutralCells.has(target)) {
              target.documentBlocked = true
              changed(target)
            }
            for (const [id, entry] of cell.documents)
              if (!target.documents.has(id)) {
                target.documents.set(id, entry)
                changed(target)
              }
          }
          for (const id of cell.functions) addFunction(target, id)
          // A layout filter bounds which allocations a payload transport can
          // carry, but a value an installed live view produced is a view whose
          // origin is any allocation of another layout: `ContextLike | null`
          // holding a class instance behind a record view. Dropping that origin
          // left the record arm the sole implementation of a field it never held.
          for (const heap of cell.heaps)
            if (allowed === null || cell.fieldViews.size > 0 || heapAdmitted(heap, allowed)) addHeap(target, heap)
          if (cell.unknown) {
            const admitted =
              cell.unknownHeaps === null
                ? undefined
                : [...cell.unknownHeaps].filter((heap) => allowed === null || heapAdmitted(heap, allowed))
            // Unknown allocation origins survive a checked Document view, but
            // its exact installed entry protocol still follows every alias.
            // An independent uninstalled incoming source blocks it above.
            if (allowed === null || admitted === undefined || admitted.length > 0)
              markUnknown(
                target,
                cell.unknownReason,
                admitted,
                (!cell.documentBlocked && cell.documents.size > 0) || documentNeutralCells.has(cell) || documentNeutralCells.has(target)
              )
          }
          if (cell.logicalReceiver) markLogicalReceiver(target, cell.dynamicReceiver)
          if (cell.ignoresLogicalReceiver) markIgnoredLogicalReceiver(target)
          // Publication of an alias is publication of its sources too.
          if (target.escaped) absorbEscape(cell, target)
        }
        if (!cell.unknown && !cell.escaped) continue
        for (const id of cell.functions) {
          if (escapedFunctions.has(id)) continue
          escapedFunctions.add(id)
          enter(id)
          const reason = `external-entry:${id}:${cell.unknownReason ?? cell.escapeReason ?? 'publication'}`
          externalEntry(id, reason)
          for (const layout of classes.values())
            if (layout.constructor === id) for (const entry of constructionEntriesOf(layout)) externalEntry(entry, reason)
        }
        for (const heap of cell.heaps) {
          if (escapedHeaps.has(heap)) continue
          escapedHeaps.add(heap)
          if (heap.proxy === true) {
            const reason = cell.unknownReason ?? cell.escapeReason ?? 'external-proxy'
            observedProxies.set(heap, reason)
            observeProxy(heap, reason)
            continue
          }
          if (heap.template !== undefined)
            for (const summary of familyOf(heap.template))
              for (const [key, slot] of heap.fields) {
                const externalSlot = summary.fields.get(key)
                if (!externalSlot) continue
                // Once published, an external return/parameter may alias this
                // allocation. Writes through either view must reach the other.
                link(slot.cell, externalSlot.cell)
                link(externalSlot.cell, slot.cell)
              }
          for (const candidate of familyOf(heap)) {
            // Unknown observers can call prototype methods as well as values
            // stored in own fields. Opening these entries is what makes method
            // deferral safe after publication, including base-typed aliases.
            const methodLayouts = candidate.declaration === null ? [] : methodLayoutsOf(candidate.declaration)
            for (const layout of methodLayouts) {
              // An instance observer can recover its constructor and mutate the same static cells.
              for (const heap of constructorHeapsOf(layout.declaration))
                for (const slot of heap.fields.values()) external(slot.cell, slot.representation, 'external-instance-constructor-static')
              // An observer can recover a native instance's constructor from
              // its prototype and create another instance. Deferring the
              // constructor must not hide those future initializer effects.
              for (const id of constructionEntriesOf(layout))
                externalEntry(id, cell.unknownReason ?? cell.escapeReason ?? 'external-instance-constructor')
              for (const accessor of layout.accessors)
                for (const id of [accessor.getter, accessor.setter])
                  if (id !== null) externalEntry(id, cell.unknownReason ?? cell.escapeReason ?? 'external-instance-accessor')
              for (const method of layout.methods) {
                if (method.callable === null) continue
                const reason = cell.unknownReason ?? cell.escapeReason ?? 'external-method-receiver'
                externalEntry(method.callable, reason)
              }
            }
            for (const slot of candidate.fields.values())
              external(slot.cell, slot.representation, cell.unknownReason ?? cell.escapeReason ?? 'external-heap')
          }
        }
      }
      sweepIndex = null
      for (const cell of nextSweep) pushCell(cell)
      nextSweep.length = 0
      for (const operation of pendingCalls) {
        const callee = value(operation.callee.value)
        if (callee.unknown) {
          if (operation.callee.representation.kind === 'generic-function-set') matchedCalls.delete(operation)
          if (!unknownCalls.has(operation)) {
            unknownCalls.add(operation)
            untrusted(operation)
          }
          continue
        }
        let visited = visitedCallTargets.get(operation)
        if (!visited) visitedCallTargets.set(operation, (visited = new Set()))
        if (operation.callee.representation.kind === 'generic-function-set') {
          const entries = nativeGenericCallEntriesOf(operation, callee.functions, (id) => bodyById.get(id), conversions)
          if (entries === null) {
            matchedCalls.delete(operation)
            continue
          }
          matchedCalls.add(operation)
          for (const entry of entries) {
            if (visited.has(entry.functionId)) continue
            visited.add(entry.functionId)
            invoke(entry.functionId, entry.arguments, null, operation.result ? value(operation.result.id) : null)
          }
          continue
        }
        for (const id of callee.functions) {
          // Frame compatibility is immutable. Once linked, argument and
          // return edges carry future origins without re-invoking the site.
          if (visited.has(id)) continue
          visited.add(id)
          const abi = bodyById.get(id)?.abi
          const held = abiOfCallee(operation.callee.representation)
          // Only an observed, certified native adapter can enter the original
          // body through its public held frame. All
          // identity propagation into this cell already crossed proven edges.
          const adaptedReceiver = abi && held ? adaptedReceiverOf(abi, held) : null
          const adaptsFrame = adaptedReceiver !== null
          const argumentsForBody = adaptsFrame && abi ? operation.arguments.slice(0, abi.parameters.length) : operation.arguments
          if (
            !abi ||
            !held ||
            operation.argumentsAreSpread ||
            (abiKey(held) !== abiKey(abi) && !adaptsFrame) ||
            !nativeArgumentsMatch(abi, argumentsForBody, conversions) ||
            (held.receiver === null
              ? operation.receiver !== null
              : operation.receiver === null || representationKey(held.receiver) !== representationKey(operation.receiver.representation))
          ) {
            untrusted(operation)
            continue
          }
          matchedCalls.add(operation)
          const incomingReceiver = adaptedReceiver === 'logical' ? (operation.thisArgument ?? operation.receiver) : operation.receiver
          let receiverForBody = abi.receiver !== null && incomingReceiver ? value(incomingReceiver.value) : null
          if (
            receiverForBody &&
            abi.receiver &&
            incomingReceiver &&
            (adaptedReceiver === 'logical' || representationKey(abi.receiver) !== representationKey(incomingReceiver.representation))
          ) {
            const adaptedReceiver = fresh()
            linkPayload(receiverForBody, adaptedReceiver, [abi.receiver])
            receiverForBody = adaptedReceiver
          }
          invoke(id, argumentsForBody, receiverForBody, operation.result ? value(operation.result.id) : null)
        }
      }
      // Heap effects observe receiver origins from the preceding propagation
      // sweep. Repeat after any mutation, even when every queued cell was
      // already visited, so those new origins receive their field edges.
      if (revision === before && pendingCells.length === 0 && pendingBodies.length === 0) break
    }
  }
  settle()
  // Unknown calls can expose another stored callable, opening another body and
  // its calls. Exhaust that worklist before publishing any closed identities.
  const rejectedCalls = new Set<IrOperation>()
  const rejectedHeapEffects = new Set<IrOperation>()
  for (const [id, inputs] of parameters) {
    if (!called.has(id) && !deferred.has(id)) {
      const receiver = frameReceivers.get(id)
      const representation = bodyById.get(id)?.abi?.receiver
      if (receiver && representation) external(receiver, representation, `unentered-body:${id}`)
      for (const input of inputs) external(value(input.result.id), input.result.representation, `unentered-body:${id}`)
      const returned = returns.get(id)
      if (returned) escape(returned, `unentered-body:${id}`)
    }
    // Property access invokes an accessor without an ordinary call/return edge
    // in this graph. Its returned functions and containing objects must stay
    // observable even if another, explicit call to that accessor was counted.
    if (implicitAccessorEntries.has(id)) {
      const returned = returns.get(id)
      if (returned) escape(returned, `implicit-accessor-return:${id}`)
    }
  }
  for (;;) {
    for (const operation of pendingCalls) {
      if (matchedCalls.has(operation) || rejectedCalls.has(operation)) continue
      rejectedCalls.add(operation)
      untrusted(operation)
    }
    for (const effect of heapEffects) {
      if (effect.apply() || rejectedHeapEffects.has(effect.operation)) continue
      rejectedHeapEffects.add(effect.operation)
      if (effect.reject) effect.reject()
      else untrusted(effect.operation)
    }
    settle()
    if (
      pendingCalls.every((operation) => matchedCalls.has(operation) || rejectedCalls.has(operation)) &&
      heapEffects.every((effect) => rejectedHeapEffects.has(effect.operation) || effect.apply())
    )
      break
  }
  const result = new Map<IrValueId, CallCalleeIdentity>()
  // Presence is checked by the later optional conversion. This fact names
  // possible implementations, never a physical call ABI or a non-null value.
  const hasCallablePayload = (representation: Representation): boolean =>
    representation.kind === 'optional' ? hasCallablePayload(representation.payload) : abiOfCallee(representation) !== null
  for (const read of fieldReads) {
    const cell = value(read.result.id)
    if (trace && hasCallablePayload(read.result.representation) && (cell.unknown || cell.functions.size === 0))
      trace(read, cell.unknownReason ?? 'no-implementation-source')
    if (cell.unknown || cell.functions.size === 0 || !hasCallablePayload(read.result.representation)) continue
    const ids = [...cell.functions]
    if (ids.some((id) => !bodyById.get(id)?.abi)) continue
    result.set(read.result.id, ids.length === 1 ? { kind: 'exact', functionId: ids[0]! } : { kind: 'closed-family', functionIds: ids })
  }
  const logicalReceiverValues = new Set<IrValueId>()
  const dynamicReceiverValues = new Set<IrValueId>()
  const ignoredLogicalReceiverValues = new Set<IrValueId>()
  // Retained specializations must certify their executable entry metadata
  // even when this program never enters their bodies. This source-authenticated
  // Get contract does not execute the read or seed dormant heap/call effects.
  // Certification independently replays the exact host property contract.
  for (const operation of operations)
    if (operation.kind === 'get' && operation.logicalReceiver === 'ignored') ignoredLogicalReceiverValues.add(operation.result.id)
  const sourceIgnoresLogicalReceiver = (id: FunctionId): boolean => {
    const variants = physicalBodiesBySource.get(id)
    return variants !== undefined && variants.length > 0 && variants.every(nativeBodyIgnoresLogicalReceiver)
  }
  for (const [id, cell] of values) {
    const bodiesReceive = [...cell.functions].some((functionId) => bodyById.get(functionId)?.abi?.receiver != null)
    if (cell.logicalReceiver || bodiesReceive) logicalReceiverValues.add(id)
    if (cell.dynamicReceiver) dynamicReceiverValues.add(id)
    if (
      !cell.unknown &&
      (cell.functions.size > 0 || cell.ignoresLogicalReceiver) &&
      [...cell.functions].every(sourceIgnoresLogicalReceiver)
    )
      ignoredLogicalReceiverValues.add(id)
  }
  // A result or finite-arity adapter can lose executable-body provenance
  // while retaining its source's logical receiver contract. Grow that
  // positive contract through admitted conversions and complete SSA joins;
  // neither a public nil ABI nor one ignored arm licenses an unknown source.
  const localWrites = new Map<DeclarationId, IrValueId[]>()
  for (const operation of operations)
    if (operation.kind === 'binding-write') {
      const writes = localWrites.get(operation.declaration) ?? []
      writes.push(operation.value.value)
      localWrites.set(operation.declaration, writes)
    }
  let changedReceiverContract = true
  while (changedReceiverContract) {
    changedReceiverContract = false
    for (const operation of operations) {
      const result = resultOfIrOperation(operation)
      if (!result || ignoredLogicalReceiverValues.has(result.id)) continue
      const sourceIgnores = (source: IrValueId): boolean => ignoredLogicalReceiverValues.has(source)
      let ignored = false
      if (operation.kind === 'convert')
        ignored =
          sourceIgnores(operation.source.value) &&
          nativeCallableLogicalReceiverTransportMatches(
            operation.source.representation,
            operation.result.representation,
            conversions?.nodeById(operation.conversionUse)
          )
      else if (operation.kind === 'phi')
        ignored = operation.incoming.length > 0 && operation.incoming.every((incoming) => sourceIgnores(incoming.value.value))
      else if (operation.kind === 'binding-read') {
        const storage = placements.get(operation.declaration)?.storage.kind
        const writes = localWrites.get(operation.declaration)
        ignored = (storage === 'local' || storage === 'region') && writes !== undefined && writes.length > 0 && writes.every(sourceIgnores)
      }
      if (ignored) {
        ignoredLogicalReceiverValues.add(result.id)
        changedReceiverContract = true
      }
    }
  }
  const nativeFieldStorageValues = new Map<IrValueId, ReadonlyMap<string, readonly Representation[]>>()
  const nativeFieldMethodValues = new Map<IrValueId, ReadonlyMap<string, Representation>>()
  const nativeAccessorStorageValues = new Map<
    IrValueId,
    ReadonlyMap<string, readonly { read: Representation; write: Representation | null }[]>
  >()
  for (const [id, cell] of values) {
    if (cell.unknown || cell.heaps.size === 0 || [...cell.heaps].some((heap) => !heap.valid || heap.proxy)) continue
    const common = new Map<string, Representation[]>()
    for (const heap of cell.heaps) {
      for (const [key, slot] of heap.fields) {
        const members = common.get(key) ?? []
        if (!members.some((member) => representationKey(member) === representationKey(slot.representation)))
          members.push(slot.representation)
        common.set(key, members)
      }
    }
    for (const key of [...common.keys()]) if ([...cell.heaps].some((heap) => !heap.fields.has(key))) common.delete(key)
    nativeFieldStorageValues.set(id, common)
    const carrier = valueCarriers.get(id)
    const methods = carrier && 'shapeId' in carrier ? viewMethodFields.get(carrier.shapeId) : undefined
    if (methods) {
      const admitted = new Map(methods)
      for (const key of admitted.keys())
        if ([...cell.heaps].some((heap) => heap.declaration === null || classMemberOf(classes, heap.declaration, key)?.kind !== 'method'))
          admitted.delete(key)
      nativeFieldMethodValues.set(id, admitted)
    }
    const accessors = new Map<string, { read: Representation; write: Representation | null }[]>()
    for (const heap of cell.heaps) {
      if (heap.declaration === null) continue
      const seen = new Set<DeclarationId>()
      for (
        let current: DeclarationId | null = heap.declaration;
        current !== null && !seen.has(current);
        current = classes.get(current)?.base ?? null
      ) {
        seen.add(current)
        for (const accessor of classes.get(current)?.accessors ?? []) {
          const selected = classMemberOf(classes, heap.declaration, accessor.key)
          if (selected?.kind !== 'accessor' || selected.owner !== current) continue
          const getter = accessor.getter === null ? null : bodyById.get(accessor.getter)?.abi
          const setter = accessor.setter === null ? null : bodyById.get(accessor.setter)?.abi
          if (!getter) continue
          const entries = accessors.get(accessor.key) ?? []
          entries.push({ read: getter.result, write: setter?.parameters[0]?.value ?? null })
          accessors.set(accessor.key, entries)
        }
      }
    }
    for (const key of [...accessors.keys()])
      if ([...cell.heaps].some((heap) => heap.declaration === null || classMemberOf(classes, heap.declaration, key)?.kind !== 'accessor'))
        accessors.delete(key)
    nativeAccessorStorageValues.set(id, accessors)
  }
  // What a spread's copy left natively in an allocation's expando, by the
  // receiver's carrier and key. Read from the published copy plan, which
  // certification re-derives from the operation itself.
  const expandoStored = new Map<string, Map<string | null, Representation[]>>()
  const storeExpando = (receiver: Representation, key: string | null, value: Representation): void => {
    if (!('shapeId' in receiver)) return
    const byKey = expandoStored.get(receiver.shapeId) ?? new Map<string | null, Representation[]>()
    const held = byKey.get(key) ?? []
    if (!held.some((one) => representationKey(one) === representationKey(value))) held.push(value)
    byKey.set(key, held)
    expandoStored.set(receiver.shapeId, byKey)
  }
  for (const operation of operations) {
    if (operation.kind === 'spread-copy' && operation.spreadConversionPlan) {
      for (const [key, values] of operation.spreadConversionPlan.expandoKeys)
        for (const value of values) storeExpando(operation.receiver.representation, key, value)
      continue
    }
    // `Object.assign`'s native copy stores a key its target's layout lacks in
    // the target's native object data, as the carrier it holds there; a
    // described source's run-time key outside its type lands there as the
    // Value it already is. A live view over the target reads both.
    if (operation.kind !== 'call' || !operation.nativeOwnAssignment) continue
    const owner = operation.nativeOwnAssignment.owner.representation
    for (const source of operation.nativeOwnAssignment.sources) {
      for (const field of source.fields) if (field.destination === 'extension') storeExpando(owner, field.key, field.held)
      if (source.described === true) storeExpando(owner, null, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
    }
  }
  const expandoStoredOf = (shapeId: string, key: string | null): readonly Representation[] => {
    const byKey = expandoStored.get(shapeId)
    if (byKey === undefined) return []
    // `null`: whatever any key may hold -- an open runtime key reads them all.
    if (key === null) {
      const all: Representation[] = []
      for (const values of byKey.values())
        for (const value of values) if (!all.some((one) => representationKey(one) === representationKey(value))) all.push(value)
      return all
    }
    const keyed = byKey.get(key) ?? []
    const any = byKey.get(null) ?? []
    return [...keyed, ...any.filter((value) => !keyed.some((one) => representationKey(one) === representationKey(value)))]
  }
  const nativeFieldViewStorageValues = new Map<IrValueId, ReadonlyMap<string, readonly NativeFieldStorageDomain[]>>()
  const descriptorDomainsOf = nativeFieldViewDomainsOf(viewNodes, deriver, (id) => bodyById.get(id)?.abi ?? null, classes, expandoStoredOf)
  for (const [id, carrier] of valueCarriers) {
    const fields = descriptorDomainsOf(carrier)
    if (fields !== null) nativeFieldViewStorageValues.set(id, fields)
  }
  const nativeFieldOperationStorageValues = new Map<IrOperation, ReadonlyMap<string, readonly NativeFieldStorageDomain[]>>()
  const originDomains = new Map<string, ReturnType<typeof nativeFieldViewDomainsOf>>()
  for (const operation of operations) {
    if (operation.kind !== 'get' && operation.kind !== 'set') continue
    const key = keyOf(operation.key)
    const receiver = value(operation.receiver.value)
    if (key === null || receiver.unknown || receiver.heaps.size === 0) continue
    const { heaps, present } = heapSelectionAt(operation.receiver, key, operation)
    if (heaps === null || heaps.length === 0 || !heaps.every(ordinaryAllocated)) continue
    const domains = new Map<string, NativeFieldStorageDomain[]>()
    for (const name of heaps[0]!.fields.keys()) {
      if (!heaps.every((heap) => heap.fields.has(name))) continue
      const entries = new Map<string, NativeFieldStorageDomain>()
      for (const heap of heaps) {
        const stored = heap.fields.get(name)!.representation
        entries.set(representationKey(stored), { read: stored, write: stored })
      }
      domains.set(name, [...entries.values()])
    }
    if (
      operation.kind === 'get' &&
      heaps.some((heap) => !heap.fields.has(key)) &&
      heaps.every((heap) => heap.fields.has(key) || originalDescriptorAbsent(operation, key, heap))
    ) {
      const entries: NativeFieldStorageDomain[] = []
      for (const heap of heaps) {
        const slot = heap.fields.get(key)
        entries.push(
          slot === undefined
            ? { read: { kind: 'undefined' }, write: null, originalAbsent: true }
            : { read: slot.representation, write: slot.representation }
        )
      }
      domains.set(key, entries)
    }
    if (receiver.fieldViews.size > 0) {
      const ids = [...receiver.fieldViews].sort()
      const identity = JSON.stringify(ids)
      let installed = originDomains.get(identity)
      if (!installed) {
        const nodes = nativeFieldViewLiveLeavesOf(
          ids.flatMap((id) => {
            const node = conversions?.nodeById(id)
            return node && nativeFieldViewIdentityTransportOf(node) ? [node] : []
          })
        )
        installed = nativeFieldViewDomainsOf(nodes, deriver, (id) => bodyById.get(id)?.abi ?? null, classes, expandoStoredOf)
        originDomains.set(identity, installed)
      }
      // The retained allocation's C++ slot is behind this installed reader.
      // Its layout alone cannot erase an intermediate Document entry route.
      // A dominating true Has edge proved an own descriptor on every selected
      // allocation, so a view leaf answering the key from a source that never
      // stores it (`{ $binary }` viewed as `{ $type, $binary }`) is not behind it.
      for (const [name, routes] of installed(operation.receiver.representation) ?? []) {
        // The selected heaps already prove each allocation's own slot or its
        // absence; a union arm's certified absence is the unknown-receiver
        // answer (`native-field-view-domains.ts`) and is no route behind them.
        if (routes.some((route) => route.originalAbsent === true || route.dynamicGet === true)) continue
        domains.set(name, [
          ...(domains.get(name) ?? []),
          ...(present && name === key ? routes.filter((route) => route.sourceAbsent !== true) : routes)
        ])
      }
    }
    nativeFieldOperationStorageValues.set(operation, domains)
  }
  const callableIdentityOrigins = new Map<IrValueId, readonly FunctionId[]>()
  const callablePublications = new Map<FunctionId, Set<IrOperation | null>>()
  for (const cell of cells)
    if (cell.functions.size > 0 && (cell.escaped || cell.unknown))
      for (const functionId of cell.functions) {
        const sources = callablePublications.get(functionId) ?? new Set<IrOperation | null>()
        if (cell.unknown) sources.add(null)
        for (const source of cell.escapeSources) sources.add(source)
        callablePublications.set(functionId, sources)
      }
  for (const [id, cell] of values)
    if (!cell.unknown && cell.functions.size > 0 && [...cell.functions].every((functionId) => bodyById.has(functionId)))
      callableIdentityOrigins.set(id, [...cell.functions])
  const closedCallableReturns = new Set<IrOperation>()
  for (const operation of operations)
    if (
      operation.kind === 'return' &&
      operation.value !== null &&
      callableIdentityOrigins.has(operation.value.value) &&
      !externalEntries.has(owner.get(operation)!) &&
      !implicitAccessorEntries.has(owner.get(operation)!) &&
      called.has(owner.get(operation)!)
    )
      closedCallableReturns.add(operation)
  const nativeDocumentEntryValues = new Map<IrValueId, { readonly entry: Representation; readonly views: readonly string[] }>()
  const nativeDocumentArrayEntryValues = new Map<IrValueId, NativeDocumentArrayEntry>()
  const documentArrayRoots = conversions
    ? viewNodes.filter((node) => nativeArrayRootViewPlansOf(node, conversions.nodeById).length > 0)
    : []
  const documentArrayEntries = new Map<string, NativeDocumentArrayEntry | null>()
  if (conversions && documentArrayRoots.length > 0)
    for (const [id, carrier] of valueCarriers) {
      const identity = representationKey(carrier)
      if (!documentArrayEntries.has(identity))
        documentArrayEntries.set(identity, nativeDocumentArrayEntryOf(carrier, documentArrayRoots, conversions.nodeById, deriver))
      const entry = documentArrayEntries.get(identity) ?? null
      if (entry !== null) nativeDocumentArrayEntryValues.set(id, entry)
    }
  const nativeArrayViewValues = new Set<IrValueId>()
  const nativeArrayViewOrigins = new Map<IrValueId, readonly ConversionNode[]>()
  const nativeDescriptorSnapshotValues = new Map<IrValueId, readonly IrValueId[]>()
  const nativeDescriptorSnapshotOpenValues = new Set<IrValueId>()
  const nativeFieldViewOrigins = new Map<IrValueId, readonly ConversionNodeId[]>()
  for (const [id, cell] of values) {
    if (cell.fieldViews.size > 0) nativeFieldViewOrigins.set(id, [...cell.fieldViews])
    if (cell.descriptorSnapshots.size > 0) {
      nativeDescriptorSnapshotValues.set(id, [...cell.descriptorSnapshots])
      if (cell.unknown || cell.escaped) nativeDescriptorSnapshotOpenValues.add(id)
    }
    if (cell.arrayViews.size > 0) {
      nativeArrayViewValues.add(id)
      const roots = [...cell.arrayViews].flatMap((root) => {
        const node = conversions?.nodeById(root)
        return node === undefined || node === null ? [] : [node]
      })
      nativeArrayViewOrigins.set(id, roots)
    }
    if (cell.documentBlocked || cell.documents.size === 0) continue
    const entries = [...cell.documents.values()]
    if (entries.some((entry) => representationKey(entry) !== representationKey(entries[0]!))) continue
    nativeDocumentEntryValues.set(id, { entry: entries[0]!, views: [...cell.documents.keys()] })
  }
  return {
    nativeFieldViewOrigins,
    callableIdentityOrigins,
    callablePublications,
    closedCallableReturns,
    nativeDocumentEntryValues,
    nativeDocumentArrayEntryValues,
    nativeArrayViewValues,
    nativeArrayViewOrigins,
    nativeDescriptorSnapshotValues,
    nativeDescriptorSnapshotOpenValues,
    nativeFieldOperationStorageValues,
    nativeFieldViewStorageValues,
    nativeFieldViewAbsentRoutesOf: (receiver: IrValueId, key: string | null) => {
      const carrier = valueCarriers.get(receiver)
      return carrier === undefined ? null : descriptorDomainsOf.absentRoutesOf(carrier, key)
    },
    nativeFieldStorageValues,
    nativeFieldMethodValues,
    nativeAccessorStorageValues,
    callables: result,
    enteredBodies: new Set([...entered].map((body) => body.owner)),
    logicalReceiverValues,
    dynamicReceiverValues,
    ignoredLogicalReceiverValues
  }
}

interface RememberedCallableFlow {
  readonly bodies: readonly IrBody[]
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly conversions: ConversionsArgument
  readonly deriver: Pick<RepresentationDeriver, 'layoutOf'> | null
  readonly programConversions: readonly ProgramConversionRecipe[] | null
  readonly constructionTopology: readonly IrBody[] | null
  readonly flow: NativeCallableFlow
}
type ConversionsArgument = Parameters<typeof computeNativeCallableFlow>[3]

/**
 * Pairs every object of `old` with the object at the same position in `next`,
 * answering whether the two are the same data. Only plain objects, arrays,
 * Maps and Sets are looked into; anything else (a function, a class instance)
 * must be the very same object. A shared object is paired once, so a DAG whose
 * sharing differs is refused rather than mis-paired.
 */
const pairSameData = (old: unknown, next: unknown, pairs: Map<object, object>): boolean => {
  if (old === next) return true
  if (typeof old !== 'object' || typeof next !== 'object' || old === null || next === null) return Object.is(old, next)
  const paired = pairs.get(old)
  if (paired !== undefined) return paired === next
  const prototype = Object.getPrototypeOf(old) as unknown
  if (prototype !== Object.getPrototypeOf(next)) return false
  pairs.set(old, next)
  if (Array.isArray(old)) {
    const other = next as readonly unknown[]
    if (old.length !== other.length) return false
    for (let index = 0; index < old.length; index++) if (!pairSameData(old[index], other[index], pairs)) return false
    return true
  }
  if (old instanceof Map || old instanceof Set) {
    const other = next as Map<unknown, unknown> | Set<unknown>
    if (old.size !== other.size) return false
    const theirs = other.entries()
    for (const [key, value] of old.entries()) {
      const [otherKey, otherValue] = theirs.next().value as [unknown, unknown]
      if (!pairSameData(key, otherKey, pairs) || !pairSameData(value, otherValue, pairs)) return false
    }
    return true
  }
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(old)
  if (keys.length !== Object.keys(next).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) return false
    if (!pairSameData((old as Record<string, unknown>)[key], (next as Record<string, unknown>)[key], pairs)) return false
  }
  return true
}

/**
 * `value` with every paired object replaced by its partner; a container nothing
 * inside of moved is returned as is. `fresh` holds the objects the new program
 * has where the old one held a different object: a remembered answer that
 * reaches one is holding something a pass wrote into the program after the
 * solve, which a solve of the new program would not share with it.
 */
const repointed = (
  value: unknown,
  pairs: ReadonlyMap<object, object>,
  seen: Map<object, unknown>,
  fresh: { readonly objects: ReadonlySet<object>; reached: boolean }
): unknown => {
  if (typeof value !== 'object' || value === null) return value
  const partner = pairs.get(value)
  if (partner !== undefined) return partner
  if (fresh.objects.has(value)) fresh.reached = true
  if (seen.has(value)) return seen.get(value)
  seen.set(value, value)
  let result: unknown = value
  if (Array.isArray(value)) {
    const items = value.map((item) => repointed(item, pairs, seen, fresh))
    if (items.some((item, index) => item !== value[index])) result = items
  } else if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [repointed(key, pairs, seen, fresh), repointed(item, pairs, seen, fresh)] as const)
    if ([...value].some(([key, item], index) => entries[index]![0] !== key || entries[index]![1] !== item)) result = new Map(entries)
  } else if (value instanceof Set) {
    const items = [...value].map((item) => repointed(item, pairs, seen, fresh))
    if ([...value].some((item, index) => items[index] !== item)) result = new Set(items)
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype === Object.prototype || prototype === null) {
      let copy: Record<string, unknown> | null = null
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key]
        const moved = repointed(item, pairs, seen, fresh)
        if (moved !== item) (copy ??= { ...(value as Record<string, unknown>) })[key] = moved
      }
      if (copy !== null) result = copy
    }
  }
  seen.set(value, result)
  return result
}

/**
 * A remembered answer re-pointed from the program it was solved over to a
 * same-data copy of it, or null when it cannot stand for a solve of the copy.
 */
const flowOverCopy = (flow: NativeCallableFlow, pairs: ReadonlyMap<object, object>): NativeCallableFlow | null => {
  const seen = new Map<object, unknown>()
  const fresh = { objects: new Set(pairs.values()), reached: false }
  const { nativeFieldViewAbsentRoutesOf: absentRoutesOf, callables, ...data } = flow
  const moved = repointed(data, pairs, seen, fresh) as Omit<NativeCallableFlow, 'nativeFieldViewAbsentRoutesOf' | 'callables'>
  // A solve allocates each callee identity afresh, and the dispatch passes then
  // write those very objects into the program, so they are copied rather than
  // re-pointed: handed back as they are, the reused answer would share them
  // with the bodies where a solve's never does.
  const callees = new Map(
    [...callables].map(([value, callee]) => [value, repointed({ ...callee }, pairs, seen, fresh) as CallCalleeIdentity] as const)
  )
  if (fresh.reached) return null
  const answer = { ...moved, callables: callees }
  if (absentRoutesOf === undefined) return answer
  return {
    ...answer,
    nativeFieldViewAbsentRoutesOf: (receiver, key) =>
      repointed(absentRoutesOf(receiver, key), pairs, new Map(), { objects: new Set(), reached: false }) as ReturnType<
        typeof absentRoutesOf
      >
  }
}

/**
 * The flow's answer is a function of its inputs' data -- the conversion census
 * it consults is append-only and `nodeFor` is idempotent per pair -- so a
 * recent answer per class map is reused when every input is the same. The
 * same objects reuse it directly. The publish passes between two solves
 * rebuild every body and operation even when they change nothing, so an input
 * that is the same DATA reuses the answer re-pointed at the new objects, since
 * its consumers look operations up by identity. On a large program that
 * replaces about a third of the solves, each checked against a fresh solve of
 * the same program: equal data, and the same program objects. The rest
 * differ in what the flow reads (`logicalReceiver`, `closedCallable`,
 * `presence`, recipe lists). A traced run reports reads as it solves and is
 * always solved.
 */
const rememberedFlows = new WeakMap<ReadonlyMap<DeclarationId, ClassLayout>, RememberedCallableFlow[]>()
/** Callers alternate between asking with and without program conversions, so one remembered answer per class map was always the other kind. */
const REMEMBERED_FLOWS = 3

export const nativeCallableFlowOf = (...args: Parameters<typeof computeNativeCallableFlow>): NativeCallableFlow => {
  const [bodies, placements, classes, conversions, trace, deriver, programConversions, constructionTopology] = args
  if (trace !== undefined) return computeNativeCallableFlow(...args)
  let held = rememberedFlows.get(classes)
  if (held === undefined) rememberedFlows.set(classes, (held = []))
  const entries = held
  const remember = (flow: NativeCallableFlow, replaced: number): NativeCallableFlow => {
    if (replaced !== -1) entries.splice(replaced, 1)
    entries.unshift({
      bodies,
      placements,
      conversions,
      deriver: deriver ?? null,
      programConversions: programConversions ?? null,
      constructionTopology: constructionTopology ?? null,
      flow
    })
    entries.length = Math.min(entries.length, REMEMBERED_FLOWS)
    return flow
  }
  const sameContext = (entry: RememberedCallableFlow): boolean =>
    entry.placements === placements && entry.conversions === conversions && entry.deriver === (deriver ?? null)
  for (const entry of entries)
    if (
      sameContext(entry) &&
      entry.programConversions === (programConversions ?? null) &&
      entry.constructionTopology === (constructionTopology ?? null) &&
      entry.bodies.length === bodies.length &&
      entry.bodies.every((body, index) => body === bodies[index])
    )
      return entry.flow
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (
      !sameContext(entry) ||
      entry.bodies.length !== bodies.length ||
      (entry.programConversions === null) !== (programConversions === undefined) ||
      (entry.constructionTopology === null) !== (constructionTopology === undefined)
    )
      continue
    const pairs = new Map<object, object>()
    if (
      !pairSameData(entry.bodies, bodies, pairs) ||
      !pairSameData(entry.programConversions, programConversions ?? null, pairs) ||
      !pairSameData(entry.constructionTopology, constructionTopology ?? null, pairs)
    )
      continue
    const reused = flowOverCopy(entry.flow, pairs)
    if (reused === null) continue
    return remember(reused, index)
  }
  const flow = computeNativeCallableFlow(...args)
  return remember(flow, -1)
}

/** Compatibility view of the same execution/escape census; no second analysis policy. */
export const closedClassFieldCallablesOf = (...args: Parameters<typeof nativeCallableFlowOf>): ReadonlyMap<IrValueId, CallCalleeIdentity> =>
  nativeCallableFlowOf(...args).callables
