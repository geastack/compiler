import ts from 'typescript'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * A record handed to a union-typed parameter through an explicit
 * `value as unknown as T` assertion, kept as one more native arm of that union.
 *
 * A server adapter that builds
 *
 *   const env: ExtraBindings = { incoming: request, outgoing: undefined, extra, [WAIT_SYMBOL]: wait }
 *   await callback(makeRequest(request), env as unknown as Parameters<Callback>[1])
 *
 * where the parameter is `BindingsA | BindingsB`. The assertion emits
 * nothing in JavaScript: the callee receives `env` itself, and the program
 * depends on that identity -- a helper reads `c.env as ExtraBindings`,
 * writes `env[CONNECTION_KEY]`, and the upgrade handler reads it back
 * off the very object it built. A converting copy would lose that write, and
 * a box would be a dynamic carrier for a statically typed record.
 *
 * So the union carries the asserted record's own carrier beside its declared
 * arms. Keyed by the union TYPE, as `record-stand-in-arms.ts` keys its arms,
 * because the parameter here belongs to a callable TYPE (`Callback`):
 * every function value stored into that slot, and the call through it, must
 * agree on one carrier, and the union type is the one thing they share.
 * Adding an arm is a superset -- every value already admitted converts as
 * before -- and a read of a member the record lacks answers through the
 * record's own arm or refuses, never reinterprets one layout as another.
 *
 * Sound only where no narrowing can route the extra arm somewhere the checker
 * says no value goes: any test on a value of the union that can tell its arms
 * apart -- `instanceof`, `in`, `typeof`, a discriminant member, or a member the
 * record lacks -- withdraws the arm, and the certification refusal stands.
 */
export interface AssertedArgumentArmCensus {
  /** The asserted records a union type carries beside its declared arms, or `null`. */
  readonly armsOf: (union: ts.Type) => readonly ts.Type[] | null
}

export const emptyAssertedArgumentArmCensus: AssertedArgumentArmCensus = { armsOf: () => null }

const presentMembersOf = (type: ts.Type): readonly ts.Type[] =>
  (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)

const containsTypeParameter = (checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean => {
  if (depth > 4) return true
  if (type.flags & ts.TypeFlags.TypeParameter) return true
  if (type.isUnionOrIntersection()) return type.types.some((member) => containsTypeParameter(checker, member, depth + 1))
  if ((type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0)
    return checker.getTypeArguments(type as ts.TypeReference).some((argument) => containsTypeParameter(checker, argument, depth + 1))
  return false
}

const unwrapParens = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node)

/**
 * A plain record: an object type with no call or construct signature that is
 * not a class instance, an array, or a tuple. A class arm is nominal, so a
 * record beside it would be a second layout the class's methods never see.
 */
const isPlainRecord = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  (type.flags & ts.TypeFlags.Object) !== 0 &&
  ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) === 0 &&
  type.getCallSignatures().length === 0 &&
  type.getConstructSignatures().length === 0 &&
  !checker.isArrayType(type) &&
  !checker.isTupleType(type)

/** Whether a narrowing condition reads `node` -- the walk `record-stand-in-arms.ts` states. */
const narrows = (node: ts.Node): boolean => {
  let current = node
  for (;;) {
    const parent = current.parent
    if (!parent) return false
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isTypeOfExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === current) ||
      (ts.isElementAccessExpression(parent) && parent.expression === current)
    ) {
      current = parent
      continue
    }
    if (ts.isBinaryExpression(parent)) {
      switch (parent.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
        case ts.SyntaxKind.InstanceOfKeyword:
        case ts.SyntaxKind.InKeyword:
          current = parent
          continue
        default:
          return false
      }
    }
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === current
    if (ts.isForStatement(parent)) return parent.condition === current
    if (ts.isConditionalExpression(parent)) return parent.condition === current
    if (ts.isSwitchStatement(parent)) return parent.expression === current
    if (ts.isCaseClause(parent)) return parent.expression === current
    return false
  }
}

