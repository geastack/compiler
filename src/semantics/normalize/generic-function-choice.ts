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
  const destructured = { reached: false }
  const leaves = leavesOf(checker, node, new Set(), destructured)
  if (!leaves || leaves.length < (destructured.reached ? 1 : 2)) return null
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

const leavesOf = (
  checker: ts.TypeChecker,
  node: ts.Node,
  seen: Set<ts.Node>,
  destructured: { reached: boolean }
): readonly ts.FunctionDeclaration[] | null => {
  const real = unwrap(node)
  if (seen.has(real)) return null
  seen.add(real)
  if (ts.isConditionalExpression(real))
    return join(leavesOf(checker, real.whenTrue, seen, destructured), leavesOf(checker, real.whenFalse, seen, destructured))
  if (
    ts.isBinaryExpression(real) &&
    (real.operatorToken.kind === ts.SyntaxKind.BarBarToken || real.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return join(leavesOf(checker, real.left, seen, destructured), leavesOf(checker, real.right, seen, destructured))
  }
  if (ts.isVariableDeclaration(real)) {
    const list = real.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
    if (real.type !== undefined || real.initializer === undefined || !ts.isIdentifier(real.name)) return null
    return leavesOf(checker, real.initializer, seen, destructured)
  }
  // `const { addAbortSignal } = require('node:stream')` (light-my-request):
  // a `const` pattern leaf holding one member of what it destructures. Unlike
  // `const alias = f`, which forks with its target, a pattern leaf is one
  // cell written by the pattern -- so even ONE generic member is a choice
  // the cell holds as a tag, and each call through it runs that call's copy.
  if (ts.isBindingElement(real)) {
    const pattern = real.parent
    const holder = pattern.parent
    if (!ts.isObjectBindingPattern(pattern) || real.dotDotDotToken !== undefined || real.initializer !== undefined) return null
    if (!ts.isVariableDeclaration(holder) || holder.initializer === undefined) return null
    const list = holder.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null
    const key = real.propertyName ?? real.name
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return null
    const property = checker.getTypeAtLocation(holder.initializer).getProperty(key.text)
    if (!property) return null
    const resolved = property.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(property) : property
    const declaration = resolved.valueDeclaration ?? resolved.getDeclarations()?.[0]
    const member = declaration ? genericSourceFunctionDeclarationOf(declaration) : null
    if (!member) return null
    destructured.reached = true
    return [member]
  }
  if (ts.isIdentifier(real) && ts.isVariableDeclaration(real.parent) && real.parent.name === real)
    return leavesOf(checker, real.parent, seen, destructured)
  if (ts.isIdentifier(real) && ts.isBindingElement(real.parent) && real.parent.name === real)
    return leavesOf(checker, real.parent, seen, destructured)
  if (ts.isIdentifier(real) || ts.isPropertyAccessExpression(real)) {
    const symbol = checker.getSymbolAtLocation(ts.isIdentifier(real) ? real : real.name)
    if (!symbol) return null
    // A JavaScript `const { f } = require('m')` leaf is an ALIAS symbol to the
    // checker, which would resolve straight past the cell to the export.
    const own = symbol.declarations?.[0]
    if (own && ts.isBindingElement(own)) return leavesOf(checker, own, seen, destructured)
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = resolved.valueDeclaration ?? resolved.getDeclarations()?.[0]
    if (!declaration) return null
    if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) return leavesOf(checker, declaration, seen, destructured)
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
