import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { classFamilyMemberReadTypeOf, type FamilyReceiverCensus } from './flow/class-family-member-read.js'
import { disjointUnionTypeOf, memberTypeOf } from './derived-expression-type.js'

/**
 * A READ OF A UNION-HELD CONST BEHIND A TEST OF ONE OF ITS MEMBERS.
 *
 * TypeScript narrows a union by a discriminant compared against a literal --
 * but only a union IT holds. A local the checker types `any` (its value comes
 * through a JSDoc tag naming a class its module never imports) holds a union
 * only the binding census synthesized, and the checker's narrowing never
 * reaches it. three's vertex-layout loop is the case:
 *
 *   const geometryAttribute = attributes[ slot ]   // BufferAttribute | InterleavedBufferAttribute
 *   const offset = ( geometryAttribute.isInterleavedBufferAttribute === true ) ? geometryAttribute.offset * bytesPerElement : 0
 *
 * `BufferAttribute` has no `isInterleavedBufferAttribute` member, so its read
 * is `undefined` and `=== true` is false for it: only the interleaved arm can
 * reach `geometryAttribute.offset`, whose `offset` is a `number`.
 *
 * The inference is the language's own. A strict equality between values of
 * different types, or of different literal values, is false (ECMA-262
 * 7.2.15 IsStrictlyEqual); so an arm whose member type holds no value equal
 * to the literal cannot pass `=== literal`, and an arm whose member is that
 * one value cannot pass `!== literal`. And reading a member of `undefined` or
 * `null` throws (13.3.2, through ToObject), so past any such test the binding
 * holds neither.
 *
 * Kept to a `const` binding: its value is fixed from its initialization on,
 * so a test of it that passed still describes it at every read the test
 * dominates, closures included. An arm whose member type the program does not
 * state (`null` from the member question) is kept -- only a proven disjoint
 * arm is dropped. Which arms a member read yields is the one authority every
 * binding census already asks: the declared member, then the closed class
 * family (`flow/class-family-member-read.ts`), which proves an absent member
 * reads `undefined`.
 */
export interface MemberGuard {
  /** The member the test reads. */
  readonly name: string
  /** The literal the member is compared with. */
  readonly literal: ts.Type
  /** Whether the member is known to equal the literal (`true`) or known to differ from it (`false`). */
  readonly equal: boolean
  /** The member read in the test, where its type is asked. */
  readonly at: ts.PropertyAccessExpression
}

/** The member tests of `read`'s const binding that must have held for control to reach `read`. */
export const memberGuardsOf = (checker: ts.TypeChecker, read: ts.Identifier): readonly MemberGuard[] => {
  const symbol = checker.getSymbolAtLocation(read)
  const declarations = symbol?.declarations
  const declaration = declarations?.length === 1 ? declarations[0] : undefined
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return []
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return []
  const guards: MemberGuard[] = []
  const collect = (condition: ts.Expression, holds: boolean): void => {
    let test = condition
    while (ts.isParenthesizedExpression(test)) test = test.expression
    if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken) return collect(test.operand, !holds)
    if (!ts.isBinaryExpression(test)) return
    const operator = test.operatorToken.kind
    // Both conjuncts of a true `&&`, both disjuncts of a false `||`.
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken && holds) return (collect(test.left, true), collect(test.right, true))
    if (operator === ts.SyntaxKind.BarBarToken && !holds) return (collect(test.left, false), collect(test.right, false))
    const strictEqual = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    if (!strictEqual && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return
    const guard = memberTestOf(test.left, test.right) ?? memberTestOf(test.right, test.left)
    if (guard) guards.push({ ...guard, equal: strictEqual === holds })
  }
  const memberTestOf = (member: ts.Expression, other: ts.Expression): Omit<MemberGuard, 'equal'> | null => {
    let access = member
    while (ts.isParenthesizedExpression(access)) access = access.expression
    // `x?.m` reads nothing of an absent `x`, so it proves nothing about it.
    if (!ts.isPropertyAccessExpression(access) || access.questionDotToken || !ts.isIdentifier(access.expression)) return null
    if (checker.getSymbolAtLocation(access.expression) !== symbol) return null
    const literal = literalTypeOf(checker, other)
    return literal ? { name: access.name.text, literal, at: access } : null
  }
  let child: ts.Node = read
  for (let parent = read.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue) collect(parent.condition, true)
      else if (child === parent.whenFalse) collect(parent.condition, false)
    } else if (ts.isIfStatement(parent)) {
      if (child === parent.thenStatement) collect(parent.expression, true)
      else if (child === parent.elseStatement) collect(parent.expression, false)
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) collect(parent.left, true)
      else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) collect(parent.left, false)
    }
    if (parent === declaration.parent.parent.parent) break
  }
  return guards
}

