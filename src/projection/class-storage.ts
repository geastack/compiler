import type { DeclarationId, OperationId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf } from '../semantics/model/operands.js'
import type { ClassLayout } from './classes.js'
import type { SlotCensus } from './slots.js'
import { abiOfCallee } from './callee.js'
import { recordFieldsOfShape } from './fields.js'

/** Physical slots are separate from the flattened checker view and overlay evidence. */
export interface NativeClassStorage {
  readonly fields: readonly RecordField[]
  readonly omittedOverlays: readonly string[]
}

/**
 * Keep an overlay until every native access through that ancestor has a
 * descendant-storage dispatch path. An unused overlay needs no such bridge.
 * Runtime-key accesses use the object's own-property protocol. That protocol
 * dispatches on the concrete instance and needs its real fields, not a copy
 * of every possible descendant field in an ancestor.
 */
export const nativeClassFieldUsesOf = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  slots: SlotCensus,
  ownerDispatchedReads: ReadonlySet<OperationId> = new Set()
): ReadonlyMap<DeclarationId, ReadonlySet<string>> => {
  const used = new Map<DeclarationId, Set<string>>()
  const mark = (receiver: Representation, key: string | null): void => {
    if (receiver.kind === 'optional') return mark(receiver.payload, key)
    if (receiver.kind === 'borrowed-ref') return mark(receiver.referent, key)
    if (receiver.kind === 'tagged-union') {
      for (const arm of receiver.arms) mark(arm.value, key)
      return
    }
    if (receiver.kind !== 'class-ref') return
    let declaration: DeclarationId | null = receiver.declaration
    const seen = new Set<DeclarationId>()
    const shadowed = new Set<string>()
    while (declaration !== null && !seen.has(declaration)) {
      seen.add(declaration)
      const layout = classes.get(declaration)
      if (!layout) return
      for (const field of layout.fields) {
        if ((key !== null && field.key !== key) || shadowed.has(field.key)) continue
        shadowed.add(field.key)
        if (!field.syntheticSubclassMemberOverlay) continue
        // Demand belongs to the receiver through which code accesses the
        // member. The ancestor supplied its type, not its allocation site.
        const fields = used.get(receiver.declaration) ?? new Set<string>()
        fields.add(field.key)
        used.set(receiver.declaration, fields)
      }
      declaration = layout.base
    }
  }
  // A structural view reads fields even though the graph contains no `get`
  // for each copied member. Ask the slot authority for the destination, then
  // retain the native members that this source/target pair can read. This
  // records demand only; conversion admission remains the conversion census's.
  const viewed = new Set<string>()
  const fieldsOf = (value: Representation): readonly RecordField[] => {
    if (value.kind === 'record' || value.kind === 'record-with-index') return value.fields
    if (value.kind === 'class-ref' || value.kind === 'native-record-ref') return recordFieldsOfShape(deriver, value.shapeId) ?? []
    return []
  }
  const view = (from: Representation, to: Representation): void => {
    const fromKey = representationKey(from)
    const toKey = representationKey(to)
    if (fromKey === toKey) return
    const key = `${fromKey}->${toKey}`
    if (viewed.has(key)) return
    viewed.add(key)
    if (from.kind === 'optional') return view(from.payload, to)
    if (to.kind === 'optional') return view(from, to.payload)
    if (from.kind === 'borrowed-ref') return view(from.referent, to)
    if (to.kind === 'borrowed-ref') return view(from, to.referent)
    if (from.kind === 'tagged-union') {
      for (const arm of from.arms) view(arm.value, to)
      return
    }
    if (to.kind === 'tagged-union') {
      for (const arm of to.arms) view(from, arm.value)
      return
    }
    if (to.kind === 'record' || to.kind === 'record-with-index' || to.kind === 'native-record-ref') {
      const sourceFields = fieldsOf(from)
      for (const field of fieldsOf(to)) {
        if (from.kind === 'class-ref') mark(from, field.key)
        const source = sourceFields.find((candidate) => candidate.key === field.key)
        if (source) view(source.value, field.value)
      }
    }
    if (from.kind === 'array-object' && to.kind === 'array-object') view(from.element, to.element)
    if (from.kind === 'dictionary' && to.kind === 'dictionary') view(from.value, to.value)
    if (from.kind === 'keyed-collection' && to.kind === 'keyed-collection') {
      view(from.key, to.key)
      if (from.value && to.value) view(from.value, to.value)
    }
    const sourceAbi = abiOfCallee(from)
    const targetAbi = abiOfCallee(to)
    if (sourceAbi && targetAbi) {
      view(sourceAbi.result, targetAbi.result)
      for (const [index, parameter] of targetAbi.parameters.entries()) {
        const source = sourceAbi.parameters[index]
        if (source) view(parameter.value, source.value)
      }
      if (sourceAbi.receiver && targetAbi.receiver) view(targetAbi.receiver, sourceAbi.receiver)
    }
  }
  for (const operation of graph.operations.values()) {
    for (const operand of operation.operands) {
      const target = slots.slotOf(operation, operand)
      if (target.kind !== 'slot') continue
      const source = slots.enteringCarrierOf(operation, operand)
      if (source) view(source, target.representation)
    }
    if (
      operation.family !== 'property' ||
      operation.internalMethod === 'own-property-keys' ||
      operation.internalMethod === 'has-property' ||
      operation.internalMethod === 'delete'
    )
      continue
    if (operation.internalMethod === 'get' && ownerDispatchedReads.has(operation.id)) continue
    // Presence and deletion dispatch through the concrete object's property
    // protocol, even for a constant key. Neither loads an ancestor payload;
    // allocating a synthetic slot for them hides the real descendant owner.
    const receiver = operandOf(operation, 'receiver')
    const key = operandOf(operation, 'key')
    if (!receiver) continue
    if (key?.source.kind !== 'constant') continue
    const carrier = receiver.source.kind === 'result' ? plan.selected.get(receiver.source.result) : undefined
    mark(carrier ?? deriver.derive(receiver.type), key.source.text)
  }
  return used
}

