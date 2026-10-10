import type { IrValueId } from '../identity/ids.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { representationKey } from '../representation/model.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { dominatorTreeOf } from './dominance.js'
import { allOperationsOf, type DeadLogicalMergeValueOperation, type IrBody, type IrOperation } from './model.js'

/** A source-object fact licenses only the exact && left's falsy control edge,
 * never an ordinary conversion of a shared reference into the result carrier.
 */
export const deadLogicalMergeValueMatches = (
  operation: DeadLogicalMergeValueOperation,
  semantic: SemanticOperation | null,
  body: IrBody,
  semanticOperationOf?: (lineage: NonNullable<IrOperation['lineage']>) => SemanticOperation | null,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  if (
    semantic?.family !== 'computation' ||
    semantic.form !== 'logical' ||
    semantic.operator !== '&&' ||
    semantic.logicalLeftObjectTruthy !== true ||
    resultOf(semantic, 'value')?.id !== operation.lineage ||
    body.sourceOwner !== (semantic.caller.kind === 'function' ? semantic.caller.functionId : semantic.caller.regionId)
  )
    return false
  const left = operandOf(semantic, 'left')?.source
  if (left === undefined) return false
  const definitions = new Map<IrValueId, IrOperation>()
  let blockOf: typeof body.entry | null = null
  for (const block of body.blocks.values())
    for (const item of allOperationsOf(block)) {
      if ('result' in item && item.result !== null) definitions.set(item.result.id, item)
      if (item === operation) blockOf = block.id
    }
  if (blockOf === null) return false
  const chain = (value: IrValueId): readonly IrValueId[] => {
    const values: IrValueId[] = []
    while (!values.includes(value)) {
      values.push(value)
      const producer = definitions.get(value)
      if (producer?.kind !== 'convert') break
      // A discarded or reconstructed value cannot borrow the source's
      // truthiness merely because the conversion still cites that SSA.
      const node = conversions?.nodeById(producer.conversionUse)
      if (
        producer.rebuild !== undefined ||
        node === null ||
        node === undefined ||
        representationKey(node.source) !== representationKey(producer.source.representation) ||
        representationKey(node.target) !== representationKey(producer.result.representation) ||
        !recipeIsMaterializableWithoutPriorSourceGuard(node, conversions!.nodeById) ||
        (node.capability.kind !== 'identity' &&
          !(
            'materializer' in node.capability &&
            (node.capability.materializer.nativePayloadTransport === 'preserved' ||
              node.capability.materializer.callableIdentityTransport === 'preserved')
          ))
      )
        break
      value = producer.source.value
    }
    return values
  }
  const aliases = chain(operation.source.value)
  if (
    !aliases.some((value) => {
      const producer = definitions.get(value)
      if (producer === undefined) return false
      if (left.kind === 'result') {
        if (producer.lineage !== left.result || producer.kind === 'convert') return false
        const source = semanticOperationOf?.(left.result)
        if (source?.family === 'binding')
          return source.action === 'read' && producer.kind === 'binding-read' && producer.declaration === source.declaration
        return source !== null && source !== undefined && resultOf(source, 'value')?.id === left.result
      }
      if (left.kind === 'parameter') return producer.kind === 'parameter' && producer.ordinal === left.ordinal
      return left.kind === 'receiver' && producer.kind === 'receiver'
    })
  )
    return false
  const dominance = dominatorTreeOf(body)
  for (const block of body.blocks.values()) {
    const branch = block.terminator
    if (branch.kind !== 'branch' || !dominance.dominates(branch.whenFalse, blockOf)) continue
    const test = definitions.get(branch.condition.value)
    if (test?.kind === 'test' && test.predicate === 'to-boolean' && chain(test.value.value).some((value) => aliases.includes(value)))
      return true
  }
  return false
}
