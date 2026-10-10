import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { sourceValueSessionOf } from './flow/source-value-session.js'

/** Every normal value comes from an actual object-producing operation. The
 * shared source session owns caller, missing/default argument, local writer,
 * return and receiver completeness; checker non-nullability is not evidence.
 * Callers must discharge the session's deferred intrinsic obligations.
 */
export const logicalLeftObjectTruthyAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, expression: ts.Expression): boolean => {
  const values = sourceValueSessionOf(checker, flow).valuesOf(expression)
  return (
    values !== null &&
    values.length > 0 &&
    values.every(
      (value) =>
        ts.isObjectLiteralExpression(value) ||
        ts.isArrayLiteralExpression(value) ||
        ts.isNewExpression(value) ||
        ts.isRegularExpressionLiteral(value) ||
        ts.isClassExpression(value) ||
        ts.isClassDeclaration(value) ||
        ts.isArrowFunction(value) ||
        ((ts.isFunctionDeclaration(value) || ts.isFunctionExpression(value) || ts.isMethodDeclaration(value)) && value.body !== undefined)
    )
  )
}
