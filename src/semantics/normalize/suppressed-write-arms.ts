import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { forEachReachableStatement, type ProgramReachability } from './reachability.js'

/**
 * A value a SUPPRESSED type error stores into a typed member slot, kept as
 * one more native arm of that slot instead of being converted or refused.
 *
 * A function that writes
 *
 *   // @ts-expect-error
 *   const commandOptions: CommandOptions = { ...options, raw: false }
 *
 * where the spread copies `session?: Buffer` from `ConnectionOptions` into
 * `CommandOptions.session?: Session`. The checker was told to look away,
 * so nothing it says about that slot covers the Buffer. What node does with it
 * is precise: a later call hands `options.session` to
 * `update(session: Session, ...)`, which ignores it on one path and throws a
 * TypeError at `session.supports.feature` on another. A
 * checked copy throwing at the spread would diverge on the first; a box would
 * be a dynamic carrier for a statically typed value.
 *
 * The slot's carrier is therefore the tagged union of what its writers store
 * -- `Session | Buffer | undefined` -- and every place the value
 * provably flows carries the extra arm: the member slot itself, every read of
 * it, each `??`/`||`/`&&`/`?:` merge that keeps it, and the locals and
 * parameters it is handed to, with their reads. Keyed by member and by node,
 * NEVER by the union type: `Session | undefined` is one checker type
 * for every such slot in the program, and widening all of them sent the arm
 * into merges (`operation.session ??= session`) it never reaches. A member
 * read off the union answers `undefined` on the arm that lacks it, so the
 * chained read throws the TypeError node throws, where node throws it.
 *
 * Sound only where the program cannot route the extra arm somewhere the
 * checker's narrowing says it cannot go. Anything the census cannot follow --
 * a value stored into a container, returned, destructured, handed to a
 * callable whose cell other bodies share, or narrowed by a test that can tell
 * the arms apart -- withdraws the arm, and the certification refusal stands.
 */
export interface SuppressedWriteArmCensus {
  /** The foreign arms the seeded member slot holds beside its declared type, or `null`. */
  readonly armsOfMember: (member: ts.Symbol) => readonly ts.Type[] | null
  /** The foreign arms a node the value provably reaches carries beside its checker type -- a read, a merge, a followed local or parameter. */
  readonly armsAt: (node: ts.Node) => readonly ts.Type[] | null
}

export const emptySuppressedWriteArmCensus: SuppressedWriteArmCensus = { armsOfMember: () => null, armsAt: () => null }

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

const functionOwning = (node: ts.Node): ts.SignatureDeclaration | null => {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  return current ?? null
}

/** A callable whose parameter cells no other body shares -- the line `record-stand-in-arms.ts` draws. */
const isClosedCallable = (declaration: ts.SignatureDeclaration): boolean =>
  ((ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) &&
    declaration.body !== undefined) ||
  (ts.isMethodDeclaration(declaration) &&
    declaration.body !== undefined &&
    (ts.isPrivateIdentifier(declaration.name) || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private) !== 0))

const skipTransparent = (node: ts.Node): ts.Node => {
  let current = node
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent
  return current
}

const skipParentheses = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? skipParentheses(expression.expression) : expression

/** Whether a `@ts-expect-error` or `@ts-ignore` directive covers the statement. */
const isSuppressed = (statement: ts.Node): boolean => {
  const file = statement.getSourceFile()
  return (ts.getLeadingCommentRanges(file.text, statement.pos) ?? []).some((range) =>
    /@ts-(expect-error|ignore)\b/.test(file.text.slice(range.pos, range.end))
  )
}

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
    const returned = ts.isReturnStatement(parent)
      ? functionOwning(parent)
      : ts.isArrowFunction(parent) && parent.body === current
        ? parent
        : null
    if (returned) return returned.type !== undefined && ts.isTypePredicateNode(returned.type)
    return false
  }
}

interface Seed {
  /** The member slot the suppressed write lands in. */
  readonly member: ts.Symbol
  /** The declared type's present arms: what the checker believes every read holds. */
  readonly homes: readonly ts.Type[]
  /** What the suppressed write stores that no home admits. */
  readonly foreign: readonly ts.Type[]
}

