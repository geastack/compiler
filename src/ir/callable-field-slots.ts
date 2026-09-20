import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { classMemberOf } from '../projection/fields.js'
import { representationKey, walkRepresentation, type Representation } from '../representation/model.js'
import type { IrBody, IrOperand, IrOperation } from './model.js'
import type { ReflectionExposure } from './reflection-demand.js'
import { nativeClassOriginsOf } from './native-class-origins.js'

export interface CallableFieldSlots {
  readonly reads: ReadonlyMap<IrValueId, readonly IrOperand[]>
  readonly stores: ReadonlyMap<IrOperation, readonly IrOperand[]>
  readonly initializerReturns: ReadonlySet<IrOperation>
}

/**
 * Native class slots transport their stored records only after the reflection
 * census proves that the containing objects expose no payload protocol and
 * allocation provenance authenticates the actual receiver. All
 * stores and initializer returns remain provenance sources, so a mutation
 * through any field read can invalidate the original allocation's identity.
 * This publishes aliases; it neither chooses storage nor changes access code.
 */
export const callableFieldSlotsOf = (
  bodies: readonly IrBody[],
  operations: readonly IrOperation[],
  producers: ReadonlyMap<IrValueId, IrOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  exposure: ReflectionExposure | undefined,
  isRecord: (value: Representation) => boolean,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  deriver: RepresentationDeriver | null,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): CallableFieldSlots => {
  const reads = new Map<IrValueId, readonly IrOperand[]>()
  const stores = new Map<IrOperation, readonly IrOperand[]>()
  const initializerReturns = new Set<IrOperation>()
  if (!exposure?.complete) return { reads, stores, initializerReturns }
  const referencesOf = (value: Representation): readonly DeclarationId[] | null => {
    if (value.kind === 'class-ref') return [value.declaration]
    if (value.kind === 'optional') return referencesOf(value.payload)
    if (value.kind === 'borrowed-ref') return referencesOf(value.referent)
    if (value.kind === 'undefined' || value.kind === 'null') return []
    if (value.kind !== 'tagged-union') return null
    const references = value.arms.map((arm) => referencesOf(arm.value))
    return references.every((arm) => arm !== null) ? [...new Set(references.flat())] : null
  }
  const keyOf = (operand: IrOperand): string | null => {
    const key = producers.get(operand.value)
    return key?.kind === 'constant' && key.literal === 'string' ? key.text : null
  }
  const related = (left: DeclarationId, right: DeclarationId): boolean =>
    left === right || extendsClass(classes, left, right) || extendsClass(classes, right, left)
  const convertedClasses = new Set<DeclarationId>()
  const visitedConversions = new Set<Representation>()
  const blockConvertedClasses = (value: Representation): void => {
    for (const nested of walkRepresentation(value, visitedConversions)) {
      if (nested.kind === 'class-ref') {
        convertedClasses.add(nested.declaration)
        for (const field of classes.get(nested.declaration)?.nativeStorage?.fields ?? []) blockConvertedClasses(field.value)
      } else if (nested.kind === 'native-record-ref') {
        const layout = deriver?.layoutOf(nested.shapeId as never)
        if (layout) blockConvertedClasses(layout)
        else for (const declaration of classes.keys()) convertedClasses.add(declaration)
      }
    }
  }
  for (const operation of operations) {
    if (
      operation.kind !== 'convert' ||
      representationKey(operation.source.representation) === representationKey(operation.result.representation) ||
      nativeClassReferenceTransportMatches(
        operation.source.representation,
        operation.result.representation,
        conversions?.nodeById(operation.conversionUse)
      )
    )
      continue
    // Structural views can expose shared nested records without another class
    // field read. Until those aliases are indexed, they revoke field transport.
    blockConvertedClasses(operation.source.representation)
    blockConvertedClasses(operation.result.representation)
  }
  const initializers = new Map<string, { readonly owners: DeclarationId[]; readonly keys: string[] }>()
  for (const layout of classes.values())
    for (const field of layout.fields) {
      if (field.initializer === null) continue
      const entry = initializers.get(field.initializer) ?? { owners: [], keys: [] }
      entry.owners.push(layout.declaration)
      entry.keys.push(field.key)
      initializers.set(field.initializer, entry)
    }
  const returns = new Map<string, readonly Extract<IrOperation, { kind: 'return' }>[] | null>()
  for (const body of bodies) {
    const values = [...body.blocks.values()].flatMap((block) => (block.terminator.kind === 'return' ? [block.terminator] : []))
    returns.set(body.sourceOwner, returns.has(body.sourceOwner) || values.some((operation) => operation.value === null) ? null : values)
  }
  const writes: {
    readonly owners: readonly DeclarationId[]
    readonly key: string
    readonly value: IrOperand
    readonly operation: IrOperation
  }[] = []
  for (const operation of operations) {
    if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
    const owners = referencesOf(operation.receiver.representation)
    const key = keyOf(operation.key)
    if (owners?.length && key !== null) writes.push({ owners, key, value: operation.value, operation })
  }
  const eligible = (owners: readonly DeclarationId[], key: string): boolean => {
    if (owners.length === 0) return false
    return (
      [...classes.values()]
        .filter((layout) => owners.some((owner) => related(owner, layout.declaration)))
        .every((layout) => {
          const member = classMemberOf(classes, layout.declaration, key)
          return (
            layout.nativeStorage !== undefined &&
            !convertedClasses.has(layout.declaration) &&
            exposure.classes.get(layout.declaration)?.level === 'keys-only' &&
            (member === null || member.kind === 'field')
          )
        }) && owners.every((owner) => classes.get(owner)?.nativeStorage?.fields.some((field) => field.key === key))
    )
  }
  const sourceCache = new Map<string, readonly IrOperand[] | null>()
  const sourcesOf = (owners: readonly DeclarationId[], key: string): readonly IrOperand[] | null => {
    const cacheKey = JSON.stringify([owners, key])
    if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey)!
    if (!eligible(owners, key)) {
      sourceCache.set(cacheKey, null)
      return null
    }
    const sources = writes
      .filter((write) => write.key === key && write.owners.some((source) => owners.some((owner) => related(owner, source))))
      .map((write) => write.value)
    for (const [id, initializer] of initializers) {
      if (
        !initializer.keys.some(
          (candidate, index) => candidate === key && owners.some((owner) => related(owner, initializer.owners[index]!))
        )
      )
        continue
      const values = returns.get(id)
      if (!values) {
        sourceCache.set(cacheKey, null)
        return null
      }
      for (const operation of values) sources.push(operation.value!)
    }
    const result = sources.length > 0 ? sources : null
    sourceCache.set(cacheKey, result)
    return result
  }
  const provenance = nativeClassOriginsOf(
    bodies,
    operations,
    producers,
    placements,
    classes,
    (operation) => {
      const owners = referencesOf(operation.receiver.representation)
      const key = keyOf(operation.key)
      return owners?.length && key !== null ? sourcesOf(owners, key) : null
    },
    conversions
  )
  for (const operation of operations) {
    if (operation.kind !== 'get' || !isRecord(operation.result.representation)) continue
    const owners = referencesOf(operation.receiver.representation)
    const key = keyOf(operation.key)
    if (!owners?.length || key === null || !provenance.owned(operation.receiver.value)) continue
    const sources = sourcesOf(owners, key)
    if (sources) reads.set(operation.result.id, sources)
  }
  for (const write of writes) {
    if (
      !isRecord(write.value.representation) ||
      !(
        (write.operation.kind === 'set' || write.operation.kind === 'define-own-property') &&
        provenance.owned(write.operation.receiver.value)
      )
    )
      continue
    const sources = sourcesOf(write.owners, write.key)
    if (sources) stores.set(write.operation, sources)
  }
  for (const [id, initializer] of initializers) {
    if (!provenance.closedInitializer(id as FunctionId)) continue
    if (!initializer.owners.every((owner, index) => eligible([owner], initializer.keys[index]!))) continue
    for (const operation of returns.get(id) ?? []) initializerReturns.add(operation)
  }
  return { reads, stores, initializerReturns }
}
