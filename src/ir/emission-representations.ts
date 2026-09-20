import type { ConversionNode, ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, PhysicalBodyId, StructuralTypeId } from '../identity/ids.js'
import { allOperationsOf, type IrBody, type IrOperation, type IrOperand } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import type { ClassLayout, PhysicalClassRefResolver } from '../projection/classes.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import {
  recursiveCarrierOf,
  representationKey,
  walkRepresentation,
  type CallableAbi,
  type Representation
} from '../representation/model.js'

/** Why one carrier entered the emitted unit's physical closure. */
export interface EmissionRepresentationReason {
  readonly kind:
    | 'body-value'
    | 'body-abi'
    | 'operation-operand'
    | 'operation-result'
    | 'capture-receiver'
    | 'capture-cell'
    | 'retained-placement'
    | 'retained-class'
    | 'class-field'
    | 'class-static-field'
    | 'class-construct'
    | 'class-instance'
    | 'native-layout'
    | 'conversion-source'
    | 'conversion-target'
    | 'fallback-plan-root'
  readonly owner: string
  readonly detail: string
}

/** One carrier in the readonly closure, with all provenance that retained it. */
export interface EmissionRepresentationEntry {
  readonly representation: Representation
  readonly reasons: readonly EmissionRepresentationReason[]
}

export interface EmissionRepresentationInput {
  /** Bodies after generator splitting, shaking, and any final IR rewrites. */
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  /** Binding placements for that same final body set. */
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** Class layouts after the same final reachability pass. */
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Resolves authenticated ancestor storage without inventing executable class lifecycle. */
  readonly resolveClassRef?: PhysicalClassRefResolver
  /** The deriver that sealed the representations supplied by the pipeline. */
  readonly deriver: RepresentationDeriver
  /** Conversion authority used by retained conversion operations. */
  readonly conversions: ConversionCensus
  /** Region cells the shaker proved are not named by the retained IR. */
  readonly omitGlobals?: ReadonlySet<DeclarationId>
  /** Whether the body/class set is a complete reachable emission set. */
  readonly complete: boolean
  /** All selected-plan carriers, supplied only so an incomplete run can fail closed. */
  readonly fallbackRoots?: readonly Representation[]
}

export interface EmissionRepresentationPublication {
  /** Distinct carriers in deterministic first-discovery order. */
  readonly representations: readonly Representation[]
  /** False when the retained set was incomplete or cited a missing conversion node. */
  readonly complete: boolean
  /** Direct roots before nested/native nominal closure. */
  readonly roots: readonly EmissionRepresentationEntry[]
  /** Closure entries keyed by representationKey plus recursive role where needed, including root reasons. */
  readonly closure: ReadonlyMap<string, EmissionRepresentationEntry>
  /** Every reason a carrier was retained, keyed by the closure key. */
  readonly reasons: ReadonlyMap<string, readonly EmissionRepresentationReason[]>
  /** Final class declarations reached from retained carriers or retained member bodies. */
  readonly retainedClasses: ReadonlySet<DeclarationId>
  /** Final placements named by retained operations or capture facts. */
  readonly retainedPlacements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** Conversion nodes cited by retained IR and computed-read recipes. */
  readonly conversions: ReadonlyMap<ConversionNodeId, ConversionNode>
  /** Cited conversion ids for which the conversion authority had no node. */
  readonly missingConversions: readonly ConversionNodeId[]
  /** Recursive reference identities whose definition could not be recovered from the deriver. */
  readonly missingDefinitions: readonly string[]
}

const abiCarriersOf = (abi: CallableAbi): readonly Representation[] => [
  ...abi.parameters.map((parameter) => parameter.value),
  abi.result,
  ...(abi.receiver ? [abi.receiver] : [])
]

const operationOwnerOf = (body: IrBody, operation: IrOperation): string => `${String(body.owner)}:${operation.kind}`

const classBodyOwnersOf = (layout: ClassLayout): readonly (FunctionId | null)[] => [
  layout.constructor,
  ...layout.fields.map((field) => field.initializer),
  ...layout.methods.map((method) => method.callable),
  ...layout.accessors.flatMap((accessor) => [accessor.getter, accessor.setter]),
  ...layout.staticFields.map((field) => field.initializer),
  ...layout.staticMethods.map((method) => method.callable),
  ...layout.staticAccessors.flatMap((accessor) => [accessor.getter, accessor.setter])
]

