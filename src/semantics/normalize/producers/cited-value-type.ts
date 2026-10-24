import ts from '#typescript'
import type { StructuralTypeId } from '../../../identity/ids.js'
import type { ProducerContext } from '../producer-context.js'
import { assertsPresence, assertsType, unwrapErased } from './erasure.js'
import { objectCreateResultOverride } from './invocations.js'
import { logicalMergeTypeOf } from './logical-merge-type.js'
import { propertyExpressionValueTypeAt } from './properties.js'
import { declaredAbsenceTypeAt } from './references.js'

/**
 * The type an operand citing `node`'s published value carries: the checker's
 * view of the node, except where a producer publishes that value under a type
 * of its own, which a second checker query at the same node cannot see.
 *
 * - A logical merge, whose result `computations.ts` publishes under
 *   `logicalMergeTypeOf`.
 * - An `Object.create(null)` call, which publishes the carrier
 *   `objectCreateResultOverride` mints rather than the ambient `any`.
 * - A property read, which `properties.ts` publishes under
 *   `propertyExpressionValueTypeAt`: an index-signature read a test observes
 *   (`dict[key] && x`) carries `T | undefined` where the checker reports `T`,
 *   and a merge citing the checker's `T` for it typed its kept branch as a
 *   present value and dereferenced the absence.
 * - A name's read of an explicitly optional local at a use that observes
 *   absence, which `references.ts` publishes under the declared carrier
 *   (`declaredAbsenceTypeAt`) where the checker's flow narrowing says `T`.
 *
 * A non-null assertion (`dict[key]!`) asserts that absence away, and a type
 * assertion naming a type (`dict[key] as T`) states the value's type outright:
 * the citation keeps the checker's type at the assertion, and the operand's
 * conversion proves it there, as it did before the read's own carrier was
 * consulted.
 *
 * A citation that re-asked the checker boxed the value at the citation: a
 * trie router's `Node` does `this.#children = children || Object.create(null)`;
 * the merge cited the call as `any` and the field write cited the merge as
 * `any`, so the optional parameter was boxed and unboxed into the field.
 */
export const citedValueTypeAt = (context: ProducerContext, node: ts.Expression): StructuralTypeId => {
  const unwrapped = unwrapErased(node)
  if (ts.isCallExpression(unwrapped)) {
    const created = objectCreateResultOverride(context, unwrapped, unwrapErased(unwrapped.expression))
    if (created !== null) return created
  }
  if (!assertsPresence(node) && !assertsType(node, context.checker)) {
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped))
      return propertyExpressionValueTypeAt(context, unwrapped)
    if (ts.isIdentifier(unwrapped)) {
      const declared = declaredAbsenceTypeAt(context, unwrapped)
      if (declared !== null) return declared
    }
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const operator = unwrapped.operatorToken.kind
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const merged = logicalMergeTypeOf(
        context,
        ts.tokenToString(operator) ?? '',
        unwrapped,
        citedValueTypeAt(context, unwrapped.left),
        citedValueTypeAt(context, unwrapped.right)
      )
      if (merged !== null) return merged
    }
  }
  return context.types.typeAt(node)
}
