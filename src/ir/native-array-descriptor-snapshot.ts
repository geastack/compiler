import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeArrayRootViewPlansOf } from '../conversion/array-view.js'
import { nativeDescriptorSnapshotPlanOf, type NativeDescriptorSnapshotPlan } from '../conversion/native-descriptor-snapshot.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { recordLayoutOfShapeId } from '../projection/fields.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type RecordField, type Representation } from '../representation/model.js'
import { nativeCallableFlowOf, type NativeCallableFlow } from './callable-class-flow.js'
import type { HostMethodAlias } from './host-method-aliases.js'
import { hostTemplateMemberOf } from './host-template-conversions.js'
import { authenticatedNativeHostMethodReadOf, intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { nativePropertyPrototypeAbsenceMatches } from './native-property-presence.js'
import { nativeCallableSourceAliasesOf } from './native-callable-argument.js'
import { observesNativeCarrierOnly, operandsOfIrOperation, resultOfIrOperation } from './queries.js'

export interface NativeArrayDescriptorSnapshot {
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly keyText: string
  readonly originalSources: readonly string[]
  readonly conversion: ConversionNodeId
}

export interface NativeArrayDescriptorReinstallation {
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly descriptor: IrOperand
  readonly captures: readonly IrValueId[]
}

export interface NativeArrayDescriptorSnapshotInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly conversions: ConversionCensus
  readonly deriver: RepresentationDeriver
  readonly calleeRendering: CalleeRenderingInput | undefined
  readonly hostMethodAliases?: ReadonlyMap<DeclarationId, HostMethodAlias>
}

const definitionMapOf = (body: IrBody): ReadonlyMap<IrValueId, IrOperation> =>
  new Map(
    [...body.blocks.values()].flatMap((block) =>
      [...allOperationsOf(block)].flatMap((operation) => {
        const result = resultOfIrOperation(operation)
        return result === null ? [] : [[result.id, operation] as const]
      })
    )
  )

type ArrayOperand = IrOperand & { readonly representation: Extract<Representation, { kind: 'array-object' }> }
interface NativeArrayDescriptorCall {
  readonly receiver: ArrayOperand
  readonly key: IrOperand
  readonly keyText: string
}

/** The preflight and actual receipt use the same ambient method and evaluated
 * argument frame. A spelling, stale marker or equal ABI cannot nominate work.
 */
const nativeArrayDescriptorCallOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  input: NativeArrayDescriptorSnapshotInput,
  member: 'getOwnPropertyDescriptor' | 'defineProperty'
): NativeArrayDescriptorCall | null => {
  const rendering = input.calleeRendering
  const id = operation.lineage === null ? undefined : rendering?.graph.results.get(operation.lineage)
  const semantic = id === undefined ? null : (rendering?.graph.operations.get(id) ?? null)
  const authenticated = authenticatedNativeHostMethodReadOf(operation, semantic, rendering, definitionOf)
  const receiver = operation.arguments[0]
  const key = operation.arguments[1]
  const constant = key === undefined ? null : definitionOf(key.value)
  const count = member === 'defineProperty' ? 3 : 2
  if (
    !authenticated ||
    authenticated.receipt.protocol !== 'ObjectConstructor' ||
    authenticated.receipt.member !== member ||
    semantic?.family !== 'invocation' ||
    operation.arguments.length !== count ||
    !Array.from({ length: count }, (_, ordinal) => ordinal).every((ordinal) =>
      intrinsicCallArgumentMatches(operation, semantic, ordinal, definitionOf)
    ) ||
    receiver?.representation.kind !== 'array-object' ||
    receiver.representation.ownership !== 'shared-refcount' ||
    key === undefined ||
    constant?.kind !== 'constant' ||
    (constant.literal !== 'string' && constant.literal !== 'number') ||
    (constant.text !== 'length' && canonicalIndexLiteral(constant.text) === null)
  )
    return null
  return { receiver: { ...receiver, representation: receiver.representation }, key, keyText: constant.text }
}

