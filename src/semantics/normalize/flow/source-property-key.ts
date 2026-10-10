import ts from 'typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'

/** Erased type wrappers do not change the source property key. */
export const literalSourcePropertyKeyOf = (node: ts.Expression): string | null => {
  const value = unwrapErasedExpression(node)
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : null
}
