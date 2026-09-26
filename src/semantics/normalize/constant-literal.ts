import ts from 'typescript'
import type { ConstantLiteral } from '../model/operands.js'
import { unwrapErasedExpression } from './producers/erasure.js'

/**
 * The literal an expression cites as a constant operand, not a result: the
 * one rule for which expressions publish no operation of their own.
 */
export const literalConstantOf = (expression: ts.Expression): { text: string; literal: ConstantLiteral } | null => {
  if (ts.isStringLiteralLike(expression)) return { text: expression.text, literal: 'string' }
  if (ts.isNumericLiteral(expression)) return { text: expression.text, literal: 'number' }
  if (expression.kind === ts.SyntaxKind.BigIntLiteral)
    return { text: (expression as ts.BigIntLiteral).text.slice(0, -1), literal: 'bigint' }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { text: 'true', literal: 'boolean' }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { text: 'false', literal: 'boolean' }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { text: 'null', literal: 'null' }
  // `undefined` is spelled as a name, but it is not a binding any program
  // reads: the global property is non-writable and non-configurable, so every
  // resolution of the unshadowed name yields the one value. Citing it as a
  // constant is what `null` already gets, and it is what lets `undefined as
  // unknown as T` -- the standard ambient-global guard -- publish a value at
  // all. A program that declares its *own* `undefined` is a different name;
  // `buildReference` refuses that one by name rather than letting this text
  // answer for it.
  if (ts.isIdentifier(expression) && expression.text === 'undefined') return { text: 'undefined', literal: 'undefined' }
  return null
}

/**
 * ToBoolean (ECMA-262 7.2.14) of a condition that is a constant operand, or
 * `null` when it publishes a result. A constant condition decides statically
 * which arm runs, and it has no result a gate could name, so the arm it rules
 * out is never evaluated and publishes no operation -- the same rule that
 * drops `y()` after `return x`.
 */
export const constantTruthinessOf = (condition: ts.Expression): boolean | null => {
  const constant = literalConstantOf(unwrapErasedExpression(condition))
  if (!constant) return null
  switch (constant.literal) {
    case 'string':
      return constant.text !== ''
    case 'number': {
      const value = Number(constant.text)
      return value !== 0 && !Number.isNaN(value)
    }
    case 'bigint':
      return BigInt(constant.text) !== 0n
    case 'boolean':
      return constant.text === 'true'
    default:
      return false
  }
}
