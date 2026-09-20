import ts from 'typescript'
import type { OperationId } from '../../identity/ids.js'
import type { CensusCandidate } from '../../semantics/normalize/census.js'
import type { CandidateContribution, FamilyProducer } from '../../semantics/normalize/contribution.js'
import type { ProducerContext } from '../../semantics/normalize/producer-context.js'
import { createElementProducer } from '../../semantics/normalize/producers/jsx.js'
import { elementFactsOf, type GeaElementFacts } from './contract.js'

/**
 * gea's element producer.
 *
 * It publishes exactly what the core's does -- the same operations, the same
 * identities, the same operand pairing -- and additionally records, for every
 * element whose tag names a value, what gea says that element means. The two
 * halves are deliberately not merged: the operations belong to the graph, which
 * every stage reads, while the meaning belongs to gea and is read only by gea's
 * own lowering. Putting the second on the operation would put a library's
 * vocabulary into a model that other libraries also publish into.
 *
 * Delegating rather than reimplementing is a choice about drift, not effort.
 * An element's identity is minted from its node and its family, and a second
 * producer that minted its own would have to stay in agreement with the first
 * forever; there is nothing about the *language* half of an element that gea
 * disagrees with, so it does not restate it.
 */

/** The tag of an element node, or `null` for a fragment, which names none. */
const tagNameOf = (node: ts.Node): ts.JsxTagNameExpression | null => {
  if (ts.isJsxSelfClosingElement(node)) return node.tagName
  if (ts.isJsxElement(node)) return node.openingElement.tagName
  if (ts.isJsxOpeningElement(node)) return node.tagName
  return null
}

export const createGeaElementProducer = (context: ProducerContext, facts: Map<OperationId, GeaElementFacts>): FamilyProducer => {
  const core = createElementProducer(context)
  return {
    family: core.family,
    contribute: (candidate: CensusCandidate): CandidateContribution => {
      const contribution = core.contribute(candidate)
      if (contribution.kind !== 'operations') return contribution
      const tagName = tagNameOf(candidate.node)
      if (!tagName) return contribution
      for (const operation of contribution.operations) {
        if (operation.family !== 'element' || operation.form !== 'value') continue
        const resolved = elementFactsOf(context.checker, tagName)
        if (resolved) facts.set(operation.id, resolved)
      }
      return contribution
    }
  }
}
