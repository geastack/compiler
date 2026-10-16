import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { IrIteratorCloseRegion, IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/** Finite IteratorBindingInitialization marks its iterator record done when
 * IteratorStepValue abruptly completes. Defaults/assignment run afterwards
 * and retain ordinary close-on-throw. This obligation is independent of IR.
 */
export const finiteIteratorCloseRegionMatches = (
  region: IrIteratorCloseRegion,
  semantic: SemanticOperation | null,
  definitionOf: (value: IrValueId) => IrOperation | null
): boolean => {
  const finite = semantic?.family === 'destructuring' && semantic.form === 'array-pattern-close'
  if (!finite) return region.completeOnStepAbrupt !== true
  if (region.completeOnStepAbrupt !== true || !region.onlyIfOpen || region.bodyEntry !== null || region.dismissTargets.length !== 0)
    return false
  if (semantic.id !== region.loop) return false
  const source = semantic.operands.find((operand) => operand.role === 'iterator' && operand.ordinal === 0)
  if (source?.source.kind !== 'result') return false
  const definition = definitionOf(region.iterator.value)
  return (
    !!definition &&
    definition.lineage === (source.source.result as SemanticResultId) &&
    resultOfIrOperation(definition)?.id === region.iterator.value
  )
}
