import type { NodeId, OperationFamily, OperationId, ResultRole, StructuralTypeId } from '../../../identity/ids.js'
import { operationId, semanticResultId } from '../../../identity/ids.js'
import type { CensusBlocker } from '../../model/coverage.js'
import type { OperandEvaluation, OperandSource, SemanticCaller, SemanticOperand, SemanticResult } from '../../model/operands.js'
import type { PrimitiveFamily } from '../../model/coverage.js'

/**
 * Shared minting helpers for family producers.
 *
 * One AST node can normalize to several operations, and the ordinal is what
 * keeps them apart. Producers must allocate ordinals from a single counter per
 * node so that two producers cannot mint the same identity for different
 * operations -- which would silently merge two operations into one.
 */

export interface OrdinalCounter {
  readonly next: (source: NodeId, family: OperationFamily) => number
}

export const createOrdinalCounter = (): OrdinalCounter => {
  const used = new Map<string, number>()
  return {
    next: (source, family) => {
      const key = `${source}|${family}`
      const ordinal = used.get(key) ?? 0
      used.set(key, ordinal + 1)
      return ordinal
    }
  }
}

/**
 * Per-caller evaluation sequencing.
 *
 * Evaluation order is a property of the executing context, not of the family
 * that happens to be publishing. One counter per caller shared by every producer
 * is what keeps two families from handing out the same ordinal inside one
 * function -- which would give two distinct operations one identity.
 */
export interface EvaluationOrdinals {
  readonly next: (caller: SemanticCaller) => number
}

const callerKey = (caller: SemanticCaller): string => (caller.kind === 'function' ? `fn|${caller.functionId}` : `region|${caller.regionId}`)

export const createEvaluationOrdinals = (): EvaluationOrdinals => {
  const used = new Map<string, number>()
  return {
    next: (caller) => {
      const key = callerKey(caller)
      const ordinal = used.get(key) ?? 0
      used.set(key, ordinal + 1)
      return ordinal
    }
  }
}

export const mintOperationId = (counter: OrdinalCounter, source: NodeId, family: OperationFamily): OperationId =>
  operationId(source, family, counter.next(source, family))

export const mintResult = (operation: OperationId, role: ResultRole, type: StructuralTypeId): SemanticResult => ({
  id: semanticResultId(operation, role),
  role,
  type
})

export const operand = (
  role: string,
  ordinal: number,
  source: OperandSource,
  type: StructuralTypeId,
  evaluation: OperandEvaluation = { kind: 'runtime' }
): SemanticOperand => ({ role, ordinal, source, type, evaluation })

/**
 * A blocker states a missing capability, not a source shape.
 *
 * "cannot normalize `foo.bar` in file X" is not a blocker: it names a site. The
 * blocker must name what the compiler cannot yet do, so that fixing it fixes
 * every site at once.
 */
export const blocked = (
  source: NodeId,
  family: OperationFamily,
  reason: string,
  missingPrimitive: PrimitiveFamily | null
): CensusBlocker => ({
  source,
  family,
  reason,
  missingPrimitive
})