interface Seed {
  readonly union: ts.Type
  readonly record: ts.Type
}

export const censusAssertedArgumentArms = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability
): AssertedArgumentArmCensus => {
  /** The seed one call argument states, when it is `record as unknown as Union` landing where the union is the parameter. */
  const seedOf = (argument: ts.Expression): Seed | null => {
    const outer = unwrapParens(argument)
    if (!ts.isAsExpression(outer) && !ts.isTypeAssertionExpression(outer)) return null
    const inner = unwrapParens(outer.expression)
    if (!ts.isAsExpression(inner) && !ts.isTypeAssertionExpression(inner)) return null
    if ((checker.getTypeFromTypeNode(inner.type).flags & ts.TypeFlags.Unknown) === 0) return null
    const union = checker.getTypeFromTypeNode(outer.type)
    const record = checker.getTypeAtLocation(unwrapParens(inner.expression))
    if (!union.isUnion() || containsTypeParameter(checker, union) || containsTypeParameter(checker, record)) return null
    const homes = presentMembersOf(union)
    if (homes.length < 2 || !homes.every((home) => isPlainRecord(checker, home))) return null
    if (!isPlainRecord(checker, record) || homes.includes(record) || checker.isTypeAssignableTo(record, union)) return null
    return { union, record }
  }

  const seeds: Seed[] = []
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node)) return
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const argumentsList = node.arguments ?? []
        const signature = checker.getResolvedSignature(node)
        argumentsList.forEach((argument, index) => {
          if (argumentsList.slice(0, index + 1).some(ts.isSpreadElement)) return
          const seed = seedOf(argument)
          const parameter = signature?.getParameters()[index]
          if (!seed || !parameter || checker.getTypeOfSymbol(parameter) !== seed.union) return
          seeds.push(seed)
        })
      }
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }
  if (seeds.length === 0) return emptyAssertedArgumentArmCensus

  const records = new Map<ts.Type, ts.Type[]>()
  for (const seed of seeds) {
    const held = records.get(seed.union)
    if (!held) records.set(seed.union, [seed.record])
    else if (!held.includes(seed.record)) held.push(seed.record)
  }

  /**
   * Whether a narrowing test on a value of `union` can tell its arms apart.
   * Truthiness and nullishness of the value itself cannot -- every arm is an
   * object -- and neither can a member every arm states with a non-unit type.
   */
  const discriminates = (use: ts.Node, union: ts.Type): boolean => {
    const parent = use.parent
    if (!parent) return true
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      const key = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isStringLiteralLike(parent.argumentExpression)
          ? parent.argumentExpression.text
          : null
      if (key === null) return true
      return [...presentMembersOf(union), ...(records.get(union) ?? [])].some((arm) => {
        const property = arm.getProperty(key)
        return !property || (checker.getTypeOfSymbol(property).flags & ts.TypeFlags.Unit) !== 0
      })
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      return operator === ts.SyntaxKind.InstanceOfKeyword || operator === ts.SyntaxKind.InKeyword
    }
    return ts.isTypeOfExpression(parent)
  }

  const withdrawn = new Set<ts.Type>()
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node) || ts.isTypeNode(node)) return
      if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && narrows(node)) {
        const type = checker.getTypeAtLocation(node)
        if (records.has(type) && discriminates(node, type)) withdrawn.add(type)
      }
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }
  for (const union of withdrawn) records.delete(union)
  if (process.env['GEA_BINDING_DEBUG'])
    for (const seed of seeds)
      console.error(
        `[ASSERTED-ARGUMENT-ARM] ${checker.typeToString(seed.record)} into ${checker.typeToString(seed.union)}${
          withdrawn.has(seed.union) ? ' :: withdrawn' : ''
        }`
      )
  if (records.size === 0) return emptyAssertedArgumentArmCensus
  return { armsOf: (union) => records.get(union) ?? null }
}
