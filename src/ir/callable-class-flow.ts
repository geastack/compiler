import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { classLayoutOfCopy, constructedBaseOf, type ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { abiOfCallee } from '../projection/callee.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodMutableOf } from '../projection/fields.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNode } from '../conversion/algebra.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import { nativeCallablePrefixAdapterMatches } from '../conversion/native-callable-adapter.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import { nativeMergePayloadTransportMatches } from './native-merge-transport.js'
import { nativeArrayTransportOf } from './native-array-transport.js'
import { nativeDictionaryTransportOf } from './native-dictionary-transport.js'
import { nativeSequenceTransportOf } from './native-sequence-transport.js'
import { nativeClassInitializationOf, nativeSuperInitializationOf } from './native-class-initialization.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import { nativeClassAccessorEntryOf } from './native-class-accessor.js'
import { hasNativePropertyLayout } from './native-fixed-layout.js'
import { nativeKeyQueryOf } from './native-key-query.js'
import { abiKey, representationKey, walkRepresentation, type Representation } from '../representation/model.js'
import type { CallCalleeIdentity, IrBody, IrOperand, IrOperation } from './model.js'
import { nativeArgumentsMatch, receivedCallArguments } from './call-entry.js'
import {
  classConstructorBodyMatches,
  constructMatchesAbi,
  explicitObjectConstructEntryOf,
  ordinaryConstructBodyMatches
} from './construct-entry.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'

interface OriginCell {
  readonly index: number
  readonly incoming: Set<OriginCell>
  queued: boolean
  readonly functions: Set<FunctionId>
  readonly heaps: Set<NativeHeap>
  /** Null transfers every origin; native selection can exclude incompatible heaps. */
  readonly edges: Map<OriginCell, readonly NativeHeap[] | null>
  unknown: boolean
  escaped: boolean
  unknownReason?: string
  escapeReason?: string
}

interface NativeHeap {
  readonly declaration: DeclarationId | null
  readonly fields: Map<string, { readonly cell: OriginCell; readonly representation: Representation }>
  readonly layoutKey: string | null
  /** Absent on the external summary; local allocations share only its layout. */
  readonly template?: NativeHeap
  valid: boolean
}

