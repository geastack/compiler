import ts from 'typescript'

/**
 * The generic source functions a value expression is a CHOICE among.
 *
 * `const setOriginal = flags & NoOriginalNode ? identity : setOriginalNode`
 * (TypeScript's `nodeFactory.ts`) holds one of two generic functions, decided
 * at runtime. The checker's declared type for the binding is NOT that choice:
 * `typeof identity` is a subtype of `typeof setOriginalNode` (fewer parameters,
 * an unconstrained `T`), so union subtype reduction leaves `typeof
 * setOriginalNode` alone, and every call through the binding resolves to
 * `setOriginalNode`'s own signature -- run as an exact call to it, the
 * program silently sets `original` on the branch that chose `identity`.
 *
 * The choice is a fact about the VALUE's flow, read here from the initializer's
 * own arms: a conditional, a `||`/`??`, parentheses and erasures, down to
 * names of module-level generic function declarations with a body (the same
 * predicate `structural.ts`'s `genericSourceFunctionOf` states for a single
 * member's type). A `const` with no annotation holds exactly its initializer,
 * so a name resolving to one is the same choice; anything else -- a `let`, an
 * annotation, a non-generic arm, a nested closure -- is not, and answers
 * `null`. Two or more DISTINCT members make a choice; one is the function.
 *
 * One rule, asked by every reader: `structural.ts` types the binding, its
 * reads and the choice expression itself as the union of the members' open
 * types (which derives to `generic-function-set`); `specialization.ts` mints
 * every member's copy at each call through it; `producers/invocations.ts`
 * publishes the `closed-family` target those copies form.
 */
export const genericFunctionChoiceMembersOf = (checker: ts.TypeChecker, node: ts.Node): readonly ts.FunctionDeclaration[] | null => {
  const leaves = leavesOf(checker, node, new Set())
  if (!leaves || leaves.length < 2) return null
  return leaves
}

/** The one member a name denotes, when it denotes a generic source function outright. */
export const genericSourceFunctionDeclarationOf = (declaration: ts.Declaration): ts.FunctionDeclaration | null => {
  if (!ts.isFunctionDeclaration(declaration)) return null
  const implementation = declaration.body === undefined ? implementationOf(declaration) : declaration
  if (!implementation || implementation.body === undefined) return null
  if ((implementation.typeParameters?.length ?? 0) === 0) return null
  if (implementation.getSourceFile().isDeclarationFile) return null
  if (!(ts.isSourceFile(implementation.parent) || ts.isModuleBlock(implementation.parent))) return null
  if (implementation.asteriskToken !== undefined || (ts.getCombinedModifierFlags(implementation) & ts.ModifierFlags.Async) !== 0)
    return null
  return implementation
}

const implementationOf = (declaration: ts.FunctionDeclaration): ts.FunctionDeclaration | null => {
  const symbol = declaration.name ? (declaration as ts.FunctionDeclaration & { symbol?: ts.Symbol }).symbol : undefined
  const candidates = symbol?.getDeclarations() ?? []
  return (
    candidates.find(
      (candidate): candidate is ts.FunctionDeclaration => ts.isFunctionDeclaration(candidate) && candidate.body !== undefined
    ) ?? null
  )
}

const unwrap = (node: ts.Node): ts.Node => {
  let current = node
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression
      continue
    }
    return current
  }
}

const leavesOf = (checker: ts.TypeChecker, node: ts.Node, seen: Set<ts.Node>): readonly ts.FunctionDeclaration[] | null => {
  const real = unwrap(node)
  if (seen.has(real)) return null
  seen.add(real)
  if (ts.isConditionalExpression(real)) return join(leavesOf(checker, real.whenTrue, seen), leavesOf(checker, real.whenFalse, seen))
  if (
    ts.isBinaryExpression(real) &&
    (real.operatorToken.kind === ts.SyntaxKind.BarBarToken || real.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return join(leavesOf(checker, real.left, seen), leavesOf(checker, real.right, seen))
  }
  if (ts.isVariableDeclaration(real)) {
    const list = real.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
    if (real.type !== undefined || real.initializer === undefined || !ts.isIdentifier(real.name)) return null
    return leavesOf(checker, real.initializer, seen)
  }
  if (ts.isIdentifier(real) && ts.isVariableDeclaration(real.parent) && real.parent.name === real)
    return leavesOf(checker, real.parent, seen)
  if (ts.isIdentifier(real) || ts.isPropertyAccessExpression(real)) {
    const symbol = checker.getSymbolAtLocation(ts.isIdentifier(real) ? real : real.name)
    if (!symbol) return null
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = resolved.valueDeclaration ?? resolved.getDeclarations()?.[0]
    if (!declaration) return null
    if (ts.isVariableDeclaration(declaration)) return leavesOf(checker, declaration, seen)
    const member = genericSourceFunctionDeclarationOf(declaration)
    return member ? [member] : null
  }
  return null
}

const join = (
  left: readonly ts.FunctionDeclaration[] | null,
  right: readonly ts.FunctionDeclaration[] | null
): readonly ts.FunctionDeclaration[] | null => {
  if (!left || !right) return null
  const members = [...left]
  for (const member of right) if (!members.includes(member)) members.push(member)
  return members
}