export const censusSuppressedWriteArms = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  valueFlow: ValueFlowIndex
): SuppressedWriteArmCensus => {
  /** The parameter a call argument lands in, or `null` when it is not one plain declared parameter. */
  const parameterOfArgument = (call: ts.CallExpression | ts.NewExpression, argument: ts.Expression): ts.ParameterDeclaration | null => {
    const argumentsList: readonly ts.Expression[] = call.arguments ?? []
    const index = argumentsList.indexOf(argument)
    if (index < 0 || argumentsList.slice(0, index + 1).some(ts.isSpreadElement)) return null
    const declaration = checker.getResolvedSignature(call)?.getParameters()[index]?.valueDeclaration
    return declaration && ts.isParameter(declaration) && !declaration.dotDotDotToken ? declaration : null
  }

  /**
   * The seeds one suppressed declaration states: every key a spread copies
   * into the declared type where the copied type is not assignable to the
   * slot's. A key the literal writes again after the spread is the later
   * write's, not the spread's.
   */
  const seedsOf = (declaration: ts.VariableDeclaration): Seed[] => {
    if (!declaration.type || !declaration.initializer || !ts.isIdentifier(declaration.name)) return []
    const literal = skipParentheses(declaration.initializer)
    if (!ts.isObjectLiteralExpression(literal) || !literal.properties.some(ts.isSpreadAssignment)) return []
    if (!isSuppressed(declaration.parent.parent)) return []
    const declaredType = checker.getTypeFromTypeNode(declaration.type)
    const seeds: Seed[] = []
    literal.properties.forEach((property, index) => {
      if (!ts.isSpreadAssignment(property)) return
      const rewritten = new Set(
        literal.properties
          .slice(index + 1)
          .flatMap((later) =>
            (ts.isPropertyAssignment(later) || ts.isShorthandPropertyAssignment(later)) && ts.isIdentifier(later.name)
              ? [later.name.text]
              : []
          )
      )
      const source = checker.getTypeAtLocation(property.expression)
      for (const copied of checker.getPropertiesOfType(source)) {
        const key = copied.getName()
        if (rewritten.has(key)) continue
        const member = declaredType.getProperty(key)
        if (!member) continue
        const slot = checker.getTypeOfSymbol(member)
        const written = checker.getTypeOfSymbolAtLocation(copied, property.expression)
        const foreign = presentMembersOf(written).filter((arm) => !checker.isTypeAssignableTo(arm, slot))
        if (foreign.length === 0) continue
        if (!slot.isUnion() || foreign.some((arm) => containsTypeParameter(checker, arm)) || containsTypeParameter(checker, slot)) continue
        seeds.push({ member, homes: presentMembersOf(slot), foreign })
      }
    })
    return seeds
  }

  /** The reads of a member slot anywhere in the reachable program; `null` when one cannot be followed. */
  const readsOfMember = (member: ts.Symbol): ts.Expression[] | null => {
    const reads: ts.Expression[] = []
    for (const access of valueFlow.propertyAccesses) {
      const named = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression
      if (checker.getSymbolAtLocation(named) !== member) continue
      const at = skipTransparent(access)
      const parent = at.parent
      // A write INTO the slot stores a home value; only what is read out flows.
      if (parent && ts.isBinaryExpression(parent) && parent.left === at && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) continue
      reads.push(access)
    }
    for (const element of valueFlow.bindingPatternReads) {
      const name = element.propertyName ?? element.name
      if (ts.isIdentifier(name) && ts.getNameOfDeclaration(element) && checker.getSymbolAtLocation(name) === member) return null
    }
    return reads
  }

  const follow = (seed: Seed): ReadonlySet<ts.Node> | null => {
    const nodes = new Set<ts.Node>()
    const cells = new Map<ts.Symbol, ts.Node>()
    const pending: ts.Symbol[] = []
    let poisoned = false
    const poison = (): void => {
      poisoned = true
    }
    const addCell = (symbol: ts.Symbol, scope: ts.Node, declaration: ts.Node): void => {
      nodes.add(declaration)
      if (cells.has(symbol)) return
      cells.set(symbol, scope)
      pending.push(symbol)
    }
    const hasHome = (type: ts.Type): boolean => presentMembersOf(type).some((member) => seed.homes.includes(member))
    /**
     * Whether the value is live at a node the checker types this way -- one of
     * the slot's homes survives there -- recording the node as one more place
     * the foreign arm reaches. A node whose type names no home is one the
     * checker's narrowing proved the value never reaches as a home.
     */
    const carries = (type: ts.Type, node: ts.Node | null): boolean => {
      if (!hasHome(type)) return false
      if (node !== null) nodes.add(node)
      return true
    }
    /**
     * A narrowing test that can tell the arms apart would route the foreign
     * value where the checker's narrowing says no value goes: `instanceof`,
     * `in`, `typeof`, or a discriminant member. A plain truthiness or
     * nullishness test treats the foreign arm exactly as a present home.
     */
    const observe = (use: ts.Node, key: string | null, carried: ts.Type): void => {
      if (!narrows(use)) return
      if (key === null) {
        poison()
        return
      }
      for (const arm of presentMembersOf(carried)) {
        const property = arm.getProperty(key)
        if (property && (checker.getTypeOfSymbol(property).flags & ts.TypeFlags.Unit) !== 0) poison()
      }
    }
    const track = (expression: ts.Expression): void => {
      if (poisoned) return
      const carried = checker.getTypeAtLocation(expression)
      if (!carries(carried, expression)) return
      const at = skipTransparent(expression)
      const parent = at.parent
      if (!parent) return
      if (ts.isNonNullExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
        track(parent)
        return
      }
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== at) {
        const declaration = parameterOfArgument(parent, at as ts.Expression)
        const owner = declaration?.parent
        const symbol = declaration && ts.isIdentifier(declaration.name) ? checker.getSymbolAtLocation(declaration.name) : undefined
        if (!declaration || !owner || !symbol || !isClosedCallable(owner)) {
          poison()
          return
        }
        const slot = checker.getTypeAtLocation(declaration)
        if (containsTypeParameter(checker, slot) || !carries(slot, declaration)) {
          poison()
          return
        }
        addCell(symbol, owner, declaration)
        return
      }
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === at) {
        const key = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : ts.isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : null
        observe(parent, key, carried)
        return
      }
      if (ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind
        if (operator === ts.SyntaxKind.InstanceOfKeyword || operator === ts.SyntaxKind.InKeyword) {
          if (narrows(parent)) poison()
          return
        }
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.QuestionQuestionToken ||
          (operator === ts.SyntaxKind.CommaToken && parent.right === at)
        ) {
          // The merge's result is the value itself on the side that keeps it,
          // so the merge carries the arm wherever its own result goes.
          track(parent)
          return
        }
        // `a ??= v` stores into `a` and yields it: a second cell and a result
        // this walk does not follow.
        if (
          operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          operator === ts.SyntaxKind.BarBarEqualsToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        ) {
          poison()
          return
        }
        if (operator === ts.SyntaxKind.EqualsToken) {
          if (parent.left === at) return
          const target = checker.getSymbolAtLocation(parent.left)
          const declaration = target?.valueDeclaration
          if (!ts.isIdentifier(parent.left) || !target || !declaration || !ts.isVariableDeclaration(declaration)) {
            poison()
            return
          }
          if (!carries(checker.getTypeOfSymbol(target), null)) return
          addCell(target, functionOwning(declaration) ?? declaration.getSourceFile(), declaration)
          return
        }
        // Comparison and arithmetic observe the value; they do not carry it.
        return
      }
      if (ts.isTypeOfExpression(parent)) {
        if (narrows(parent)) poison()
        return
      }
      if (ts.isConditionalExpression(parent)) {
        if (parent.condition !== at) track(parent)
        return
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === at) {
        const symbol = ts.isIdentifier(parent.name) ? checker.getSymbolAtLocation(parent.name) : undefined
        if (!symbol || !carries(checker.getTypeOfSymbol(symbol), null)) {
          poison()
          return
        }
        addCell(symbol, functionOwning(parent) ?? parent.getSourceFile(), parent)
        return
      }
      if (
        ts.isTemplateSpan(parent) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isExpressionStatement(parent) ||
        ts.isIfStatement(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent) ||
        ts.isSwitchStatement(parent) ||
        ts.isCaseClause(parent)
      )
        return
      poison()
    }
    const reads = readsOfMember(seed.member)
    if (reads === null) return null
    for (const read of reads) track(read)
    while (pending.length > 0 && !poisoned) {
      const symbol = pending.pop()!
      const scope = cells.get(symbol)!
      const visit = (node: ts.Node): void => {
        if (poisoned) return
        if (ts.isTypeNode(node)) return
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
          const parent = node.parent
          const declares = (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node
          const written = ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          if (!declares && !written) {
            if (ts.isShorthandPropertyAssignment(parent)) poison()
            else track(node)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(scope)
    }
    return poisoned ? null : nodes
  }

  const memberArms = new Map<ts.Symbol, ts.Type[]>()
  const nodeArms = new Map<ts.Node, ts.Type[]>()
  const add = <Key>(table: Map<Key, ts.Type[]>, key: Key, arm: ts.Type): void => {
    const held = table.get(key)
    if (!held) table.set(key, [arm])
    else if (!held.includes(arm)) held.push(arm)
  }
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (reachable.memberIsPruned(node)) return
      if (ts.isVariableDeclaration(node)) {
        for (const seed of seedsOf(node)) {
          const followed = follow(seed)
          if (!followed) continue
          for (const arm of seed.foreign) add(memberArms, seed.member, arm)
          for (const node of followed) for (const arm of seed.foreign) add(nodeArms, node, arm)
        }
      }
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }
  if (memberArms.size === 0 && nodeArms.size === 0) return emptySuppressedWriteArmCensus
  return {
    armsOfMember: (member) => memberArms.get(member) ?? null,
    armsAt: (node) => nodeArms.get(node) ?? null
  }
}