interface NativeArrayDescriptorCapture extends NativeArrayDescriptorCall {
  readonly target: Extract<Representation, { kind: 'optional' }>
  readonly fields: readonly RecordField[]
}

const nativeArrayDescriptorCaptureOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  input: NativeArrayDescriptorSnapshotInput
): NativeArrayDescriptorCapture | null => {
  const target = operation.result?.representation
  const receiver = operation.arguments[0]?.representation
  if (
    receiver?.kind !== 'array-object' ||
    receiver.ownership !== 'shared-refcount' ||
    receiver.extension !== null ||
    target?.kind !== 'optional' ||
    target.absence !== 'undefined'
  )
    return null
  const frame = nativeArrayDescriptorCallOf(operation, definitionOf, input, 'getOwnPropertyDescriptor')
  if (!frame) return null
  const payload = target.payload
  if (
    (payload.kind !== 'record' && payload.kind !== 'native-record-ref') ||
    payload.ownership !== 'shared-refcount' ||
    (payload.kind === 'native-record-ref' && payload.native !== null)
  )
    return null
  const layout = payload.kind === 'record' ? payload : recordLayoutOfShapeId(input.deriver, payload.shapeId)
  const physical =
    payload.kind === 'record' ? payload : input.deriver.layoutOf(payload.shapeId as import('../identity/ids.js').StructuralTypeId)
  if (!layout || physical.kind !== 'record' || physical.accessors.length !== 0 || ('indexes' in layout && layout.indexes.length !== 0))
    return null
  return { ...frame, target, fields: layout.fields }
}

/** Reinstallation reads the captured descriptor, never its former source.
 * This first slice restores only the same authenticated native array owner.
 */
export const nativeArrayDescriptorReinstallationOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  flow: NativeCallableFlow,
  input: NativeArrayDescriptorSnapshotInput
): NativeArrayDescriptorReinstallation | null => {
  const rendering = input.calleeRendering
  const frame = nativeArrayDescriptorCallOf(operation, definitionOf, input, 'defineProperty')
  const descriptor = operation.arguments[2]
  const captures = descriptor === undefined ? [] : (flow.nativeDescriptorSnapshotValues?.get(descriptor.value) ?? [])
  if (
    !frame ||
    !rendering ||
    descriptor === undefined ||
    !captures.length ||
    (operation.result !== null && representationKey(operation.result.representation) !== representationKey(frame.receiver.representation))
  )
    return null
  const { receiver, key } = frame
  const receiverProducer = definitionOf(receiver.value)
  const receiverOrigins =
    receiverProducer?.lineage == null ? new Set() : nativeCallableSourceAliasesOf(rendering.graph, receiverProducer.lineage)
  for (const capture of captures) {
    const original = [...input.bodies.values()]
      .flatMap((body) => [...definitionMapOf(body).values()])
      .find((candidate) => candidate.kind === 'call' && candidate.result?.id === capture)
    if (original?.kind !== 'call' || !original.nativeArrayDescriptorSnapshot) return null
    const source = original.nativeArrayDescriptorSnapshot.receiver
    if (representationKey(source.representation) !== representationKey(receiver.representation)) return null
    if (source.value === receiver.value) continue
    const sourceProducer = [...input.bodies.values()]
      .flatMap((body) => [...definitionMapOf(body).values()])
      .find((candidate) => resultOfIrOperation(candidate)?.id === source.value)
    if (
      sourceProducer?.lineage == null ||
      ![...nativeCallableSourceAliasesOf(rendering.graph, sourceProducer.lineage)].some((origin) => receiverOrigins.has(origin))
    )
      return null
  }
  return { receiver, key, descriptor, captures: [...captures] }
}

/** The actual capture entry cites its source array callbacks. An equal
 * public element type cannot authenticate another view's physical storage.
 */
export const nativeArrayDescriptorSnapshotOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  flow: NativeCallableFlow,
  input: NativeArrayDescriptorSnapshotInput
): NativeArrayDescriptorSnapshot | null => {
  const capture = nativeArrayDescriptorCaptureOf(operation, definitionOf, input)
  if (!capture) return null
  const { receiver, key, keyText, target } = capture
  const payload = target.payload
  if (payload.kind !== 'record' && payload.kind !== 'native-record-ref') return null
  const storages = new Map<string, Representation>().set(
    representationKey(receiver.representation.element),
    receiver.representation.element
  )
  const roots = flow.nativeArrayViewOrigins?.get(receiver.value) ?? []
  for (const root of roots) {
    const plans = nativeArrayRootViewPlansOf(root, input.conversions.nodeById)
    if (!plans.length || plans.some((plan) => representationKey(plan.target) !== representationKey(receiver.representation))) return null
    for (const plan of plans) storages.set(representationKey(plan.storage.element), plan.storage.element)
  }
  const originalAny = [...storages.values()].some(
    (value) => value.kind === 'dynamic' && (value.reason === 'declared-any-never-narrowed' || value.reason === 'unasserted-json-parse')
  )
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const undefinedValue: Representation = { kind: 'undefined' }
  const valueSources = keyText === 'length' ? [{ kind: 'scalar', domain: 'number' } as const] : [...storages.values(), undefinedValue]
  const fields: NativeDescriptorSnapshotPlan['fields'][number][] = []
  for (const field of capture.fields) {
    if (field.key === 'get' || field.key === 'set') {
      // Capture preserves these original Function holders and descriptor
      // fields without assigning them the ambient getter/setter ABI. Their
      // typed projection needs a separately authenticated installed half.
      fields.push({ field, reads: [], retainedAccessor: true })
      continue
    }
    const sources =
      field.key === 'value'
        ? valueSources
        : field.key === 'writable'
          ? keyText === 'length'
            ? [boolean]
            : [boolean, undefinedValue]
          : field.key === 'enumerable' || field.key === 'configurable'
            ? [boolean]
            : null
    if (sources === null) return null
    const reads = [...new Map(sources.map((source) => [representationKey(source), source])).values()].map((source) =>
      input.conversions.dictionaryReadFor(source, field.value)
    )
    if (reads.some((read) => read === null)) return null
    fields.push({ field, reads: reads as NonNullable<(typeof reads)[number]>[] })
  }
  const source: Representation = {
    kind: 'optional',
    absence: 'undefined',
    payload: {
      kind: 'native-record-ref',
      shapeId: payload.shapeId,
      native: 'gea::NativeDescriptorSnapshot',
      ownership: 'shared-refcount'
    }
  }
  const plan = nativeDescriptorSnapshotPlanOf(source, target, fields, originalAny, input.conversions.nodeById)
  if (!plan) return null
  const context = JSON.stringify([operation.lineage, receiver.value, key.value, roots.map((root) => root.id)])
  const node = input.conversions.nativeDescriptorSnapshotFor(context, plan)
  return node === null
    ? null
    : {
        receiver,
        key,
        keyText,
        originalSources: roots.map((root) => root.id),
        conversion: node.id
      }
}

/** Snapshot stores and opaque observers need their own ToPropertyDescriptor
 * proof. This initial read-only slice never substitutes a null setter for a
 * legal writable descriptor field or recovers from a later source relookup.
 */
