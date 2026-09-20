import ts from 'typescript'

export type LogicalOperator = '&&' | '||' | '??'

/** The values a short-circuit operator can keep from its left operand. */
const partitionsOf = (checker: ts.TypeChecker, type: ts.Type): { truthy: ts.Type[]; falsy: ts.Type[]; nullish: ts.Type[] } => {
  const truthy: ts.Type[] = []
  const falsy: ts.Type[] = []
  const nullish: ts.Type[] = []
  const visit = (part: ts.Type): void => {
    if (part.isUnion()) {
      for (const member of part.types) visit(member)
      return
    }
    const flags = part.flags
    if (flags & ts.TypeFlags.Never) return
    if (flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      falsy.push(part)
      nullish.push(part)
      return
    }
    if (flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.ESSymbolLike)) {
      truthy.push(part)
      return
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      ;(checker.isTypeAssignableTo(part, checker.getFalseType()) ? falsy : truthy).push(part)
      return
    }
    if (part.isStringLiteral() || part.isNumberLiteral()) {
      ;(part.value === '' || part.value === 0 ? falsy : truthy).push(part)
      return
    }
    if (part.isLiteral() && flags & ts.TypeFlags.BigIntLiteral) {
      ;(typeof part.value === 'object' && part.value.base10Value === '0' ? falsy : truthy).push(part)
      return
    }
    truthy.push(part)
    if (flags & ts.TypeFlags.String) falsy.push(checker.getStringLiteralType(''))
    else if (flags & ts.TypeFlags.Boolean) falsy.push(checker.getFalseType())
    else if (flags & ts.TypeFlags.BigInt) falsy.push(checker.getBigIntLiteralType({ negative: false, base10Value: '0' }))
    else {
      // Number's falsy values include NaN, which has no literal type. Keep the
      // Number domain instead of inventing a zero-only fact. Unresolved type
      // parameters and dynamic operands likewise retain their uncertainty.
      falsy.push(part)
      if (!(flags & ts.TypeFlags.NumberLike)) nullish.push(part)
    }
  }
  visit(type)
  return { truthy, falsy, nullish }
}

/**
 * The arms of `left` the operator KEEPS as the whole expression's value --
 * the ones under which the right operand never evaluates -- plus whether the
 * right operand is reachable at all.
 *
 * Split out so the two questions asked of a short-circuit operator have one
 * answer between them: `logicalResultTypeOf` below needs the merge, while a
 * caller holding an operand carrier the checker does not agree with needs the
 * left half ALONE, to union against its own right-hand answer rather than
 * against the checker's.
 */
const keptPartsOf = (
  checker: ts.TypeChecker,
  operator: LogicalOperator,
  left: ts.Type
): { readonly kept: ts.Type[]; readonly evaluatesRight: boolean } => {
  const { truthy, falsy, nullish } = partitionsOf(checker, left)
  const kept = operator === '&&' ? falsy : operator === '||' ? truthy : [...truthy, ...falsy].filter((part) => !nullish.includes(part))
  const evaluatesRight = (operator === '&&' ? truthy : operator === '||' ? falsy : nullish).length > 0
  // Unknown/any may hold both present and nullish values. Filtering the same
  // uncertain arm out entirely would turn `unknown ?? typed` into a proof.
  if (operator === '??')
    for (const part of nullish) if (!(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void))) kept.push(part)
  return { kept, evaluatesRight }
}

const unionOf = (checker: ts.TypeChecker, members: readonly ts.Type[]): ts.Type | null =>
  (checker as unknown as { getUnionType?: (parts: readonly ts.Type[]) => ts.Type }).getUnionType?.(members) ?? null

/**
 * The value `left` contributes to `left <op> right` on the branch that does
 * NOT evaluate `right`, or `null` when there is no such branch -- an
 * always-truthy `left` under `&&`, an always-falsy one under `||` -- in which
 * case the expression's value is the right operand's, unqualified.
 *
 * The distinction is the whole point for `&&`: `obj && obj.x` keeps nothing
 * from `obj`, so the expression IS `obj.x`. Widening it to "either operand"
 * would union an object carrier with a number and produce a tagged union
 * where an exact answer exists.
 */
export const keptLeftPartTypeOf = (checker: ts.TypeChecker, operator: LogicalOperator, left: ts.Type): ts.Type | null => {
  const { kept } = keptPartsOf(checker, operator, left)
  return kept.length === 0 ? null : unionOf(checker, kept)
}

/** Combine settled operand types by the operator's value-selection rule, without a second checker query at the expression. */
export const logicalResultTypeOf = (checker: ts.TypeChecker, operator: LogicalOperator, left: ts.Type, right: ts.Type): ts.Type | null => {
  const { kept, evaluatesRight } = keptPartsOf(checker, operator, left)
  return unionOf(checker, evaluatesRight ? [...kept, right] : kept)
}
