import ts from 'typescript'

/**
 * Whether a value expression hands over an object NO OTHER REFERENCE can ever
 * observe again -- either a FRESH expression (an allocation written right
 * there) or a `const` local initialized with one, whose every other reference
 * is an admitted non-escaping use that runs before this one, so this use is
 * its last.
 *
 * This is the one fact that makes converting a mutable object between two
 * carriers sound. Such a conversion must allocate, and a second object loses
 * every write made through the other alias; a value with no other alias can
 * be copied once at the consumer and the copy is indistinguishable from the
 * program having built it at the consumer's carrier in the first place.
 *
 * The proof is deliberately syntactic and small, like
 * `unshared-array-result.ts`, and is parameterized by the object kind
 * (`FreshValueKind`): what counts as a fresh allocation, and which uses of
 * the local are non-escaping. Each refusal only keeps the conversion refused:
 *  - any reference after the use, or the use inside a loop the declaration is
 *    outside of (a later iteration would read the object the copy left
 *    behind);
 *  - any reference from another function (a closure could run later);
 *  - any reference the kind does not admit (passing it, storing it elsewhere,
 *    aliasing it, ...);
 *  - a declaration that is not a single-name `const` with a fresh initializer.
 */
export interface FreshValueKind {
  /** The initializer (or the value itself) is an allocation nothing else holds. */
  readonly isFresh: (expression: ts.Expression) => boolean
  /** A reference to the local that hands no reference to it anywhere. */
  readonly admitsUse: (use: ts.Identifier) => boolean
}

/**
 * `value` is fresh, or names a `const` local whose last use it is. The caller
 * states that `value` itself is consumed only by the conversion being proved
 * (its own context check, e.g. `isUnsharedFreshTableStore`'s).
 */
export const isFreshOrLastUseOfFreshLocal = (checker: ts.TypeChecker, value: ts.Expression, kind: FreshValueKind): boolean => {
  const expression = skipParentheses(value)
  if (kind.isFresh(expression)) return true
  if (!ts.isIdentifier(expression)) return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  const initializer = declaration.initializer && skipParentheses(declaration.initializer)
  if (!initializer || !kind.isFresh(initializer)) return false
  const body = enclosingFunctionOrFile(declaration)
  if (enclosingFunctionOrFile(expression) !== body) return false
  // A top-level binding other code can name after the "last" use: an exported
  // one (another module imports it), or any in a classic script (its global
  // lexical scope is shared with every later script).
  if (ts.isSourceFile(body) && !moduleLocal(body, list, symbol, checker)) return false
  if (crossesLoop(expression, declaration)) return false
  let admitted = true
  const visit = (node: ts.Node): void => {
    if (!admitted) return
    if (ts.isIdentifier(node) && node !== declaration.name && node !== expression && checker.getSymbolAtLocation(node) === symbol) {
      admitted = enclosingFunctionOrFile(node) === body && node.getEnd() <= expression.getStart() && kind.admitsUse(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return admitted
}

/** An open table: a plain object literal (no spreads, accessors, methods or computed keys), used only as a keyed receiver. */
export const freshTableKind: FreshValueKind = {
  isFresh: (expression) =>
    ts.isObjectLiteralExpression(expression) &&
    expression.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) &&
          property.name.text !== '__proto__') ||
        (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer)
    ),
  admitsUse: (use) => keyedReceiverUse(use)
}

/**
 * Whether `value` -- the right-hand side of the plain store `receiver.key =
 * value` -- hands over a fresh open table as its last use
 * (`SemanticOperand.unsharedFreshTable`). Three's OutputPass builds `const
 * defines: { [name: string]: string } = {}`, fills it, and stores it into
 * `material.defines`, a table three itself reads and writes as `any` values.
 * The store's own value must not be consumed (`x = (o.k = defines)` would be
 * a second alias), so only an expression-statement `=` qualifies.
 */
export const isUnsharedFreshTableStore = (checker: ts.TypeChecker, value: ts.Expression): boolean => {
  const assignment = value.parent
  if (!ts.isBinaryExpression(assignment) || assignment.right !== value) return false
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  if (!ts.isPropertyAccessExpression(assignment.left) && !ts.isElementAccessExpression(assignment.left)) return false
  if (!ts.isExpressionStatement(assignment.parent)) return false
  // Only the local form: a literal stored directly already takes the slot's
  // carrier from its own allocation.
  return ts.isIdentifier(value) && isFreshOrLastUseOfFreshLocal(checker, value, freshTableKind)
}

/** `t.k`, `t[k]`, as a read, a store target, or a `delete` operand -- never a callee. */
export const keyedReceiverUse = (use: ts.Identifier): boolean => {
  const parent = use.parent
  const access =
    (ts.isPropertyAccessExpression(parent) && parent.expression === use && !ts.isPrivateIdentifier(parent.name)) ||
    (ts.isElementAccessExpression(parent) && parent.expression === use)
  if (!access || parent.questionDotToken !== undefined) return false
  const outer = parent.parent
  return !(ts.isCallExpression(outer) && outer.expression === parent) && !(ts.isTaggedTemplateExpression(outer) && outer.tag === parent)
}

/** A module-scope binding no other module or script can reach: the file is a module, and nothing exports the binding. */
const moduleLocal = (file: ts.SourceFile, list: ts.VariableDeclarationList, symbol: ts.Symbol, checker: ts.TypeChecker): boolean => {
  if (!ts.isExternalModule(file)) return false
  const statement = list.parent
  if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return false
  const exported = (node: ts.Node): boolean => {
    if (ts.isExportSpecifier(node)) {
      const local = node.propertyName ?? node.name
      const target = ts.isIdentifier(local) ? checker.getExportSpecifierLocalTargetSymbol(node) : undefined
      return target === symbol || (ts.isIdentifier(local) && local.text === symbol.name && node.parent.parent.moduleSpecifier === undefined)
    }
    if (ts.isExportAssignment(node)) {
      const value = skipParentheses(node.expression)
      return !ts.isIdentifier(value) || checker.getSymbolAtLocation(value) === symbol
    }
    return ts.forEachChild(node, exported) === true
  }
  return !file.statements.some(
    (statement) => (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) && exported(statement)
  )
}

/** A loop between the use and the declaration repeats the use over the one object. */
const crossesLoop = (use: ts.Node, declaration: ts.Node): boolean => {
  for (let current = use.parent; current; current = current.parent) {
    // The innermost node enclosing both: any loop above it holds the
    // declaration too, so each iteration declares a fresh object.
    if (current.pos <= declaration.pos && declaration.end <= current.end) return false
    if (ts.isIterationStatement(current, false) || ts.isFunctionLike(current)) return true
  }
  return true
}

const enclosingFunctionOrFile = (node: ts.Node): ts.Node => {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current) && !ts.isClassStaticBlockDeclaration(current))
    current = current.parent
  return current ?? node.getSourceFile()
}

const skipParentheses = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ? skipParentheses(node.expression)
    : node
