import type { IrValueId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { intrinsicCallArgumentMatches } from './intrinsic-call-facts.js'
import type { CallOperation, IrOperation } from './model.js'

/** Installation reads descriptor fields with HasProperty. A native recipe
 * may omit inherited reads only when normalization discharged the exact
 * descriptor's missing names against the final prototype ledger.
 * The caller separately proves the current literal or snapshot own fields;
 * an equal-shaped public PropertyDescriptor is not an own-field inventory.
 * @semanticCategory generic-primitive
 */
export const descriptorOwnProtocolMatches = (
  operation: CallOperation,
  semantic: SemanticOperation | null,
  graph: Pick<SemanticGraph, 'operations' | 'results'>,
  definitionOf: (value: IrValueId) => IrOperation | null,
  ownNames: readonly string[]
): boolean => {
  if (
    semantic?.family !== 'invocation' ||
    semantic.internalMethod !== 'call' ||
    semantic.intrinsicMutation !== 'object-define-property' ||
    semantic.descriptorOwnProtocol === undefined ||
    operation.lineage === null ||
    resultOf(semantic, 'value')?.id !== operation.lineage ||
    graph.results.get(operation.lineage) !== semantic.id ||
    graph.operations.get(semantic.id) !== semantic ||
    operation.argumentsAreSpread ||
    operation.arguments.length !== 3
  )
    return false
  const protocol = semantic.descriptorOwnProtocol
  const descriptor = operandOf(semantic, 'argument', 2)
  if (
    protocol.prototype !== 'ordinary-intact-absent' ||
    descriptor?.source.kind !== 'result' ||
    protocol.descriptor !== descriptor.source.result ||
    !intrinsicCallArgumentMatches(operation, semantic, 2, definitionOf) ||
    protocol.ownNames.includes('__proto__') ||
    new Set(protocol.ownNames).size !== protocol.ownNames.length ||
    new Set(ownNames).size !== ownNames.length ||
    ownNames.length !== protocol.ownNames.length
  )
    return false
  const actual = new Set(ownNames)
  return protocol.ownNames.every((name) => actual.has(name))
}
