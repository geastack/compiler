import { outermostErasureOf } from './erasure.js'
import ts from 'typescript'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import type { ComputationOperation } from '../../model/operations.js'
import { throwingCompletion } from '../../model/operands.js'
import { isGlobalObjectConstructor } from '../derived-expression-type.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { sourceForValue, unwrapErased, valueEdgesInto } from './shared.js'
import { intactIntrinsicPrototypeKeysType } from '../intrinsic-prototype.js'
import { intrinsicObjectKeysIntact } from '../host-mutation-keys.js'

/** Authenticate the borrowed algorithm while declarations and mutation facts exist. */
export const isAuthenticatedObjectTag = (context: ProducerContext, node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node) || node.arguments.some(ts.isSpreadElement)) return false
  const call = unwrapErased(node.expression)
  if (!ts.isPropertyAccessExpression(call) || call.name.text !== 'call') return false
  const method = unwrapErased(call.expression)
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'toString') return false
  const prototype = unwrapErased(method.expression)
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== 'prototype') return false
  const owner = prototype.expression
  if (!isGlobalObjectConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner))) return false
  const taint = context.globalHostMutationTaint
  if (taint.has('*')) return false
  // Function.call and CallableFunction.call have distinct checker declarations
  // but borrow the same runtime prototype. Ask its shared mutation identity,
  // for the one key this borrowing reads from it.
  if (intactIntrinsicPrototypeKeysType(context, 'Function', { names: ['call'] }, owner) === null) return false
  // Each link reads one key: `Object.prototype`, then its `toString`, then
  // that function's `call`. A member link must not have been replaced; an
  // owner link must not have had the next key written.
  const keyReadThrough = new Map<ts.Node, string>([
    [owner, 'prototype'],
    [prototype.name, 'toString'],
    [method.name, 'call']
  ])
  for (const location of [owner, prototype.name, method.name, call.name]) {
    const symbol = context.checker.getSymbolAtLocation(location)
    const declarations = location === owner ? (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []) : (symbol?.declarations ?? [])
    if (declarations.length === 0 || !declarations.every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true))
      return false
    const identity = symbol
      ? location === owner
        ? context.identities.symbolValueDeclarationId(symbol, owner)
        : context.identities.symbolDeclarationId(symbol)
      : null
    if (identity === null) return false
    const next = keyReadThrough.get(location)
    // The owner and `Object.prototype` are objects read through by key; the
    // member declarations are values that must not have been replaced.
    const objectIntact = next === undefined || intrinsicObjectKeysIntact(taint, identity, { names: [next] })
    const replaced = location !== owner && location !== prototype.name && taint.has(identity)
    if (!objectIntact || replaced) return false
  }
  const primitivePrototypesIntact = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.every(primitivePrototypesIntact)
    const flags = type.flags
    const names =
      (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
        ? ['Number', 'String', 'Boolean', 'BigInt', 'Symbol']
        : (flags & ts.TypeFlags.NumberLike) !== 0
          ? ['Number']
          : (flags & ts.TypeFlags.StringLike) !== 0
            ? ['String']
            : (flags & ts.TypeFlags.BooleanLike) !== 0
              ? ['Boolean']
              : (flags & ts.TypeFlags.BigIntLike) !== 0
                ? ['BigInt']
                : (flags & ts.TypeFlags.ESSymbolLike) !== 0
                  ? ['Symbol']
                  : []
    // A primitive receiver's tag is read from its wrapper prototype's @@toStringTag.
    return names.every((name) => intactIntrinsicPrototypeKeysType(context, name, { names: ['@@toStringTag'] }, node) !== null)
  }
  const receiver = node.arguments[0]
  return !receiver || primitivePrototypesIntact(context.checker.getTypeAtLocation(receiver))
}

export const contributeObjectTag = (context: ProducerContext, candidate: CensusCandidate, node: ts.Node): CandidateContribution | null => {
  if (!isAuthenticatedObjectTag(context, node)) return null
  // Preserve the invocation candidate's published identity: callers already cite it.
  // Authentication changes the operation's algorithm, not the source expression.
  const id = mintOperationId(context.ordinals, candidate.id, 'invocation')
  const args = node.arguments
  const receiver = args[0]
  const receiverIsVoid = receiver !== undefined && (context.checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Void) !== 0
  const operands = [
    receiver && !receiverIsVoid
      ? operand('operand', 0, sourceForValue(context, receiver), context.types.typeAt(receiver))
      : operand(
          'operand',
          0,
          { kind: 'constant', text: 'undefined', literal: 'undefined' },
          context.types.typeOf(context.checker.getUndefinedType())
        ),
    ...(receiverIsVoid ? args : args.slice(1)).map((argument, index) =>
      operand('ignored-argument', index, sourceForValue(context, argument), context.types.typeAt(argument))
    )
  ]
  const operation: ComputationOperation = {
    id,
    family: 'computation',
    caller: candidate.caller,
    form: 'unary',
    operator: 'ObjectTag',
    operands,
    results: [mintResult(id, 'value', context.types.typeOf(context.checker.getStringType()))],
    completion: throwingCompletion,
    effects: { readsMutableState: true, writesMutableState: false, allocates: false, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: valueEdgesInto(id, operands) }
}

/** Proven intrinsic callee reads are consumed by the ObjectTag algorithm itself. */
export const isObjectTagCalleePart = (context: ProducerContext, node: ts.Node): boolean => {
  let current = outermostErasureOf(node)
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current)
    current = outermostErasureOf(current.parent)
  return ts.isCallExpression(current.parent) && current.parent.expression === current && isAuthenticatedObjectTag(context, current.parent)
}
