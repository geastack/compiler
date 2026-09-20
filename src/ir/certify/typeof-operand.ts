import type { RepresentationDeriver } from '../../representation/derive.js'
import type { Representation } from '../../representation/model.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'

/**
 * The exact carrier `typeof` will receive at lowering time.
 *
 * Results take their representation from the sealed plan; constants and
 * `null` publish no result, so their carrier must be derived from the
 * operand's own type.  Keeping that split here gives the manifest and the
 * obligation census one authoritative operand set instead of letting either
 * silently substitute the `typeof` result (which is always a string).
 */
export const typeofOperandRepresentationOf = (
  operation: SemanticOperation,
  plan: SealedRepresentationPlan,
  deriver: RepresentationDeriver
): Representation | undefined => {
  const operand = operandOf(operation, 'operand')
  if (!operand) return undefined
  return operand.source.kind === 'result' ? plan.selected.get(operand.source.result) : deriver.derive(operand.type)
}
