import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import { narrowingReachesTarget } from './build.js'

/**
 * A use can narrow a published sum without changing what its producer returns.
 * In `(query() as string[]).join(',')`, erasure correctly cites the call's
 * result, but the receiver operand still states the asserted array type. The
 * load of that arm must be explicit before invoking its native internal method.
 * Only an existing payload can be selected here: this never boxes, reconstructs
 * a table, changes a call ABI, or treats an unrelated assertion as a cast.
 * Preflight checks the resulting pair against the conversion graph; lowering
 * emits the same pair as an IR conversion.
 */
export const narrowedOperandView = (source: Representation, operand: SemanticOperand, deriver: RepresentationDeriver): Representation => {
  if (source.kind !== 'optional' && source.kind !== 'tagged-union') return source
  const target = deriver.derive(operand.type)
  if (representationKey(source) === representationKey(target)) return source
  return narrowingReachesTarget(source, target) ? target : source
}
