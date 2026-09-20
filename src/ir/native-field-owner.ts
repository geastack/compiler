import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeSumPlan } from '../conversion/native-sum.js'
import { operationOfResult, type DeclarationId, type OperationId, type PhysicalBodyId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { projectNativeClassStorage } from '../projection/class-storage.js'
import { extendsClass } from '../projection/dispatch.js'
import { classMemberOf } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type GetOperation, type IrBody } from './model.js'
import type { ReflectionExposure } from './reflection-demand.js'

type ClassRef = Extract<Representation, { kind: 'class-ref' }>

/** The physical class identity selects a native field; a missing field remains undefined. */
export interface NativeFieldOwnerRead {
  readonly receiver: string
  readonly result: string
  readonly key: string
  readonly members: readonly ClassRef[]
  readonly arms: readonly { readonly member: ClassRef; readonly source: Representation; readonly conversion: ConversionNodeId }[]
  readonly missing: ConversionNodeId
}

const familyOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId): readonly ClassLayout[] =>
  [...classes.values()].filter((entry) => entry.declaration === declaration || extendsClass(classes, entry.declaration, declaration))

const nativeConversion = (source: Representation, target: Representation, conversions: ConversionCensus): ConversionNodeId | null => {
  if (nativeSumPlan(source, target) === null) return null
  const node = conversions.nodeFor(source, target)
  const capability = node.capability
  return capability.kind === 'identity' ||
    ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
      capability.materializer.nativeFieldProtocol === 'unused')
    ? node.id
    : null
}

const readRecipeOf = (
  operation: GetOperation,
  key: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus
): NativeFieldOwnerRead | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const missing = nativeConversion({ kind: 'undefined' }, operation.result.representation, conversions)
  if (missing === null) return null
  const members: ClassRef[] = []
  const arms: NativeFieldOwnerRead['arms'][number][] = []
  for (const layout of familyOf(classes, receiver.declaration)) {
    if (layout.instance?.kind !== 'class-ref' || layout.nativeBase !== null || layout.nativeStorage === undefined) return null
    const site = classMemberOf(classes, layout.declaration, key)
    if (site !== null && site.kind !== 'field') return null
    members.push(layout.instance)
    const field = layout.nativeStorage.fields.find((entry) => entry.key === key)
    if (!field) continue
    const conversion = nativeConversion(field.value, operation.result.representation, conversions)
    if (conversion === null) return null
    arms.push({ member: layout.instance, source: field.value, conversion })
  }
  return { receiver: representationKey(receiver), result: representationKey(operation.result.representation), key, members, arms, missing }
}

/** Certification checks the exact field layout, class coverage and conversion citations. */
export const nativeFieldOwnerReadMatches = (
  operation: GetOperation,
  key: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  exposure: ReflectionExposure | undefined
): boolean => {
  const recipe = operation.nativeFieldOwnerRead
  const receiver = operation.receiver.representation
  if (
    !recipe ||
    !exposure?.complete ||
    receiver.kind !== 'class-ref' ||
    recipe.key !== key ||
    recipe.receiver !== representationKey(receiver) ||
    recipe.result !== representationKey(operation.result.representation)
  )
    return false
  const family = familyOf(classes, receiver.declaration)
  if (family.length !== recipe.members.length || new Set(recipe.members.map((member) => member.declaration)).size !== family.length)
    return false
  const matches = (id: ConversionNodeId, source: Representation): boolean => {
    const node = conversions.nodeById(id)
    if (!node || representationKey(node.source) !== representationKey(source) || representationKey(node.target) !== recipe.result)
      return false
    const capability = node.capability
    return (
      capability.kind === 'identity' ||
      ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
        capability.materializer.nativeFieldProtocol === 'unused')
    )
  }
  let fields = 0
  for (const layout of family) {
    if (exposure.classes.get(layout.declaration)?.level !== 'keys-only' || layout.nativeStorage === undefined || layout.nativeBase !== null)
      return false
    const site = classMemberOf(classes, layout.declaration, recipe.key)
    if (site !== null && site.kind !== 'field') return false
    const member = recipe.members.find((entry) => entry.declaration === layout.declaration)
    if (!member || !layout.instance || representationKey(member) !== representationKey(layout.instance)) return false
    const field = layout.nativeStorage.fields.find((entry) => entry.key === key)
    const arms = recipe.arms.filter((entry) => entry.member.declaration === layout.declaration)
    if (!field) {
      if (arms.length !== 0) return false
      continue
    }
    fields++
    const arm = arms[0]
    if (
      arms.length !== 1 ||
      !arm ||
      representationKey(arm.member) !== representationKey(member) ||
      representationKey(arm.source) !== representationKey(field.value) ||
      !matches(arm.conversion, field.value)
    )
      return false
  }
  return fields === recipe.arms.length && matches(recipe.missing, { kind: 'undefined' })
}