export interface NativeCallableFlow {
  readonly callables: ReadonlyMap<IrValueId, CallCalleeIdentity>
  /** Includes every implicit or unmodeled entry; only closed, uninvoked allocations are absent. */
  readonly enteredBodies: ReadonlySet<PhysicalBodyId>
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
export const nativeCallableFlowOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions?: Pick<ConversionCensus, 'nodeById'> & Partial<Pick<ConversionCensus, 'nodeFor'>>,
  trace?: (read: Extract<IrOperation, { kind: 'get' }>, reason: string) => void,
  deriver?: Pick<RepresentationDeriver, 'layoutOf'> | null
): NativeCallableFlow => {
  const propertyLayoutCache = new Map<string, boolean>()
  const nativePropertyLayoutOf = (representation: Representation): boolean =>
    hasNativePropertyLayout(representation, deriver ?? null, classes, new Set<string>(), propertyLayoutCache)
  const cells: OriginCell[] = []
  const pendingCells: OriginCell[] = []
  const nextSweep: OriginCell[] = []
  let sweepIndex: number | null = null
  let revision = 0
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
    schedule(cell)
  }
  const addFunction = (cell: OriginCell, id: FunctionId): void => {
    if (cell.functions.has(id)) return
    cell.functions.add(id)
    changed(cell)
  }
  const addHeap = (cell: OriginCell, heap: NativeHeap): void => {
    if (cell.heaps.has(heap)) return
    cell.heaps.add(heap)
    changed(cell)
  }
  const markUnknown = (cell: OriginCell, reason?: string): void => {
    if (!cell.unknown) {
      cell.unknown = true
      changed(cell)
    }
    if (trace && reason !== undefined) cell.unknownReason ??= reason
  }
  const markEscaped = (cell: OriginCell, reason?: string): void => {
    if (!cell.escaped) {
      cell.escaped = true
      changed(cell)
      for (const source of cell.incoming) schedule(source)
    }
    if (trace && reason !== undefined) cell.escapeReason ??= reason
  }
  const fresh = (): OriginCell => {
    const cell: OriginCell = {
      index: cells.length,
      incoming: new Set(),
      queued: false,
      functions: new Set(),
      heaps: new Set(),
      edges: new Map(),
      unknown: false,
      escaped: false
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
  const recordViews = new WeakMap<Representation, NativeHeap>()
  const adaptedFrames = new Map<string, Set<string>>()
  const transportsCallablePrefix = (from: Representation, to: Representation, node: ConversionNode | null | undefined): boolean => {
    if (!nativeCallablePrefixAdapterMatches(from, to, node)) return false
    const source = abiKey(abiOfCallee(from)!)
    const targets = adaptedFrames.get(source) ?? new Set<string>()
    targets.add(abiKey(abiOfCallee(to)!))
    adaptedFrames.set(source, targets)
    return true
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
  const producers = new Map<IrValueId, IrOperation>()
  const bodyById = new Map<FunctionId, IrBody | null>()
  const returns = new Map<FunctionId, OriginCell>()
  // super() consumes the frame receiver even when the body never spells this
  // and lowering therefore produces no receiver SSA operation.
  const frameReceivers = new Map<FunctionId, OriginCell>()
  const parameters = new Map<FunctionId, Extract<IrOperation, { kind: 'parameter' | 'receiver' }>[]>()
  const owner = new Map<IrOperation, FunctionId>()
  for (const body of bodies) {
    const id = body.sourceOwner as FunctionId
    bodyById.set(id, bodyById.has(id) ? null : body)
    returns.set(id, fresh())
    if (body.abi?.receiver) frameReceivers.set(id, fresh())
    const inputs: Extract<IrOperation, { kind: 'parameter' | 'receiver' }>[] = []
    for (const block of body.blocks.values())
      for (const operation of [...block.operations, block.terminator]) {
        owner.set(operation, id)
        if (operation.kind === 'parameter' || operation.kind === 'receiver') inputs.push(operation)
      }
    parameters.set(id, inputs)
  }
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result) producers.set(result.id, operation)
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
      slotCache.clear()
    }
    for (const field of fields) if (!heap.fields.has(field.key)) heap.fields.set(field.key, { cell: fresh(), representation: field.value })
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
    } else if (representation.ownership !== 'shared-refcount') heap.valid = false
    return heap
  }
  const nativeReferences = (representation: Representation): { readonly heaps: readonly NativeHeap[]; readonly complete: boolean } => {
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
      } else if (representation.ownership !== 'shared-refcount') heap.valid = false
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
      heaps.some((heap) => !heap.valid || !heap.fields.has(key)) ||
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
  const escape = (cell: OriginCell, reason: string): void => {
    markEscaped(cell, reason)
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
  const seedAllocation = (id: IrValueId, representation: Representation): readonly NativeHeap[] => {
    const known = allocations.get(id)
    if (known) return known
    const heaps = nativeReferences(representation).heaps.map((template): NativeHeap => {
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
      const heap: NativeHeap = { declaration: template.declaration, layoutKey: template.layoutKey, valid: template.valid, template, fields }
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
    for (const heap of heaps) addHeap(value(id), heap)
    return heaps
  }
  const slotsOf = (receiver: IrOperand, key: string): readonly OriginCell[] | null => {
    if (slotTemplatesOf(receiver.representation, key) === null) return null
    const slots: OriginCell[] = []
    for (const heap of value(receiver.value).heaps) {
      if (!heap.valid || heap.template?.valid === false || !heap.fields.has(key)) return null
      slots.push(heap.fields.get(key)!.cell)
    }
    return slots
  }
  // Field edges wait for receiver origins. A type supplies a layout, never an
  // alias to every allocation of that type. The same worklist handles stores,
  // loads and array copies as new call/return origins arrive.
  const heapEffects: { readonly operation: IrOperation; readonly apply: () => boolean; readonly reject?: () => void }[] = []
  const heapEffect = (operation: IrOperation, apply: () => boolean, reject?: () => void): void => {
    heapEffects.push({ operation, apply, ...(reject ? { reject } : {}) })
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
  const externalEntry = (id: FunctionId, reason: string): void => {
    enter(id)
    const receiver = frameReceivers.get(id)
    const representation = bodyById.get(id)?.abi?.receiver
    if (receiver && representation) external(receiver, representation, reason)
    for (const input of parameters.get(id) ?? []) external(value(input.result.id), input.result.representation, reason)
    const returned = returns.get(id)
    if (returned) escape(returned, reason)
  }
  const untrusted = (operation: IrOperation): void => {
    const reason = `${operation.kind}:${operation.lineage}`
    const operands =
      operation.kind === 'call'
        ? [operation.callee, ...(operation.receiver ? [operation.receiver] : []), ...receivedCallArguments(operation)]
        : operandsOfIrOperation(operation)
    for (const operand of operands) escape(value(operand.value), reason)
    // super() also receives this even though the IR operation lists only
    // explicit arguments. An unmodeled base entry may publish that receiver.
    if (operation.kind === 'super-initialize') {
      const receiver = frameReceivers.get(owner.get(operation)!)
      if (receiver) escape(receiver, reason)
      for (const input of parameters.get(owner.get(operation)!) ?? []) if (input.kind === 'receiver') escape(value(input.result.id), reason)
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
    if (result) external(value(result.id), result.representation, reason)
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
  const allocatedClasses = new Set(
    operations.flatMap((operation) => (operation.kind === 'allocate-constructor' ? [operation.declaration] : []))
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
      const node = conversions?.nodeById(recipe.conversion)
      if (
        !target ||
        !descriptor ||
        !node ||
        representationKey(target.representation) !== recipe.target ||
        representationKey(descriptor.representation) !== recipe.descriptor ||
        representationKey(node.source) !== representationKey(recipe.value.value) ||
        representationKey(node.target) !== representationKey(recipe.held)
      ) {
        untrusted(operation)
        return
      }
      // This is the same sealed native update reflection and emission consume,
      // not a call to an unknown implementation of Object.defineProperty.
      heapEffect(operation, () => {
        const targets = slotsOf(target, recipe.field.key)
        const sources = slotsOf(descriptor, recipe.value.key)
        if (targets === null || sources === null) {
          untrusted(operation)
          return true
        }
        for (const destination of targets)
          if (nativePayloadTransportMatches(node.source, node.target, node))
            for (const source of sources) linkPayload(source, destination, [node.target])
          else if (
            representationKey(node.source) === representationKey(node.target) ||
            nativeClassReferenceTransportMatches(node.source, node.target, node) ||
            transportsCallablePrefix(node.source, node.target, node)
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
        heapEffect(operation, () => {
          const slots = slotsOf(operation.receiver, '')
          if (slots === null) {
            untrusted(operation)
            return true
          }
          for (const slot of slots)
            if (operation.kind === 'get') link(slot, value(operation.result.id))
            else link(value(operation.value.value), slot)
          return slots.length > 0
        })
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
      case 'allocate-constructor': {
        // Publishing the constructor publishes its future instances too.
        // Its ordinary return cell is void, so that escape cannot be found by
        // following constructor-body returns like an ordinary factory's.
        const heap = classHeaps.get(operation.declaration)
        if (heap) addHeap(value(operation.result.id), heap)
        const layout = classLayoutOfCopy(classes, operation.declaration)
        if (layout) for (const id of constructionEntriesOf(layout)) addFunction(value(operation.result.id), id)
        break
      }
      case 'constant':
      case 'parameter':
      case 'jump':
      case 'branch':
      case 'switch':
      case 'test':
        break
      case 'receiver': {
        const receiver = frameReceivers.get(owner.get(operation)!)
        if (receiver) link(receiver, value(operation.result.id))
        break
      }
      case 'allocate-ordinary-object':
      case 'allocate-record': {
        const references = nativeReferences(operation.result.representation)
        seedAllocation(operation.result.id, operation.result.representation)
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
            heapEffect(operation, () => {
              const sources = slotsOf(slot.value, '')
              if (sources === null) {
                untrusted(operation)
                return true
              }
              for (const source of sources) link(source, elements)
              return sources.length > 0
            })
          }
        }
        break
      }
      case 'binding-write':
        link(value(operation.value.value), binding(operation.declaration))
        if (!['local', 'region'].includes(placements.get(operation.declaration)?.storage.kind ?? ''))
          markEscaped(value(operation.value.value))
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
        const key = keyOf(operation.key)
        if (nativeArrayTransportOf(operation, key)) {
          if (key !== 'length') {
            fieldReads.push(operation)
            heapEffect(operation, () => {
              const sources = slotsOf(operation.receiver, '')
              if (sources === null) {
                untrusted(operation)
                return true
              }
              for (const source of sources) link(source, value(operation.result.id))
              return sources.length > 0
            })
          }
          break
        }
        if (key !== null && slotTemplatesOf(operation.receiver.representation, key) !== null) {
          fieldReads.push(operation)
          heapEffect(operation, () => {
            const sources = slotsOf(operation.receiver, key)
            if (sources === null) {
              untrusted(operation)
              return true
            }
            for (const source of sources) link(source, value(operation.result.id))
            return sources.length > 0
          })
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
        const key = keyOf(operation.key)
        if (operation.kind === 'set' && nativeArrayTransportOf(operation, key)) {
          if (key !== 'length')
            heapEffect(operation, () => {
              const targets = slotsOf(operation.receiver, '')
              if (targets === null) {
                untrusted(operation)
                return true
              }
              for (const target of targets) link(value(operation.value.value), target)
              return targets.length > 0
            })
          if (operation.result && representationKey(operation.result.representation) === representationKey(operation.value.representation))
            link(value(operation.value.value), value(operation.result.id))
          break
        }
        if (key !== null && slotTemplatesOf(operation.receiver.representation, key) !== null) {
          heapEffect(operation, () => {
            const targets = slotsOf(operation.receiver, key)
            if (targets === null) {
              untrusted(operation)
              return true
            }
            for (const target of targets) link(value(operation.value.value), target)
            return targets.length > 0
          })
          if (
            operation.result &&
            representationKey(operation.result.representation) ===
              representationKey(operation.kind === 'set' ? operation.value.representation : operation.receiver.representation)
          )
            link(value(operation.kind === 'set' ? operation.value.value : operation.receiver.value), value(operation.result.id))
        } else untrusted(operation)
        break
      }
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
        const native =
          node?.capability.kind === 'identity' ||
          ((node?.capability.kind === 'atom' || node?.capability.kind === 'static') &&
            node.capability.materializer.nativeFieldProtocol === 'unused')
        if (nativePayloadTransportMatches(from, to, node)) linkPayload(value(operation.source.value), value(operation.result.id), [to])
        else if (
          representationKey(from) === representationKey(to) ||
          nativeClassReferenceTransportMatches(from, to, node) ||
          transportsCallablePrefix(from, to, node) ||
          (native && abiOfCallee(from) !== null && abiOfCallee(to) !== null && abiKey(abiOfCallee(from)!) === abiKey(abiOfCallee(to)!))
        )
          link(value(operation.source.value), value(operation.result.id))
        else untrusted(operation)
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
            ? [...classes.values()].find((candidate) => candidate.constructor === constructor)
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
          for (const id of cell.functions) addFunction(target, id)
          for (const heap of cell.heaps) if (allowed === null || heapAdmitted(heap, allowed)) addHeap(target, heap)
          if (cell.unknown) markUnknown(target, cell.unknownReason)
          // Publication of an alias is publication of its sources too.
          if (target.escaped) markEscaped(cell, target.escapeReason)
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
            const methodLayouts =
              candidate.declaration === null
                ? []
                : [...classes.values()].filter(
                    (layout) =>
                      layout.declaration === candidate.declaration || extendsClass(classes, candidate.declaration!, layout.declaration)
                  )
            for (const layout of methodLayouts) {
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
          if (!unknownCalls.has(operation)) {
            unknownCalls.add(operation)
            untrusted(operation)
          }
          continue
        }
        let visited = visitedCallTargets.get(operation)
        if (!visited) visitedCallTargets.set(operation, (visited = new Set()))
        for (const id of callee.functions) {
          // Frame compatibility is immutable. Once linked, argument and
          // return edges carry future origins without re-invoking the site.
          if (visited.has(id)) continue
          visited.add(id)
          const abi = bodyById.get(id)?.abi
          const held = abiOfCallee(operation.callee.representation)
          // Only an observed, certified native adapter can enter the original
          // original body through its public held frame. All
          // identity propagation into this cell already crossed proven edges.
          const adaptsFrame = abi && held && adaptedFrames.get(abiKey(abi))?.has(abiKey(held)) === true
          const argumentsForBody = adaptsFrame ? operation.arguments.slice(0, abi.parameters.length) : operation.arguments
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
          let receiverForBody = abi.receiver !== null && operation.receiver ? value(operation.receiver.value) : null
          if (
            receiverForBody &&
            abi.receiver &&
            operation.receiver &&
            representationKey(abi.receiver) !== representationKey(operation.receiver.representation)
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
  return { callables: result, enteredBodies: new Set([...entered].map((body) => body.owner)) }
}

/** Compatibility view of the same execution/escape census; no second analysis policy. */
export const closedClassFieldCallablesOf = (...args: Parameters<typeof nativeCallableFlowOf>): ReadonlyMap<IrValueId, CallCalleeIdentity> =>
  nativeCallableFlowOf(...args).callables
