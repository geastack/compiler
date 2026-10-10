import type { ConstantLiteral } from './model/operands.js'

/** ToPropertyKey of a primitive literal: `o[1.0]`, `o[1]` and `o['1']` name
 * one property, as do `o[true]` and `o['true']`. Every reader that compares a
 * constant key against a declared or written key goes through this one
 * canonicalization; comparing raw spellings makes one key look like two.
 * Null means the text names no value this compiler can canonicalize.
 * @semanticCategory generic-primitive
 */
export const propertyKeyTextOf = (literal: ConstantLiteral, text: string): string | null => {
  switch (literal) {
    case 'string':
    case 'boolean':
    case 'null':
    case 'undefined':
      return text
    case 'number':
      return String(Number(text))
    case 'bigint':
      try {
        return BigInt(text).toString()
      } catch {
        return null
      }
  }
}