/** Recursive definition/reference carriers intentionally share representationKey. */
const closureKeyOf = (representation: Representation): string => {
  const recursive = recursiveCarrierOf(representation)
  return recursive ? `${representationKey(representation)}#${recursive.role}` : representationKey(representation)
}

interface MutableEntry {
  readonly representation: Representation
  readonly reasons: Map<string, EmissionRepresentationReason>
}

/**
 * Publish the carrier closure consumed by emission.
 *
 * The input is deliberately the final IR/projection set. This function never
 * scans the sealed plan as a convenience: doing so would retain carriers for
 * dropped bodies and recreate the phantom-struct defect this census exists to
 * remove. `fallbackRoots` is the explicit fail-closed escape for an incomplete
 * shake, where a subset cannot safely stand in for the program.
 */
export const publishEmissionRepresentationsOf = (input: EmissionRepresentationInput): EmissionRepresentationPublication => {
  const entries = new Map<string, MutableEntry>()
  const rootEntries = new Map<string, MutableEntry>()
  const queue: Array<{ representation: Representation; reason: EmissionRepresentationReason; root: boolean }> = []
  const queued = new Set<string>()
  let queueCursor = 0
  const expanded = new Set<string>()
  const retainedClassReasons = new Map<DeclarationId, EmissionRepresentationReason>()
  const queuedClasses = new Set<DeclarationId>()
  const retainedPlacementDeclarations = new Set<DeclarationId>()
  const citedConversionIds = new Set<ConversionNodeId>()
  const missingConversions = new Set<ConversionNodeId>()
  const missingDefinitions = new Set<string>()

  const reasonKeyOf = (reason: EmissionRepresentationReason): string => `${reason.kind}|${reason.owner}|${reason.detail}`

  const addReason = (table: Map<string, MutableEntry>, representation: Representation, reason: EmissionRepresentationReason): void => {
    const key = closureKeyOf(representation)
    const existing = table.get(key)
    if (!existing) {
      table.set(key, { representation, reasons: new Map([[reasonKeyOf(reason), reason]]) })
      return
    }
    existing.reasons.set(reasonKeyOf(reason), reason)
  }

  const enqueue = (representation: Representation, reason: EmissionRepresentationReason, root = false): void => {
    addReason(root ? rootEntries : entries, representation, reason)
    const key = closureKeyOf(representation)
    if (expanded.has(key) || queued.has(key)) return
    queued.add(key)
    queue.push({ representation, reason, root })
  }

  const citeConversion = (id: ConversionNodeId, owner: string): void => {
    if (citedConversionIds.has(id)) return
    citedConversionIds.add(id)
    const node = input.conversions.nodeById(id)
    if (!node) {
      missingConversions.add(id)
      return
    }
    enqueue(node.source, { kind: 'conversion-source', owner, detail: id })
    enqueue(node.target, { kind: 'conversion-target', owner, detail: id })
  }

  const citeOperand = (body: IrBody, operation: IrOperation, operand: IrOperand, kind: 'operation-operand' | 'operation-result'): void => {
    enqueue(operand.representation, { kind, owner: operationOwnerOf(body, operation), detail: String(operand.value) }, true)
  }

  // First collect the direct IR roots. Values and operation operands overlap
  // intentionally: their separate reasons tell target consumers whether a
  // carrier is needed by an emitted slot or by an operation's ABI.
  for (const body of input.bodies.values()) {
    for (const [value, representation] of body.values) {
      enqueue(representation, { kind: 'body-value', owner: String(body.owner), detail: String(value) }, true)
    }
    if (body.abi)
      for (const representation of abiCarriersOf(body.abi))
        enqueue(representation, { kind: 'body-abi', owner: String(body.owner), detail: 'call ABI' }, true)
    if (body.construct)
      for (const representation of abiCarriersOf(body.construct))
        enqueue(representation, { kind: 'body-abi', owner: String(body.owner), detail: 'construct ABI' }, true)
    if (body.facts?.capturedReceiver)
      enqueue(body.facts.capturedReceiver, { kind: 'capture-receiver', owner: String(body.owner), detail: 'captured receiver' }, true)
    for (const declaration of [
      ...(body.facts?.capturedDeclarations ?? []),
      ...(body.facts ? [...body.facts.boxed] : []),
      ...(body.facts ? [...body.facts.requiresEarlyBox] : [])
    ]) {
      retainedPlacementDeclarations.add(declaration)
      const placement = input.placements.get(declaration)
      if (placement?.representation && !input.omitGlobals?.has(declaration))
        enqueue(placement.representation, { kind: 'capture-cell', owner: String(body.owner), detail: String(declaration) }, true)
    }
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        for (const operand of operandsOfIrOperation(operation)) citeOperand(body, operation, operand, 'operation-operand')
        const result = resultOfIrOperation(operation)
        if (result) citeOperand(body, operation, { value: result.id, representation: result.representation }, 'operation-result')
        if (operation.kind === 'convert') citeConversion(operation.conversionUse, operationOwnerOf(body, operation))
        if (operation.kind === 'get' && operation.nativeFieldOwnerRead) {
          const recipe = operation.nativeFieldOwnerRead
          citeConversion(recipe.missing, operationOwnerOf(body, operation))
          for (const arm of recipe.arms) citeConversion(arm.conversion, operationOwnerOf(body, operation))
          for (const member of recipe.members)
            enqueue(
              member,
              { kind: 'operation-operand', owner: operationOwnerOf(body, operation), detail: 'native field-owner class identity' },
              true
            )
        }
        if (operation.kind === 'merge-live-arm-rebuild' && operation.nativeTransport) {
          for (const arm of operation.nativeTransport.arms) citeConversion(arm.conversion, operationOwnerOf(body, operation))
          if (operation.nativeTransport.absence) citeConversion(operation.nativeTransport.absence, operationOwnerOf(body, operation))
        }
        if (operation.kind === 'call' && operation.fixedDataDefinition)
          citeConversion(operation.fixedDataDefinition.conversion, operationOwnerOf(body, operation))
        if (operation.kind === 'call')
          for (const value of operation.objectValueConversions ?? []) citeConversion(value.conversion, operationOwnerOf(body, operation))
        if (operation.kind === 'get' && operation.typedComputedRead) {
          for (const arm of operation.typedComputedRead.arms) citeConversion(arm.conversion, operationOwnerOf(body, operation))
          if (operation.typedComputedRead.receiverBounded)
            citeConversion(operation.typedComputedRead.receiverBounded.missing, operationOwnerOf(body, operation))
        }
        if (operation.kind === 'binding-read' || operation.kind === 'binding-write')
          retainedPlacementDeclarations.add(operation.declaration)
      }
    }
  }

  // The target emits every non-local placement (region/global and host
  // boundaries) from its placement tables. Local cells are emitted only when
  // the final IR or capture facts name them; otherwise there is no frame slot
  // to materialize. `omitGlobals` applies only to the local liveness set here:
  // global storage, externs, and absent definitions remain target declarations.
  const retainedPlacements = new Map<DeclarationId, BindingPlacement>()
  for (const [declaration, placement] of input.placements) {
    if (input.omitGlobals?.has(declaration) && (placement.storage.kind === 'local' || placement.storage.kind === 'region')) continue
    if (placement.storage.kind === 'local' && !retainedPlacementDeclarations.has(declaration)) continue
    retainedPlacements.set(declaration, placement)
    if (placement.representation)
      enqueue(placement.representation, { kind: 'retained-placement', owner: String(declaration), detail: placement.storage.kind }, true)
  }

  // Every class in the final shaken class map is rendered by the target. Seed
  // them all; class-ref discovery below still feeds the same queue so nominal
  // layouts reached through nested carriers cannot be missed.
  const bodyOwners = new Set<string>([...input.bodies.values()].map((body) => String(body.sourceOwner)))
  for (const [declaration, layout] of input.classes) {
    const memberBodyRetained = classBodyOwnersOf(layout).some((owner) => owner !== null && bodyOwners.has(String(owner)))
    retainedClassReasons.set(declaration, {
      kind: 'retained-class',
      owner: String(declaration),
      detail: memberBodyRetained ? 'retained member body' : 'final class layout'
    })
  }

  const classQueue: DeclarationId[] = []
  const markClass = (declaration: DeclarationId, detail: string): void => {
    if (retainedClassReasons.has(declaration)) {
      if (!queuedClasses.has(declaration) && !expandedClasses.has(declaration)) {
        queuedClasses.add(declaration)
        classQueue.push(declaration)
      }
      return
    }
    retainedClassReasons.set(declaration, { kind: 'retained-class', owner: String(declaration), detail })
    queuedClasses.add(declaration)
    classQueue.push(declaration)
  }

  const expandedClasses = new Set<DeclarationId>()
  for (const declaration of retainedClassReasons.keys()) markClass(declaration, 'final class layout')
  const expandClassQueue = (): void => {
    while (classQueue.length > 0) {
      const declaration = classQueue.pop()
      if (!declaration || expandedClasses.has(declaration)) continue
      expandedClasses.add(declaration)
      const layout = input.classes.get(declaration)
      if (!layout) continue
      if (layout.instance)
        enqueue(layout.instance, { kind: 'class-instance', owner: String(declaration), detail: 'class instance carrier' }, true)
      if (layout.construct)
        for (const representation of abiCarriersOf(layout.construct))
          enqueue(representation, { kind: 'class-construct', owner: String(declaration), detail: 'class construct ABI' }, true)
      for (const field of layout.nativeStorage?.fields.map((field) => ({ key: field.key, representation: field.value })) ?? layout.fields)
        if (field.representation)
          enqueue(field.representation, { kind: 'class-field', owner: String(declaration), detail: field.key }, true)
      for (const field of layout.staticFields)
        if (field.representation)
          enqueue(field.representation, { kind: 'class-static-field', owner: String(declaration), detail: field.key }, true)
      if (layout.nativeBase)
        enqueue(
          layout.nativeBase.instance,
          { kind: 'class-instance', owner: String(declaration), detail: 'native base instance carrier' },
          true
        )
      if (layout.base) markClass(layout.base, `base of ${String(declaration)}`)
    }
  }
  expandClassQueue()

  // Complete the representation closure. walkRepresentation covers all
  // ordinary nested carriers; nominal layout expansion above is the only
  // compiler-context-dependent extension.
  const ordered = new Map<string, Representation>()
  const drainRepresentations = (): void => {
    while (queueCursor < queue.length) {
      const item = queue[queueCursor++]
      if (!item) continue
      const key = closureKeyOf(item.representation)
      const entry = entries.get(key) ?? rootEntries.get(key)
      if (entry && !entries.has(key)) entries.set(key, entry)
      if (!ordered.has(key)) ordered.set(key, item.representation)
      if (expanded.has(key)) continue
      expanded.add(key)
      for (const child of walkRepresentation(item.representation)) {
        if (child === item.representation) continue
        if (child.kind === 'class-ref') markClass(child.declaration, `carrier ${representationKey(child)}`)
        const childReason: EmissionRepresentationReason = {
          kind: item.root ? item.reason.kind : 'operation-result',
          owner: item.reason.owner,
          detail: `nested in ${key}`
        }
        enqueue(child, childReason)
      }
      if (item.representation.kind === 'class-ref') {
        markClass(item.representation.declaration, `carrier ${representationKey(item.representation)}`)
        const runtimeLayout = input.classes.get(item.representation.declaration)
        const base = runtimeLayout ? runtimeLayout.base : (item.representation.ancestors[0] ?? null)
        if (base !== null && !runtimeLayout?.nativeBase) {
          const instance = input.classes.get(base)?.instance ?? input.resolveClassRef?.(base)
          if (instance?.kind === 'class-ref')
            enqueue(instance, { kind: 'class-instance', owner: String(base), detail: 'retained physical base' })
        }
      }
      if (item.representation.kind === 'native-record-ref' && item.representation.recursive?.role === 'reference') {
        const layout = input.deriver.layoutOf(item.representation.recursive.type)
        const recursive = recursiveCarrierOf(layout)
        const isDefinition =
          recursive?.type === item.representation.recursive.type &&
          recursive.role === 'definition' &&
          (layout.kind === 'array-object' ||
            layout.kind === 'keyed-collection' ||
            layout.kind === 'dictionary' ||
            layout.kind === 'function-value-dispatch')
        if (isDefinition) {
          const reason: EmissionRepresentationReason = {
            kind: 'native-layout',
            owner: item.reason.owner,
            detail: `recursive definition ${item.representation.recursive.type}`
          }
          enqueue(layout, reason)
        } else {
          missingDefinitions.add(String(item.representation.recursive.type))
        }
      } else if (
        (item.representation.kind === 'native-record-ref' || item.representation.kind === 'class-ref') &&
        (item.representation.kind !== 'native-record-ref' ||
          (item.representation.native === null && item.representation.recursive === undefined))
      ) {
        const rawLayout = input.deriver.layoutOf(item.representation.shapeId as StructuralTypeId)
        const nativeStorage =
          item.representation.kind === 'class-ref' ? input.classes.get(item.representation.declaration)?.nativeStorage : undefined
        const layout =
          nativeStorage !== undefined && (rawLayout.kind === 'record' || rawLayout.kind === 'record-with-index')
            ? { ...rawLayout, fields: nativeStorage.fields }
            : rawLayout
        const reason: EmissionRepresentationReason = {
          kind: 'native-layout',
          owner: item.reason.owner,
          detail: item.representation.shapeId
        }
        for (const child of walkRepresentation(layout)) {
          if (child === layout) continue
          enqueue(child, reason)
        }
      }
    }
  }
  drainRepresentations()
  while (classQueue.length > 0) {
    expandClassQueue()
    drainRepresentations()
  }

  // Incomplete shake or an IR that cites a conversion the authority cannot
  // resolve cannot safely drive a reduced target closure. Reintroduce the
  // caller-supplied plan roots and report the incomplete status; never guess.
  const complete = input.complete && missingConversions.size === 0 && missingDefinitions.size === 0
  if (!complete) {
    for (const representation of input.fallbackRoots ?? [])
      enqueue(representation, { kind: 'fallback-plan-root', owner: 'sealed-plan', detail: 'incomplete emission census' }, true)
    drainRepresentations()
    while (classQueue.length > 0) {
      expandClassQueue()
      drainRepresentations()
    }
  }

  const closure = new Map<string, EmissionRepresentationEntry>()
  const publishedEntryOf = (entry: MutableEntry): EmissionRepresentationEntry => ({
    representation: entry.representation,
    reasons: Object.freeze([...entry.reasons.values()])
  })
  for (const [key, representation] of ordered) {
    const nested = entries.get(key)
    const direct = rootEntries.get(key)
    if (!nested && !direct) {
      closure.set(key, { representation, reasons: [] })
      continue
    }
    const unique = new Map<string, EmissionRepresentationReason>()
    for (const reason of [...(nested?.reasons.values() ?? []), ...(direct?.reasons.values() ?? [])]) unique.set(reasonKeyOf(reason), reason)
    closure.set(key, { representation: nested?.representation ?? direct!.representation, reasons: Object.freeze([...unique.values()]) })
  }
  const reasons = new Map<string, readonly EmissionRepresentationReason[]>()
  for (const [key, entry] of closure) reasons.set(key, entry.reasons)
  return Object.freeze({
    representations: Object.freeze([...ordered.values()]),
    complete,
    roots: Object.freeze([...rootEntries.values()].map(publishedEntryOf)),
    closure,
    reasons,
    retainedClasses: new Set(retainedClassReasons.keys()),
    retainedPlacements,
    conversions: new Map(
      [...citedConversionIds]
        .map((id) => [id, input.conversions.nodeById(id)] as const)
        .filter((row): row is readonly [ConversionNodeId, ConversionNode] => row[1] !== null)
    ),
    missingConversions: Object.freeze([...missingConversions]),
    missingDefinitions: Object.freeze([...missingDefinitions])
  })
}
