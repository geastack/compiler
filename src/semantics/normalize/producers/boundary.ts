import ts from 'typescript'
import type { StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, pureEffects, type OperandSource, type SemanticResult } from '../../model/operands.js'
import type { BindingOperation, BoundaryOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { unwrapErased } from './erasure.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { citeExpressionResult } from './references.js'
import { valueEdgesInto } from './shared.js'

/**
 * The operand a producer in this tree can build to consume an arbitrary
 * expression's published value, without itself owning that expression's
 * operation.
 *
 * The identity comes from `citeExpressionResult` and from nowhere else. This
 * was a private copy of the same rule, and it had already drifted: it cited a
 * name's `reference` result where the shared rule cites the value `GetValue`
 * publishes, so every `return x` and every `if (x)` in the program built an
 * operand naming a result no producer publishes -- and the publication guard
 * then withheld the whole operation with no error, only an absence.
 *
 * `null` means the expression has no citable result, which callers must treat
 * as unprovable rather than guess an identity for.
 */
export const resolveExpressionOperand = (
  context: ProducerContext,
  node: ts.Node
): { readonly source: OperandSource; readonly type: StructuralTypeId } | null => {
  if (!ts.isExpression(node)) return null
  const cited = citeExpressionResult(node, context)
  if (cited.kind === 'unmodelled') return null
  return { source: cited.source, type: context.types.typeAt(unwrapErased(node)) }
}

/**
 * Catch clauses: the one candidate family `'boundary'` receives from the
 * census (`census.ts` assigns every other boundary concept -- the exception
 * region a `try` protects, a `finally`'s override, label targets,
 * generator/async resume points -- to `'control'`, since only `CatchClause`
 * syntax is classified `'boundary'` there). `control.ts` mints those other
 * `BoundaryOperation` kinds as auxiliary operations of its own `'control'`
 * candidates, exactly as it mints `'protocol'` operations for `for`-`of`/`in`.
 */
export const createBoundaryProducer = (context: ProducerContext): FamilyProducer => {
  // One project-wide counter per caller, supplied by the context: a counter
  // local to this producer would hand the same caller-relative ordinal to a
  // sibling family, giving two distinct operations one identity.

  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node
    if (!ts.isCatchClause(node)) {
      return {
        kind: 'blocked',
        blocker: blocked(candidate.id, 'boundary', 'boundary census produced a syntax kind this producer does not model', null)
      }
    }

    const id = mintOperationId(context.ordinals, candidate.id, 'boundary')
    const results: SemanticResult[] = []
    const auxiliary: BindingOperation[] = []
    const auxiliaryEdges: SemanticEdge[] = []
    if (node.variableDeclaration) {
      // ECMAScript does not type a thrown value; TypeScript's own answer for an
      // unannotated catch binding is `unknown` under `useUnknownInCatchVariables`
      // (the default under `strict`, which `program.ts` enables) or `any` when a
      // program opts out. Publishing whatever the checker says here -- never a
      // fabricated shape -- is what lets a later layer choose the dynamic carrier
      // for reason `'thrown-error-carrier'` instead of inventing a static type or
      // conflating this with a plain user-declared, never-narrowed `any`.
      const type = context.types.typeAt(node.variableDeclaration)
      const exceptionValue = mintResult(id, 'value', type)
      results.push(exceptionValue)

      // The exception region publishes the caught value as its own result, but
      // nothing reads a `catch (error)` body's `error` identifier by citing that
      // result directly -- reference resolution goes through the checker's own
      // symbol, which for a catch binding resolves to this `VariableDeclaration`
      // (the same binder fact an ordinary `const`/`let` rests on). So the name
      // needs an ordinary binding cell, initialized from the region's own value,
      // exactly as `bindings.ts`'s `contributeVariableDeclaration` initializes
      // one from a cited expression -- the only difference is the source is an
      // operation's published result instead of an expression's.
      //
      // A destructured catch binding (`catch ({message})`) is refused rather
      // than guessed at: it needs the pattern's own extraction composed with
      // this citation, which is a second producer's concern this one does not
      // reach into -- the same restriction `contributeParameter` states for a
      // destructured default parameter.
      if (!ts.isIdentifier(node.variableDeclaration.name)) {
        return {
          kind: 'blocked',
          blocker: blocked(
            candidate.id,
            'boundary',
            "a destructured catch binding needs the pattern's own extraction composed with the caught value, which is not installed",
            'P2'
          )
        }
      }
      const bindId = mintOperationId(context.ordinals, candidate.id, 'binding')
      const bindOperand = operand('initializer', 0, { kind: 'result', result: exceptionValue.id }, type)
      const bindOperation: BindingOperation = {
        id: bindId,
        family: 'binding',
        action: 'initialize',
        declaration: context.identities.declarationIdOf(node.variableDeclaration),
        // A caught binding is an ordinary mutable local, live for the whole
        // catch block from the moment the handler is entered -- like a
        // parameter, never a `let`/`const` with a dead zone to fall into.
        mutable: true,
        temporalDeadZone: false,
        caller: candidate.caller,
        operands: [bindOperand],
        results: [mintResult(bindId, 'value', type)],
        completion: normalCompletion,
        effects: { ...pureEffects, writesMutableState: true },
        evaluationOrdinal: candidate.evaluationOrdinal
      }
      auxiliary.push(bindOperation)
      auxiliaryEdges.push(...valueEdgesInto(bindId, [bindOperand]))
    }

    const operation: BoundaryOperation = {
      family: 'boundary',
      id,
      boundary: 'exception-region',
      caller: candidate.caller,
      operands: [],
      results,
      completion: normalCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    return { kind: 'operations', operations: [operation, ...auxiliary], edges: auxiliaryEdges }
  }

  return { family: 'boundary', contribute }
}
