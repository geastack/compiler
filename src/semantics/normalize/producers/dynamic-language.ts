import ts from 'typescript'
import type { DynamicLanguageOperation } from '../../model/operations.js'
import type { SemanticEdge } from '../../model/edges.js'
import type { SemanticOperand } from '../../model/operands.js'
import { normalCompletion } from '../../model/operands.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { asBlocked } from './shared.js'
import { citeExpressionResult } from './references.js'

export const createDynamicLanguageProducer = (context: ProducerContext): FamilyProducer => {
  const stringType = context.table.intern({ kind: 'primitive', primitive: 'string' })

  const contributeDynamicImport = (candidate: CensusCandidate, node: ts.CallExpression): CandidateContribution => {
    const source = candidate.id
    const specifierExpression = node.arguments[0]
    const operands: SemanticOperand[] = []
    const edges: SemanticEdge[] = []
    const id = mintOperationId(context.ordinals, source, 'dynamic-language')

    if (specifierExpression && ts.isStringLiteralLike(specifierExpression)) {
      // The specifier's text is a language-level VALUE here (the module request
      // string HostResolveImportedModule receives), not an identity: the module
      // this call reaches is genuinely unresolvable at compile time -- an `open`
      // target is the correct, complete answer, never a guess from this text.
      operands.push(operand('specifier', 0, { kind: 'constant', text: specifierExpression.text, literal: 'string' }, stringType))
    } else if (specifierExpression) {
      // A non-literal specifier (`import(path())`) is itself another family's
      // operation; cite its already/about-to-be-published result rather than
      // omitting the operand, exactly as properties.ts and bindings.ts do for
      // their own operand sources.
      const cited = citeExpressionResult(specifierExpression, context)
      if (cited.kind === 'unmodelled') {
        return asBlocked(candidate.id, 'dynamic-language', `dynamic import specifier ${cited.reason}`, 'H0')
      }
      operands.push(operand('specifier', 0, cited.source, stringType))
      if (cited.source.kind === 'result') {
        edges.push({ kind: 'value', result: cited.source.result, to: id, role: 'specifier', ordinal: 0 })
      }
    }

    const attributesArgument = node.arguments[1]
    if (attributesArgument && !ts.isObjectLiteralExpression(attributesArgument)) {
      return asBlocked(candidate.id, 'dynamic-language', 'dynamic import attributes argument of an unmodelled shape', 'H0')
    }

    // `import()` never throws synchronously (PerformDynamicImportEvaluation
    // always returns a promise); a resolution or evaluation failure surfaces as
    // a rejected promise, which is a data-level fact about the produced value,
    // not an abrupt completion of this expression.
    const resultType = context.types.typeAt(node)
    const operation: DynamicLanguageOperation = {
      id,
      caller: candidate.caller,
      operands,
      results: [mintResult(id, 'value', resultType)],
      completion: normalCompletion,
      effects: { readsMutableState: false, writesMutableState: false, allocates: true, callsUserCode: false },
      evaluationOrdinal: candidate.evaluationOrdinal,
      family: 'dynamic-language',
      form: 'dynamic-import'
    }

    return { kind: 'operations', operations: [operation], edges }
  }

  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const { node } = candidate
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return contributeDynamicImport(candidate, node)
    }
    // The census (see `familyOf` in census.ts) currently routes only `import()`
    // call expressions to this family; `direct-eval` requires proving a callee
    // resolves to the un-shadowed global `eval` binding, which is checker
    // identity this producer does not yet perform, and no census candidate
    // reaches it under this family regardless.
    return asBlocked(
      candidate.id,
      'dynamic-language',
      'direct eval requires checker-resolved global-eval binding identity, not yet available here',
      'H0'
    )
  }

  return { family: 'dynamic-language', contribute }
}
