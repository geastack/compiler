import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import type { FunctionId, IrValueId } from '../identity/ids.js'
import { classMemberOf } from '../projection/fields.js'
import { carriesUndefined, representationKey } from '../representation/model.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { descriptorOwnProtocolMatches } from './descriptor-own-protocol.js'
import { fixedDataDefinitionRecipeOf, type FixedDataDefinitionRecipe } from './fixed-data-definition.js'
import { intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperation } from './model.js'
import { nativeClassConstructionOf } from './native-class-construction.js'
import type { NativeDataDefinitionInput } from './native-data-definition.js'
import { nativeFieldViewCarrierNeedsReceipt, nativeFieldViewTargetsOf } from './native-field-view-facts.js'
import { resultOfIrOperation } from './queries.js'

/** Attribute-only definitions cannot use a public required field as proof of
 * own presence. A bounded pre-call source snapshot retains every preceding
 * effect and the canonical construction topology; the queried call contributes
 * no effect to the proof which admits it.
 * @semanticCategory generic-primitive
 */
export const fixedDataDefinitionAttributesOf = (
  input: NativeDataDefinitionInput
): ReadonlyMap<CallOperation, FixedDataDefinitionRecipe> => {
  const recipes = new Map<CallOperation, FixedDataDefinitionRecipe>()
  const topology = [...input.bodies.values()]
  const live = nativeFieldViewTargetsOf(input.bodies.values(), input.conversions)
  const sourceBodies = new Map<FunctionId, IrBody | null>()
  for (const body of input.bodies.values()) {
    const source = body.sourceOwner as FunctionId
    sourceBodies.set(source, sourceBodies.has(source) ? null : body)
  }
  // `delete` can remove the own property this proof claims is present. The
  // native-callable flow only escapes a delete's receiver (an escape keeps the
  // physical slot's carrier), so presence is refused for every key some
  // program `delete` may name, whichever receiver it reaches.
  const deletedKeys = new Set<string>()
  let deletesUnknownKey = false
  for (const body of input.bodies.values()) {
    const constants = new Map<IrValueId, string>()
    const deletes: IrValueId[] = []
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'constant' && (operation.literal === 'string' || operation.literal === 'number'))
          constants.set(operation.result.id, operation.text)
        if (operation.kind === 'delete') deletes.push(operation.key.value)
      }
    for (const key of deletes) {
      const text = constants.get(key)
      if (text === undefined) deletesUnknownKey = true
      else deletedKeys.add(text)
    }
  }
  for (const body of input.bodies.values()) {
    const definitions = new Map<IrValueId, IrOperation>()
    const writes = new Map<string, Extract<IrOperation, { kind: 'binding-write' }>[]>()
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result) definitions.set(result.id, operation)
        if (operation.kind === 'binding-write') writes.set(operation.declaration, [...(writes.get(operation.declaration) ?? []), operation])
      }
    const definitionOf = (value: IrValueId): IrOperation | null => definitions.get(value) ?? null
    for (const block of body.blocks.values())
      for (const [index, operation] of block.operations.entries()) {
        if (operation.kind !== 'call') continue
        const id = input.graph.results.get(operation.lineage)
        const semantic = id === undefined ? null : (input.graph.operations.get(id) ?? null)
        const [target, key, descriptor] = operation.arguments
        const keyValue = key && definitionOf(key.value)
        if (
          semantic?.family !== 'invocation' ||
          semantic.intrinsicDataDefinition !== true ||
          !target ||
          !descriptor ||
          descriptor.representation.kind !== 'record' ||
          !('ownership' in target.representation) ||
          target.representation.ownership !== 'shared-refcount' ||
          descriptor.representation.fields.some((field) => field.key === 'value' || !field.required) ||
          keyValue?.kind !== 'constant' ||
          keyValue.literal !== 'string' ||
          nativeFieldViewCarrierNeedsReceipt(target.representation, live) ||
          !authenticatedTemplateCallEntry(operation, semantic, input.calleeRendering, definitionOf) ||
          !intrinsicCallArgumentMatches(operation, semantic, 0, definitionOf) ||
          !descriptorOwnProtocolMatches(
            operation,
            semantic,
            input.graph,
            definitionOf,
            descriptor.representation.fields.map((field) => field.key)
          )
        )
          continue
        // Planning exposes the physical destination and attributes only. The
        // independently recomputed current-own-property proof below is required
        // whenever creating Undefined cannot fit that destination natively.
        const planned = fixedDataDefinitionRecipeOf(
          operation.arguments,
          keyValue.text,
          operation.result?.representation ?? target.representation,
          input.deriver,
          input.classes,
          input.conversions,
          true,
          {
            receiver: target.value,
            descriptor: descriptor.value,
            key: key!.value,
            allocation: target.value,
            initialized: null,
            absence: null
          }
        )
        if (!planned || deletesUnknownKey || deletedKeys.has(planned.field.key)) continue
        let initialized: IrValueId | null = null
        let absence = null
        if (!planned.field.required && carriesUndefined(planned.held)) {
          const node = input.conversions.nodeFor({ kind: 'undefined' }, planned.held)
          if (
            recipeHasNormalResult(node, input.conversions.nodeById) &&
            recipePreservesNativePayload(node, input.conversions.nodeById) &&
            recipeIsMaterializableWithoutPriorSourceGuard(node, input.conversions.nodeById)
          )
            absence = node.id
        }
        {
          if (body.abi !== null || body.blocks.size !== 1 || body.tryRegions.length !== 0 || !input.calleeRendering) continue
          const positions = new Map<IrOperation, number>(block.operations.map((one, ordinal) => [one, ordinal]))
          const before = (value: IrValueId, use: IrOperation, seen = new Set<IrValueId>()): IrOperation | null => {
            if (seen.has(value)) return null
            seen.add(value)
            const producer = definitionOf(value)
            const producerAt = producer === null ? undefined : positions.get(producer)
            const useAt = positions.get(use)
            if (!producer || producerAt === undefined || useAt === undefined || producerAt >= useAt) return null
            if (producer.kind === 'convert') {
              const node = input.conversions.nodeById(producer.conversionUse)
              return nativeClassReferenceTransportMatches(producer.source.representation, producer.result.representation, node) ||
                nativePayloadTransportMatches(producer.source.representation, producer.result.representation, node)
                ? before(producer.source.value, producer, seen)
                : null
            }
            if (producer.kind === 'binding-read') {
              if (!['local', 'region'].includes(input.calleeRendering!.placements.get(producer.declaration)?.storage.kind ?? ''))
                return null
              const entries = writes.get(producer.declaration)
              const writer = entries?.length === 1 ? entries[0] : undefined
              return writer ? before(writer.value.value, writer, seen) : null
            }
            return producer
          }
          const allocation = before(target.value, operation)
          if (allocation?.kind === 'allocate-record') {
            if (absence === null && !allocation.fields.some((field) => field.key === planned.field.key)) continue
          } else if (allocation?.kind === 'construct') {
            const branches = nativeClassConstructionOf(allocation, input.classes, (source) => sourceBodies.get(source), input.conversions)
            if (
              !branches?.length ||
              branches.some((branch) => {
                const member = classMemberOf(input.classes, branch.declaration, planned.field.key)
                return (
                  member?.kind !== 'field' ||
                  branch.entries.some((entry) => [...input.classes.values()].some((layout) => layout.constructor === entry.functionId)) ||
                  !input.classes
                    .get(member.owner)
                    ?.fields.some(
                      (field) =>
                        field.key === planned.field.key &&
                        (absence !== null || field.initializer !== null) &&
                        !field.syntheticSubclassMemberOverlay
                    )
                )
              })
            )
              continue
          } else continue
          const prefix: IrBody = {
            ...body,
            blocks: new Map([
              [
                block.id,
                {
                  ...block,
                  operations: block.operations
                    .slice(0, index)
                    .map((one) => (one.kind === 'call' && recipes.has(one) ? { ...one, fixedDataDefinition: recipes.get(one)! } : one)),
                  terminator: { kind: 'return', lineage: null, value: null }
                }
              ]
            ])
          }
          const bodies = new Map(input.bodies)
          bodies.set(body.owner, prefix)
          const flow = nativeCallableFlowOf(
            [...bodies.values()],
            input.calleeRendering.placements,
            input.classes,
            input.conversions,
            undefined,
            input.deriver,
            undefined,
            topology
          )
          const held = flow.nativeFieldStorageValues.get(target.value)?.get(planned.field.key)
          if (!held?.length || held.some((one) => representationKey(one) !== representationKey(planned.held))) continue
          const source = resultOfIrOperation(allocation)!.id
          initialized = absence === null ? source : null
          recipes.set(operation, {
            ...planned,
            attributesOnly: {
              receiver: target.value,
              descriptor: descriptor.value,
              key: key!.value,
              allocation: source,
              initialized,
              absence
            }
          })
        }
      }
  }
  return recipes
}