/** The type of a literal operand of a strict equality, or `null` when the operand is not one. */
const literalTypeOf = (checker: ts.TypeChecker, operand: ts.Expression): ts.Type | null => {
  let literal = operand
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return checker.getTrueType()
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return checker.getFalseType()
  if (literal.kind === ts.SyntaxKind.NullKeyword) return checker.getNullType()
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return checker.getStringLiteralType(literal.text)
  if (ts.isNumericLiteral(literal)) {
    const value = Number(literal.text)
    return Number.isNaN(value) ? null : checker.getNumberLiteralType(value)
  }
  return null
}

/** The value a literal type spells, for comparing two of them; `undefined` for a type that spells no single value. */
const unitValueOf = (checker: ts.TypeChecker, type: ts.Type): { readonly value: unknown } | undefined => {
  if (type.flags & ts.TypeFlags.Null) return { value: null }
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { value: undefined }
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { value: type === checker.getTrueType() || checker.typeToString(type) === 'true' }
  if (type.isStringLiteral() || type.isNumberLiteral()) return { value: type.value }
  return undefined
}

/**
 * Whether a value of `member` may be strictly equal to `literal`. Only a
 * provable `false` drops an arm, so every form not modelled here answers
 * `true`.
 */
const mayEqual = (checker: ts.TypeChecker, member: ts.Type, literal: ts.Type): boolean => {
  const parts = member.isUnion() ? member.types : [member]
  const expected = unitValueOf(checker, literal)
  if (!expected) return true
  return parts.some((part) => {
    const unit = unitValueOf(checker, part)
    if (unit) return unit.value === expected.value
    const kind = typeof expected.value
    if (part.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) return kind === 'string'
    if (part.flags & (ts.TypeFlags.Number | ts.TypeFlags.Enum)) return kind === 'number'
    // An object is never strictly equal to a primitive; every literal here is one.
    if (part.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) return false
    if (part.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return false
    return true
  })
}

/** Whether every value of `member` is strictly equal to `literal`. */
const alwaysEquals = (checker: ts.TypeChecker, member: ts.Type, literal: ts.Type): boolean => {
  const expected = unitValueOf(checker, literal)
  if (!expected) return false
  const parts = member.isUnion() ? member.types : [member]
  return parts.every((part) => {
    const unit = unitValueOf(checker, part)
    return unit !== undefined && unit.value === expected.value
  })
}

/** Whether `arm` is `undefined` or `null`, which no member read reaches past. */
export const isNullishArm = (arm: ts.Type): boolean => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0

/**
 * Whether a value of `arm` can pass every guard. `null` from the member
 * question means the program states nothing about the member there, and the
 * arm is kept.
 */
export const armPassesMemberGuards = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  census: FamilyReceiverCensus | undefined,
  guards: readonly MemberGuard[],
  arm: ts.Type
): boolean => {
  if (guards.length === 0) return true
  if (isNullishArm(arm)) return false
  return guards.every((guard) => {
    const member =
      memberTypeOf(checker, arm, guard.name, guard.at, flow) ?? classFamilyMemberReadTypeOf(checker, flow, arm, guard.name, census, true)
    if (!member || (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
    return guard.equal ? mayEqual(checker, member, guard.literal) : !alwaysEquals(checker, member, guard.literal)
  })
}

/**
 * The arms of `arms` a read of `read` can hold under its member guards, or
 * `null` when the guards drop none -- or all, which is a branch no arm the
 * census knows reaches, and so no statement about the read at all.
 */
export const armsPassingMemberGuards = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  census: FamilyReceiverCensus | undefined,
  read: ts.Identifier,
  arms: readonly ts.Type[]
): readonly ts.Type[] | null => {
  const guards = memberGuardsOf(checker, read)
  if (guards.length === 0) return null
  const flat = arms.flatMap((arm) => (arm.isUnion() ? arm.types : [arm]))
  const kept = flat.filter((arm) => armPassesMemberGuards(checker, flow, census, guards, arm))
  return kept.length === 0 || kept.length === flat.length ? null : kept
}

/** `receiver`, a union held by the read `read`, less the arms its member guards exclude. */
export const receiverPassingMemberGuards = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  census: FamilyReceiverCensus | undefined,
  read: ts.Expression,
  receiver: ts.Type
): ts.Type => {
  if (!ts.isIdentifier(read) || !receiver.isUnion()) return receiver
  const kept = armsPassingMemberGuards(checker, flow, census, read, receiver.types)
  if (!kept) return receiver
  const [sole] = kept
  return kept.length === 1 && sole ? sole : (disjointUnionTypeOf(checker, kept) ?? receiver)
}