/**
 * Real inherited properties keep one slot. Synthetic fields without a native
 * ancestor access are removed; real descendant declarations then own their
 * own storage. Unclassified shape members retain the existing layout.
 */
export const projectNativeClassStorage = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver,
  uses: ReadonlyMap<DeclarationId, ReadonlySet<string>>
): ReadonlyMap<DeclarationId, NativeClassStorage> => {
  const planned = new Map<DeclarationId, NativeClassStorage>()
  const visiting = new Set<DeclarationId>()
  const rawFields = (layout: ClassLayout): readonly RecordField[] | null => {
    if (layout.instance?.kind !== 'class-ref') return null
    const record = deriver.layoutOf(layout.instance.shapeId as StructuralTypeId)
    if (record.kind !== 'record' && record.kind !== 'record-with-index') return null
    const overrides = layout.methodOverrides ?? []
    return [...record.fields.filter((field) => !overrides.some((override) => override.key === field.key)), ...overrides]
  }
  const visit = (declaration: DeclarationId): NativeClassStorage | null => {
    const known = planned.get(declaration)
    if (known) return known
    if (visiting.has(declaration)) return null
    const layout = classes.get(declaration)
    if (!layout) return null
    const raw = rawFields(layout)
    if (!raw) return null
    visiting.add(declaration)
    const base = layout.base === null ? null : classes.get(layout.base)
    const inherited = layout.base === null ? [] : (visit(layout.base)?.fields ?? (base ? rawFields(base) : null))
    if (inherited === null) return null
    const inheritedKeys = new Set(inherited.map((field) => field.key))
    const ancestorDeclarations = new Map<string, { readonly syntheticSubclassMemberOverlay: boolean }>()
    const walked = new Set<DeclarationId>()
    for (let current = layout.base; current !== null && !walked.has(current);) {
      walked.add(current)
      const ancestor = classes.get(current)
      if (!ancestor) break
      for (const field of ancestor.fields) if (!ancestorDeclarations.has(field.key)) ancestorDeclarations.set(field.key, field)
      current = ancestor.base
    }
    const declared = new Map(layout.fields.map((field) => [field.key, field]))
    const omittedOverlays: string[] = []
    const own = raw.filter((field) => {
      if (inheritedKeys.has(field.key)) return false
      const evidence = declared.get(field.key)
      if (evidence?.syntheticSubclassMemberOverlay && !uses.get(declaration)?.has(field.key)) {
        omittedOverlays.push(field.key)
        return false
      }
      if (evidence !== undefined || !ancestorDeclarations.has(field.key)) return true
      return ancestorDeclarations.get(field.key)?.syntheticSubclassMemberOverlay === true && uses.get(declaration)?.has(field.key) === true
    })
    // A retained overlay reserves a typed slot for a base-view access; it does
    // not create a JavaScript own property. Only a real write makes it present.
    const storage = {
      fields: [
        ...inherited,
        ...own.map((selected) => {
          // A post-lowering ownership publication moves the slot but does
          // not change its already-lowered value ABI. All loads and stores
          // keep the carrier the original storage census selected.
          const held = layout.nativeStorage?.fields.find((field) => field.key === selected.key)
          const field = held ? { ...selected, value: held.value, required: held.required } : selected
          return (declared.get(field.key) ?? ancestorDeclarations.get(field.key))?.syntheticSubclassMemberOverlay
            ? { ...field, required: false }
            : field
        })
      ],
      omittedOverlays
    }
    planned.set(declaration, storage)
    visiting.delete(declaration)
    return storage
  }
  for (const declaration of classes.keys()) visit(declaration)
  return planned
}