/**
 * Relocate storage and its reads as one publication, after the existing
 * reflection census has proved the family cannot acquire unknown properties.
 * Structural views and writes still contribute demand through the same slot
 * census as the initial layout. A candidate read never removes those demands.
 */
export const finalizeNativeFieldOwnership = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver,
  conversions: ConversionCensus,
  exposure: ReflectionExposure,
  usesWithoutReads: (reads: ReadonlySet<OperationId>) => ReadonlyMap<DeclarationId, ReadonlySet<string>>
): { readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>; readonly classes: ReadonlyMap<DeclarationId, ClassLayout> } => {
  const unchanged = { bodies, classes }
  if (!exposure.complete) return unchanged
  const reads = new Map<GetOperation, string>()
  const readKeys = new Map<GetOperation, string>()
  const ignored = new Set<OperationId>()
  for (const body of bodies.values()) {
    const constants = new Map(
      [...body.blocks.values()].flatMap((block) =>
        block.operations.flatMap((op) => (op.kind === 'constant' && op.literal === 'string' ? [[op.result.id, op.text] as const] : []))
      )
    )
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'class-ref') continue
        const key = constants.get(operation.key.value)
        if (key === undefined) continue
        readKeys.set(operation, key)
        if (operation.reactive || operation.hostMethod || !block.operations.includes(operation)) continue
        const site = classMemberOf(classes, operation.receiver.representation.declaration, key)
        if (site?.kind !== 'field') continue
        const ownership = classes.get(site.owner)?.fieldOwnership.find((entry) => entry.key === key)
        if (!ownership || ownership.physicalOwners.length === 0) continue
        if (!familyOf(classes, site.owner).every((entry) => exposure.classes.get(entry.declaration)?.level === 'keys-only')) continue
        if (!readRecipeOf(operation, key, classes, conversions)) continue
        reads.set(operation, key)
        ignored.add(operationOfResult(operation.lineage))
      }
  }
  if (reads.size === 0) return unchanged
  const storage = projectNativeClassStorage(classes, deriver, usesWithoutReads(ignored))
  const relocated = new Map(
    [...classes].map(([id, layout]) => [id, storage.has(id) ? { ...layout, nativeStorage: storage.get(id)! } : layout])
  )
  const replacements = new Map<GetOperation, GetOperation>()
  // Validate every surviving read whose old slot vanished, including reads
  // introduced by lowering rather than a source property operation.
  for (const body of bodies.values())
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'class-ref') continue
        const key = readKeys.get(operation)
        if (key === undefined) continue
        const old = classes.get(operation.receiver.representation.declaration)
        if (!old?.nativeStorage?.fields.some((field) => field.key === key)) continue
        const layout = relocated.get(operation.receiver.representation.declaration)
        if (layout?.nativeStorage?.fields.some((field) => field.key === key)) continue
        if (!reads.has(operation)) return unchanged
        const recipe = readRecipeOf(operation, key, relocated, conversions)
        if (!recipe) return unchanged
        const replacement = { ...operation, nativeFieldOwnerRead: recipe }
        if (!nativeFieldOwnerReadMatches(replacement, key, relocated, conversions, exposure)) return unchanged
        replacements.set(operation, replacement)
      }
  if (replacements.size === 0) return unchanged
  const finalized = new Map(
    [...bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) =>
                operation.kind === 'get' ? (replacements.get(operation) ?? operation) : operation
              )
            }
          ])
        )
      }
    ])
  )
  return { bodies: finalized, classes: relocated }
}
