import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { iteratorObjectViewPlan, type IteratorObjectViewPlan } from './iterator-object-view.js'
import { structuralConversionKey, type AcceptedConversion } from './structural-plan.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { Representation } from '../representation/model.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'

export interface CertifiedIteratorObjectViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly view: IteratorObjectViewPlan
  readonly leaves: ReadonlyMap<string, ConversionNode>
}

/** Each future cursor step and self invocation uses the exact leaf recipe admitted here. */
export const certifiedIteratorObjectViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver
): CertifiedIteratorObjectViewPlan | null => {
  const leaves = new Map<string, ConversionNode>()
  const accept = (from: Representation, into: Representation): boolean => {
    const key = structuralConversionKey(from, into)
    if (leaves.has(key)) return true
    const node = accepted(from, into)
    if (node === null || !recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)) return false
    if (structuralConversionKey(node.source, node.target) !== key)
      throw new Error(`iterator view ${key} received a recipe for different carriers`)
    leaves.set(key, node)
    return true
  }
  const payload = target.kind === 'optional' ? target.payload : target
  const view = iteratorObjectViewPlan(layouts, source, payload, accept)
  if (view === null) return null
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  for (const field of view.fields) {
    if (field.kind !== 'next') continue
    if (!accept(boolean, field.yieldArm.record.done.value) || !accept(boolean, field.returnArm.record.done.value)) return null
  }
  return { source, target, view, leaves }
}
