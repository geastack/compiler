import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeObjectSamplePlanOf, type NativeObjectSampleField } from '../conversion/native-object-sample.js'
import type { OperationId, SemanticResultId } from '../identity/ids.js'
import { nativeObjectDataStorageOf } from '../projection/native-object-data.js'
import { representationKey, type Representation } from '../representation/model.js'
import { nativeObjectDataSlotSchemasOf } from '../semantics/native-object-data-slots.js'
import type { ConvertOperation, IrOperand, IrOperation } from './model.js'
import {
  nativeOwnAssignmentLayoutOf,
  nativeOwnAssignmentEffectFreeInterval,
  nativeOwnAssignmentRecipeOf,
  nativeOwnAssignmentRootOf,
  nativeOwnAssignmentStoredValueConversionsOf,
  type NativeOwnAssignmentInputs,
  type NativeOwnAssignmentRecipe,
  type NativeOwnAssignmentStorageFit
} from './native-own-assignment.js'
import { resultOfIrOperation } from './queries.js'

/** Required sampled keys cite their successful installing copy. The held
 * fields belong to this original physical allocation, never to a live view's
 * placeholder. Optional absent keys carry a distinct undefined recipe.
 * @semanticCategory generic-primitive
 */
export interface NativeObjectSampleReceipt {
  readonly allocation: OperationId
  readonly assignment: SemanticResultId
  readonly observed: IrOperand
  readonly owner: IrOperand
  readonly fields: readonly {
    readonly key: string
    readonly presence: 'proven' | 'optional'
    readonly sourceOrdinal: number | null
    readonly storageFits: readonly NativeOwnAssignmentStorageFit[]
  }[]
  readonly conversion: ConversionNodeId
}

/** This bounded normal-path proof runs both at entry lowering and against
 * the final instructions. A field's required declaration is never evidence
 * that Object.assign actually copied an own enumerable source key.
 */
export const nativeObjectSampleEntryOf = (
  source: IrOperand,
  target: Representation,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs
): { readonly source: IrOperand; readonly receipt: NativeObjectSampleReceipt } | null => {
  if (target.kind !== 'record' || target.ownership !== 'owned' || target.accessors.length !== 0) return null
  const original = nativeOwnAssignmentRootOf(source.value, operations, input)
  if (!original) return null
  const owner: IrOperand = { value: original.result.id, representation: original.result.representation }
  const layout = nativeOwnAssignmentLayoutOf(owner.representation, input.deriver)
  if (layout === null) return null
  const recipes: {
    readonly recipe: NativeOwnAssignmentRecipe
    readonly operation: Extract<IrOperation, { kind: 'call' }>
    readonly index: number
  }[] = []
  for (const [index, operation] of operations.entries()) {
    if (operation.kind !== 'call') continue
    const recipe = nativeOwnAssignmentRecipeOf(operation, operations.slice(0, index + 1), input)
    if (recipe !== null && recipe.owner.value === owner.value) recipes.push({ recipe, operation, index })
  }
  const last = recipes.at(-1)
  if (!last || !nativeOwnAssignmentEffectFreeInterval(operations.slice(last.index + 1), input)) return null
  const census = nativeObjectDataSlotSchemasOf(input.graph)
  const schemas = census.schemas.get(last.recipe.allocation)
  const fields: NativeObjectSampleField[] = []
  const witnesses: NativeObjectSampleReceipt['fields'][number][] = []
  for (const field of target.fields) {
    const fixed = layout.fields.find((one) => one.key === field.key)
    const schema = schemas?.get(field.key)
    const extension = fixed || !schema ? null : nativeObjectDataStorageOf(schema, input.deriver)
    const storage = fixed?.value ?? extension?.storage
    const storageFits =
      storage && schema?.storedValues ? nativeOwnAssignmentStoredValueConversionsOf(schema.storedValues, storage, input) : null
    if (!storage || !schema || schema.blockers.length || !schema.storedValues?.length || storageFits === null) return null
    const installed = last.recipe.sources.find((source) => source.fields.some((one) => one.key === field.key && one.copiedPresent))
    const initial =
      fixed?.required === true &&
      operations.slice(0, last.index).some((operation) => {
        if (operation.kind === 'allocate-record') return operation === original && operation.fields.some((one) => one.key === field.key)
        if (operation.kind !== 'define-own-property' || !operation.attributes.enumerable) return false
        const key = operations.find((one) => resultOfIrOperation(one)?.id === operation.key.value)
        return (
          key?.kind === 'constant' &&
          key.literal === 'string' &&
          key.text === field.key &&
          nativeOwnAssignmentRootOf(operation.receiver.value, operations.slice(0, last.index), input) === original
        )
      })
    const presence = installed !== undefined || initial ? 'proven' : 'optional'
    const present = input.conversions.nodeFor(storage, field.value)
    const fieldFits = nativeOwnAssignmentStoredValueConversionsOf(schema.storedValues, field.value, input)
    if (fieldFits === null) return null
    const absent = presence === 'proven' ? null : input.conversions.nodeFor({ kind: 'undefined' }, field.value)
    fields.push({ field, from: fixed ? 'held' : 'extension', storage, presence, present, absent })
    witnesses.push({
      key: field.key,
      presence,
      sourceOrdinal: installed?.ordinal ?? null,
      storageFits: [...storageFits, ...fieldFits].map((fit) => ({ ...fit, allocation: last.recipe.allocation }))
    })
  }
  const plan = nativeObjectSamplePlanOf(owner.representation, target, fields, input.conversions.nodeById)
  if (plan === null) return null
  const context = JSON.stringify([
    last.recipe.allocation,
    last.recipe.operation,
    last.operation.lineage,
    owner.value,
    last.recipe.sources.map((source) => [
      source.ordinal,
      source.roots.map((root) => root.allocation),
      source.fields.map((field) => [field.key, field.conversion])
    ]),
    witnesses
  ])
  const node = input.conversions.nativeObjectSampleFor(context, plan)
  if (node === null) return null
  return {
    source: owner,
    receipt: {
      allocation: last.recipe.allocation,
      assignment: last.operation.lineage,
      observed: source,
      owner,
      fields: witnesses,
      conversion: node.id
    }
  }
}

export const nativeObjectSampleMatches = (
  operation: ConvertOperation,
  operations: readonly IrOperation[],
  input: NativeOwnAssignmentInputs
): boolean => {
  const node = input.conversions.nodeById(operation.conversionUse)
  const receipt = operation.nativeObjectSample
  if (node?.capability.kind !== 'static' || node.capability.materializer.nativeObjectSample === undefined) return receipt === undefined
  if (
    receipt === undefined ||
    receipt.conversion !== operation.conversionUse ||
    receipt.owner.value !== operation.source.value ||
    representationKey(receipt.owner.representation) !== representationKey(operation.source.representation)
  )
    return false
  const expected = nativeObjectSampleEntryOf(receipt.observed, operation.result.representation, operations, input)
  return expected !== null && JSON.stringify(expected.receipt) === JSON.stringify(receipt) && expected.receipt.conversion === node.id
}
