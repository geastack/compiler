import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { IrIteratorCloseRegion, IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/** Finite IteratorBindingInitialization marks its iterator record done when
 * IteratorStepValue abruptly completes. Defaults/assignment run afterwards
 * and retain ordinary close-on-throw. This obligation is independent of IR.
 *
 * A source that is already a native cursor (`const [a] = gen()`) has no
 * GetIterator to lower: `lowerArrayPatternSource` registers the pattern's
 * iterator-record as the source value itself, so that value is defined under
 * the source's lineage. The record's own source step must then name exactly
 * that value as its `base`.
 */
export const finiteIteratorCloseRegionMatches = (
  region: IrIteratorCloseRegion,
  semantic: SemanticOperation | null,
  definitionOf: (value: IrValueId) => IrOperation | null,
  operationOfResult: (result: SemanticResultId) => SemanticOperation | null
): boolean => {
  const finite = semantic?.family === 'destructuring' && semantic.form === 'array-pattern-close'
  if (!finite) return region.completeOnStepAbrupt !== true
  if (region.completeOnStepAbrupt !== true || !region.onlyIfOpen || region.bodyEntry !== null || region.dismissTargets.length !== 0)
    return false
  if (semantic.id !== region.loop) return false
  const source = semantic.operands.find((operand) => operand.role === 'iterator' && operand.ordinal === 0)
  if (source?.source.kind !== 'result') return false
  const record = source.source.result as SemanticResultId
  const definition = definitionOf(region.iterator.value)
  if (!definition || resultOfIrOperation(definition)?.id !== region.iterator.value) return false
  if (definition.lineage === record) return true
  if (region.iterator.representation.kind !== 'iterator') return false
  const step = operationOfResult(record)
  if (step?.family !== 'destructuring' || step.form !== 'array-pattern') return false
  const base = step.operands.find((operand) => operand.role === 'base')
  if (base?.source.kind !== 'result') return false
  // A defaulted parameter pattern (`function f([,] = it)`) reads its binding,
  // whose value is exactly its initializer -- the defaulted value the phi joins.
  let named: SemanticResultId = base.source.result
  for (let hops = 0; named !== definition.lineage; hops += 1) {
    const binding = operationOfResult(named)
    if (hops === 8 || binding?.family !== 'binding') return false
    const initializer = binding.operands.find((operand) => operand.role === 'initializer')
    if (initializer?.source.kind !== 'result') return false
    named = initializer.source.result
  }
  return true
}