const snapshotUsesAreClosed = (capture: IrValueId, input: NativeArrayDescriptorSnapshotInput, flow: NativeCallableFlow): boolean => {
  const aliases = new Set(
    [...(flow.nativeDescriptorSnapshotValues ?? [])].filter(([, captures]) => captures.includes(capture)).map(([value]) => value)
  )
  if (!aliases.has(capture)) return false
  if ([...aliases].some((alias) => flow.nativeDescriptorSnapshotOpenValues?.has(alias))) return false
  for (const body of input.bodies.values()) {
    const definitions = definitionMapOf(body)
    const definitionOf = (value: IrValueId): IrOperation | null => definitions.get(value) ?? null
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const reads = operandsOfIrOperation(operation).filter((operand) => aliases.has(operand.value))
        if (!reads.length) continue
        if (operation.kind === 'binding-write' || operation.kind === 'phi' || observesNativeCarrierOnly(operation)) continue
        if (operation.kind === 'convert') {
          const node = input.conversions.nodeById(operation.conversionUse)
          if (node?.capability.kind === 'identity') continue
          if (
            node &&
            'materializer' in node.capability &&
            node.capability.materializer.nativePayloadTransport === 'preserved' &&
            node.capability.materializer.nativeFieldProtocol === 'unused'
          )
            continue
        }
        if (operation.kind === 'get' && reads.every((operand) => operand.value === operation.receiver.value)) {
          const key = definitionOf(operation.key.value)
          if (
            key?.kind !== 'constant' ||
            key.literal !== 'string' ||
            !['value', 'writable', 'enumerable', 'configurable'].includes(key.text)
          )
            return false
          if (key.text === 'enumerable' || key.text === 'configurable') continue
          const rendering = input.calleeRendering
          const id = operation.lineage === null ? undefined : rendering?.graph.results.get(operation.lineage)
          const semantic = id === undefined ? null : (rendering?.graph.operations.get(id) ?? null)
          if (nativePropertyPrototypeAbsenceMatches(operation, semantic, definitionOf, input.conversions)) continue
        }
        if (operation.kind === 'compute' && operation.form === 'equality' && ['===', '!=='].includes(operation.operator ?? '')) continue
        if (operation.kind === 'call' && reads.length === 1 && operation.arguments[0]?.value === reads[0]?.value) {
          const host = hostTemplateMemberOf(operation, definitionOf, input.hostMethodAliases)
          if (host?.protocol === 'ObjectConstructor' && ['keys', 'getOwnPropertyNames'].includes(host.member) && operation.intrinsicOwnKeys)
            continue
        }
        if (
          operation.kind === 'call' &&
          operation.nativeArrayDescriptorReinstallation &&
          reads.every((operand) => operand.value === operation.nativeArrayDescriptorReinstallation!.descriptor.value)
        ) {
          const expected = nativeArrayDescriptorReinstallationOf(operation, definitionOf, flow, input)
          if (expected !== null && JSON.stringify(expected) === JSON.stringify(operation.nativeArrayDescriptorReinstallation)) continue
        }
        return false
      }
  }
  return true
}

export const nativeArrayDescriptorSnapshotMatches = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  flow: NativeCallableFlow,
  input: NativeArrayDescriptorSnapshotInput
): boolean => {
  const expected = nativeArrayDescriptorSnapshotOf(operation, definitionOf, flow, input)
  return (
    expected !== null &&
    operation.result !== null &&
    JSON.stringify(expected) === JSON.stringify(operation.nativeArrayDescriptorSnapshot) &&
    snapshotUsesAreClosed(operation.result.id, input, flow)
  )
}

const withoutSnapshotReceipts = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>): ReadonlyMap<PhysicalBodyId, IrBody> => {
  let changed = false
  const next = new Map(
    [...bodies].map(([id, body]) => {
      let bodyChanged = false
      const blocks = new Map(
        [...body.blocks].map(([blockId, block]) => {
          let blockChanged = false
          const operations = block.operations.map((operation) => {
            if (
              operation.kind !== 'call' ||
              (!('nativeArrayDescriptorSnapshot' in operation) && !('nativeArrayDescriptorReinstallation' in operation))
            )
              return operation
            blockChanged = true
            const { nativeArrayDescriptorSnapshot, nativeArrayDescriptorReinstallation, ...ordinary } = operation
            return ordinary
          })
          bodyChanged ||= blockChanged
          return [blockId, blockChanged ? { ...block, operations } : block] as const
        })
      )
      changed ||= bodyChanged
      return [id, bodyChanged ? { ...body, blocks } : body] as const
    })
  )
  return changed ? next : bodies
}

/** Publication and certification share the capture query and the complete
 * alias-use closure; stripping old output metadata never changes flow keys.
 */
