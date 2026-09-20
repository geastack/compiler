import ts from 'typescript'
import { excludesNullish } from './nullish.js'

/**
 * Which link of an optional chain answers for the whole chain, and what it
 * branches on.
 *
 * Three producers ask this -- `properties.ts` builds the gated `[[Get]]`,
 * `invocations.ts` builds the gated `[[Call]]`, and `references.ts` decides
 * which of a link's two results a citer gets -- and they must agree exactly. A
 * link that publishes a `short-circuit` result nobody cites leaves a value
 * unread; a citer that asks for one nobody published names a result no producer
 * installed, which the publication guard withholds silently. So the rule lives
 * here once rather than as three spellings of it.
 */

/**
 * The nearest optional link's base, shared by every operation in that chain.
 * ECMA-262 (2025), OptionalExpression / ChainEvaluation: plain suffixes keep
 * the original short-circuit condition; only another ?. introduces a new one.
 * Parentheses end a chain, so the walk follows the checker's OptionalChain
 * flags instead of erasing expression wrappers before asking the question.
 */
export const optionalChainGuardOf = (node: ts.Node): ts.Expression | null => {
  if (!ts.isOptionalChain(node)) return null
  if (ts.isNonNullExpression(node)) return optionalChainGuardOf(node.expression)
  if (node.questionDotToken !== undefined) return node.expression
  return optionalChainGuardOf(node.expression)
}

export const optionalCallGuardOf = (node: ts.CallExpression): ts.Expression | null => optionalChainGuardOf(node)

/** Every value-producing link publishes the whole expression's undefined arm. */
export const publishesShortCircuit = (node: ts.Node): boolean => optionalChainGuardOf(node) !== null

/**
 * What a call's signature returns on the branch where it actually ran.
 *
 * The checker augments the signature it resolves for an optional call: ask
 * `d?.scale(2)` for its resolved return and it answers `number | undefined`,
 * not `number`. That `undefined` is the *chain's*, not the method's -- the
 * method returns `number` and never runs at all on the other branch -- so a
 * consumer that believes it builds a callee carrier the callee does not have,
 * and the store of the real method into it has no conversion.
 *
 * The strip is licensed rather than assumed, exactly as `presentValueTypeOf`
 * licenses the property half: the signature is asked for its *own* declared
 * return, uninstantiated by any call site, and the `undefined` is removed only
 * when that has none of its own. A signature with no declaration, an inferred
 * return this cannot re-ask, or a genuinely `undefined`-returning one keeps the
 * union -- wider than the truth, and never narrower than it.
 */
// Deliberately checker-only, not a bypass to route through a census: both
// callers (`producers/shared.ts`'s `resolvedCalleeSignatureType`,
// `producers/invocations.ts`'s `buildSelectedSignature`) already reconcile
// a census answer around this -- `invocations.ts`'s own extensive comment on
// `censusReturn`/`siteReturn` covers exactly why this stays the checker's raw
// SIGNATURE answer (this callee's own declared shape, stripped of the
// chain's synthetic `undefined`) rather than a second place asking the same
// return-binding question the census already owns downstream.
export const presentReturnTypeOf = (checker: ts.TypeChecker, signature: ts.Signature): ts.Type => {
  const returned = signature.getReturnType()
  const declaration = signature.getDeclaration()
  const declared = declaration ? checker.getSignatureFromDeclaration(declaration) : undefined
  // `void | undefined` describes the chain's value, but `() => void` is the
  // method's ABI. Normalizing that union as a stored value would publish an
  // undefined-returning callable and make the actual void method unassignable.
  // An explicitly void signature has no type parameters in its result to
  // instantiate, so its declaration is also the exact present-branch answer.
  if (declared && (declared.getReturnType().flags & ts.TypeFlags.Void) !== 0) return declared.getReturnType()
  if (!declared || !excludesNullish(declared.getReturnType())) return returned
  return checker.getNonNullableType(returned)
}

/** Whether this call is one whose resolved signature the checker augmented with the chain's `undefined`. */
export const isShortCircuitingCall = (call: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression): boolean =>
  ts.isCallExpression(call) && optionalCallGuardOf(call) !== null
