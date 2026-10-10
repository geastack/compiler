import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, PhysicalBodyId, IrValueId, FunctionId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { allOperationsOf, type IrBody, type IrOperation } from './model.js'
import {
  nativeFieldViewLivePlansOf,
  nativeFieldViewTargetSetOf,
  nativeFieldViewCarrierNeedsReceipt,
  nativeFieldViewOperationNeedsReceipt,
  nativeFieldViewOpenDocumentRead,
  nativeFieldViewDocumentTargetSetOf,
  nativeFieldViewReadOf,
  nativeFieldViewWriteOf,
  nativeFieldViewReadSelectionOf,
  nativeFieldViewOpenReadOf,
  nativeFieldViewWriteSelectionOf
} from './native-field-view-facts.js'
import { nativeIteratorFieldReadOf } from './native-iterator-field-views.js'
import { nativeEntryFieldReadsOf, nativeEntryFieldReadsRequired } from './native-entry-field-views.js'
import { nativeDocumentEntryOf } from './native-document-entries.js'
import type { ProgramConversionRecipe } from './program-conversions.js'
import { constantPropertyKeyTextOf } from './native-property-key-texts.js'

export interface PublishNativeFieldViewFactsInput {
  readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly conversions: ConversionCensus
  readonly deriver: RepresentationDeriver
  readonly programConversions?: readonly ProgramConversionRecipe[]
}

/** Final native heap facts replace public-layout guesses after every operation recipe is published. */
export const publishNativeFieldViewFacts = (input: PublishNativeFieldViewFactsInput): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const plans = nativeFieldViewLivePlansOf(input.bodies.values(), input.conversions, input.programConversions)
  const targets = nativeFieldViewTargetSetOf(plans)
  const documents = nativeFieldViewDocumentTargetSetOf(plans)
  if (targets.size === 0) return input.bodies
  const flow = nativeCallableFlowOf(
    [...input.bodies.values()],
    input.placements,
    input.classes,
    input.conversions,
    undefined,
    input.deriver,
    input.programConversions
  )
  const abis = new Map(
    [...input.bodies.values()].flatMap((body) => (body.abi === null ? [] : [[body.sourceOwner as FunctionId, body.abi] as const]))
  )
  return new Map(
    [...input.bodies].map(([id, body]) => {
      const keys = new Map<IrValueId, string>()
      for (const block of body.blocks.values())
        for (const operation of allOperationsOf(block)) {
          const key = constantPropertyKeyTextOf(operation)
          if (key !== null && operation.kind === 'constant') keys.set(operation.result.id, key)
        }
      const publish = (operation: IrOperation): IrOperation => {
        let output = operation
        if ((operation.kind === 'get' || operation.kind === 'set') && operation.nativeObjectDataSlot !== undefined) return operation
        if (operation.kind === 'get' || operation.kind === 'set') {
          const { nativeDocumentEntry: previous, ...ordinary } = operation
          const nativeDocumentEntry = nativeDocumentEntryOf(ordinary, flow, input.conversions, input.deriver, keys.get(operation.key.value))
          if (nativeDocumentEntry !== null) {
            return {
              ...ordinary,
              nativeDocumentEntry,
              conversionRecipes:
                operation.conversionRecipes?.filter(
                  (recipe) => recipe.role !== (operation.kind === 'get' ? 'field-read' : 'field-write')
                ) ?? []
            }
          }
          output = ordinary
        }
        if (operation.kind === 'construct') {
          const { nativeEntryFieldReads: previousReads, ...ordinary } = operation
          const nativeEntryFieldReads = nativeEntryFieldReadsRequired(operation, targets)
            ? nativeEntryFieldReadsOf(operation, plans, input.conversions)
            : null
          return nativeEntryFieldReads === null ? ordinary : { ...ordinary, nativeEntryFieldReads }
        }
        if (operation.kind === 'get-iterator') {
          const { nativeNextMethodRead: previousRead, ...ordinary } = operation
          const receiver = { value: operation.result.id, representation: operation.result.representation }
          const nativeNextMethodRead =
            operation.protocol !== 'enumerate' && nativeFieldViewCarrierNeedsReceipt(receiver.representation, targets)
              ? nativeIteratorFieldReadOf(receiver, 'next', input.deriver, abis, flow, input.conversions)
              : null
          return nativeNextMethodRead === null ? ordinary : { ...ordinary, nativeNextMethodRead }
        }
        if (operation.kind === 'iterator-next' || operation.kind === 'iterator-close') {
          const { nativeMethodRead: previousRead, ...ordinary } = operation
          const nativeMethodRead = nativeFieldViewCarrierNeedsReceipt(operation.iterator.representation, targets)
            ? nativeIteratorFieldReadOf(
                operation.iterator,
                operation.kind === 'iterator-next' ? 'next' : 'return',
                input.deriver,
                abis,
                flow,
                input.conversions
              )
            : null
          return nativeMethodRead === null ? ordinary : { ...ordinary, nativeMethodRead }
        }
        if (
          (operation.kind !== 'get' && operation.kind !== 'set') ||
          !nativeFieldViewOperationNeedsReceipt(operation, targets, body.hostNamespaceCensus)
        )
          return output
        const key = keys.get(operation.key.value)
        if (nativeFieldViewOpenDocumentRead(operation, key, targets, documents)) {
          const { nativeFieldViewRead: previousRead, ...open } = output as typeof operation & { nativeFieldViewRead?: unknown }
          return open as IrOperation
        }
        if (operation.kind === 'get') {
          const { nativeDocumentEntry: previous, ...ordinary } = operation
          const read =
            key !== undefined
              ? nativeFieldViewReadOf(operation, key, flow, input.conversions)
              : (nativeFieldViewReadSelectionOf(operation, operation.provenKeyTexts ?? [], flow, input.conversions) ??
                nativeFieldViewOpenReadOf(operation, flow, input.conversions))
          return read === null
            ? ordinary
            : {
                ...ordinary,
                nativeFieldViewRead: read,
                conversionRecipes: operation.conversionRecipes?.filter((recipe) => recipe.role !== 'field-read') ?? []
              }
        }
        const { nativeDocumentEntry: previous, ...ordinary } = operation
        const write =
          key !== undefined
            ? nativeFieldViewWriteOf(operation, key, flow, input.conversions)
            : nativeFieldViewWriteSelectionOf(operation, operation.provenKeyTexts ?? [], flow, input.conversions)
        return write === null
          ? ordinary
          : {
              ...ordinary,
              nativeFieldViewWrite: write,
              conversionRecipes: operation.conversionRecipes?.filter((recipe) => recipe.role !== 'field-write') ?? []
            }
      }
      return [
        id,
        {
          ...body,
          ...(body.iteratorCloseRegions === undefined
            ? {}
            : {
                iteratorCloseRegions: body.iteratorCloseRegions.map((region) => {
                  const { nativeMethodRead: previousRead, ...ordinary } = region
                  const nativeMethodRead = nativeFieldViewCarrierNeedsReceipt(region.iterator.representation, targets)
                    ? nativeIteratorFieldReadOf(region.iterator, 'return', input.deriver, abis, flow, input.conversions)
                    : null
                  return nativeMethodRead === null ? ordinary : { ...ordinary, nativeMethodRead }
                })
              }),
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              { ...block, operations: block.operations.map((operation) => publish(operation) as typeof operation) }
            ])
          )
        }
      ]
    })
  )
}