export const publishNativeArrayDescriptorSnapshots = (
  provided: NativeArrayDescriptorSnapshotInput
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const bodies = withoutSnapshotReceipts(provided.bodies)
  const input = { ...provided, bodies }
  const hasCapture = [...bodies.values()].some((body) => {
    const calls = [...body.blocks.values()].flatMap((block) => block.operations.filter((operation) => operation.kind === 'call'))
    if (!calls.length) return false
    const definitions = definitionMapOf(body)
    return calls.some((operation) => nativeArrayDescriptorCaptureOf(operation, (value) => definitions.get(value) ?? null, input) !== null)
  })
  if (!hasCapture) return bodies
  const flow = nativeCallableFlowOf(
    [...input.bodies.values()],
    input.placements,
    input.classes,
    input.conversions,
    undefined,
    input.deriver
  )
  const candidates = new Map(
    [...input.bodies].map(([id, body]) => {
      const definitions = definitionMapOf(body)
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((operation) => {
                  if (operation.kind !== 'call') return operation
                  const { nativeArrayDescriptorSnapshot: previous, ...ordinary } = operation
                  const receipt = nativeArrayDescriptorSnapshotOf(operation, (value) => definitions.get(value) ?? null, flow, input)
                  if (receipt === null) return ordinary
                  const { hostObjectWalkPlan: previousPlan, ...selected } = ordinary
                  return {
                    ...selected,
                    nativeArrayDescriptorSnapshot: receipt,
                    conversionRecipes: operation.conversionRecipes?.filter((recipe) => recipe.role !== 'prototype-result') ?? []
                  }
                })
              }
            ])
          )
        } as IrBody
      ] as const
    })
  )
  const captureFlow = nativeCallableFlowOf(
    [...candidates.values()],
    input.placements,
    input.classes,
    input.conversions,
    undefined,
    input.deriver
  )
  const reinstallations = new Map(
    [...candidates].map(([id, body]) => {
      const definitions = definitionMapOf(body)
      return [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((operation) => {
                  if (operation.kind !== 'call') return operation
                  const { nativeArrayDescriptorReinstallation: previous, ...ordinary } = operation
                  const receipt = nativeArrayDescriptorReinstallationOf(operation, (value) => definitions.get(value) ?? null, captureFlow, {
                    ...input,
                    bodies: candidates
                  })
                  return receipt === null
                    ? ordinary
                    : { ...ordinary, nativeArrayDescriptorReinstallation: receipt, objectValueConversions: [] }
                })
              }
            ])
          )
        } as IrBody
      ] as const
    })
  )
  const candidateInput = { ...input, bodies: reinstallations }
  const aliases = nativeCallableFlowOf(
    [...reinstallations.values()],
    input.placements,
    input.classes,
    input.conversions,
    undefined,
    input.deriver
  )
  const accepted = new Set(
    [...reinstallations.values()]
      .flatMap((body) => [...definitionMapOf(body).values()])
      .flatMap((operation) =>
        operation.kind === 'call' &&
        operation.nativeArrayDescriptorSnapshot &&
        operation.result &&
        snapshotUsesAreClosed(operation.result.id, candidateInput, aliases)
          ? [operation.result.id]
          : []
      )
  )
  return new Map(
    [...reinstallations].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) => {
                if (operation.kind !== 'call') return operation
                const { nativeArrayDescriptorSnapshot, nativeArrayDescriptorReinstallation, ...ordinary } = operation
                return {
                  ...ordinary,
                  ...(nativeArrayDescriptorSnapshot && operation.result && accepted.has(operation.result.id)
                    ? { nativeArrayDescriptorSnapshot }
                    : {}),
                  ...(nativeArrayDescriptorReinstallation &&
                  nativeArrayDescriptorReinstallation.captures.every((capture) => accepted.has(capture))
                    ? { nativeArrayDescriptorReinstallation }
                    : {})
                }
              })
            }
          ])
        )
      }
    ])
  )
}
