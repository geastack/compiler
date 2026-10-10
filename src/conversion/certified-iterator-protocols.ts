import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { iterableObjectViewPlan, type IterableObjectViewPlan } from './iterable-object-view.js'
import { iteratorResultRecordsOf, protocolIteratorPlan, type ProtocolIteratorPlan } from './protocol-iterator.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { structuralConversionKey, type AcceptedConversion } from './structural-plan.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { Representation } from '../representation/model.js'

export interface CertifiedProtocolIteratorPlan {
  readonly source: Representation
  readonly target: Representation
  readonly view: ProtocolIteratorPlan
  readonly leaves: ReadonlyMap<string, ConversionNode>
  readonly finishStep: boolean
}

export interface CertifiedIterableObjectViewPlan {
  readonly source: Representation
  readonly target: Representation
  readonly view: IterableObjectViewPlan
  readonly leaves: ReadonlyMap<string, ConversionNode>
}

const recorder =
  (leaves: Map<string, ConversionNode>, accepted: AcceptedConversion, resolve?: ConversionNodeResolver) =>
  (source: Representation, target: Representation): boolean => {
    const key = structuralConversionKey(source, target)
    if (leaves.has(key)) return true
    const node = accepted(source, target)
    if (node === null || !recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)) return false
    if (structuralConversionKey(node.source, node.target) !== key) throw new Error(`iterator protocol ${key} has a mismatched recipe`)
    leaves.set(key, node)
    return true
  }

/** Protocol callbacks keep every receiver, result and thrown-value adaptation in the certificate. */
export const certifiedProtocolIteratorPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver
): CertifiedProtocolIteratorPlan | null => {
  const leaves = new Map<string, ConversionNode>()
  const payload = target.kind === 'optional' ? target.payload : target
  const view = protocolIteratorPlan(layouts, source, payload, recorder(leaves, accepted, resolve))
  if (view === null) return null
  let finishStep = false
  if (view.target.kind === 'async-generator' && view.finish !== null) {
    const optionalLeaves = new Map<string, ConversionNode>()
    const accept = recorder(optionalLeaves, accepted, resolve)
    const valueless = view.target.completion.kind === 'void' || view.target.completion.kind === 'undefined'
    const records = iteratorResultRecordsOf(layouts, view.finish.result)
    finishStep =
      records !== null &&
      records.every(
        (arm) =>
          (!arm.yields || accept(arm.value.value, view.target.element)) &&
          (!arm.returns || valueless || accept(arm.value.value, view.target.completion))
      )
    if (finishStep) for (const [key, node] of optionalLeaves) leaves.set(key, node)
  }
  return { source, target, view, leaves, finishStep }
}

/** The collection callback cites its complete cursor-object conversion, including all deferred steps. */
export const certifiedIterableObjectViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve?: ConversionNodeResolver
): CertifiedIterableObjectViewPlan | null => {
  const leaves = new Map<string, ConversionNode>()
  const accept = recorder(leaves, accepted, resolve)
  const payload = target.kind === 'optional' ? target.payload : target
  const view = iterableObjectViewPlan(layouts, source, payload, accept)
  if (view === null) return null
  const object = view.result.kind === 'optional' ? view.result.payload : view.result
  return accept(view.cursor, object) ? { source, target, view, leaves } : null
}
