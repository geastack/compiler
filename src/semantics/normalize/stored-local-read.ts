import ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'

/**
 * Whether this read of an unannotated local sees the cell as it is STORED,
 * not as the checker typed it.
 *
 * The checker keeps a `let`'s declared type at a read when a later write is
 * not assignable to it. That is not a narrowing: the checker ignored the
 * write. three's WebGLAttributeUtils.createAttribute writes
 * `let attributeData = { ... }`, then under a guard
 * `attributeData = new DualAttributeData( attributeData, dual )`, then reads
 * `backend.set( attribute, attributeData )`. The checker says the record at
 * that read, while the value may be the DualAttributeData.
 *
 * A read the checker did not narrow (its type there IS the declared type),
 * placed after every whole-cell write, may see any of them, so it reads the
 * census's stored union. The stored union is always a sound answer; the order
 * only keeps precision. Which writes a read BEFORE a write sees (the
 * `attributeData` passed to `new DualAttributeData`, which sees only the
 * initializer) is `valuesReachingRead`'s question, below.
 *
 * The one authority for this rule. Asked where the read's layout is decided
 * (`structural-local-union.ts`) and where a parameter census takes the type
 * of an argument (`parameter-bindings.ts`), so both see the same value. The
 * caller checks that its census holds a synthesized union for the cell.
 */
export const readFollowsEveryWrite = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  declaration: ts.VariableDeclaration,
  read: ts.Identifier
): boolean => {
  if (declaration.type || !ts.isIdentifier(declaration.name) || read === declaration.name) return false
  if (checker.getTypeAtLocation(read) !== checker.getTypeAtLocation(declaration.name)) return false
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  return writes.length > 0 && writes.every((write) => write.value !== null && write.value.end <= read.pos)
}

/** The value may be `null`. */
export const NULL_KIND = 1
/** The value may be `undefined`. */
export const UNDEFINED_KIND = 2
/** The value may be something other than `null`/`undefined`. */
export const PRESENT_KIND = 4
export const ALL_KINDS = NULL_KIND | UNDEFINED_KIND | PRESENT_KIND

/**
 * One value that can reach a read, with the absence kinds the guards on the
 * way still allow for it.
 *
 * `source` is the whole write's value expression; for an uninitialized
 * `let x` it is the declaration (the cell holds `undefined`); for a field it
 * is `null` on entry to the function (whatever the field holds then).
 */
export interface ReachingValue {
  readonly source: ts.Expression | ts.VariableDeclaration | null
  readonly kinds: number
}

/**
 * Whether the checker left this read OPEN: it typed it `any`, or with the
 * declared type of what it names. Only such a read takes `valuesReachingRead`;
 * a read the checker narrowed keeps the checker's own narrowing.
 */
export const checkerLeftReadOpen = (checker: ts.TypeChecker, read: ts.Expression): boolean => {
  const type = checker.getTypeAtLocation(read)
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true
  if (ts.isIdentifier(read)) {
    const declaration = soleVariableDeclarationOf(checker, read)
    return declaration !== null && ts.isIdentifier(declaration.name) && checker.getTypeAtLocation(declaration.name) === type
  }
  if (ts.isPropertyAccessExpression(read)) {
    const symbol = checker.getSymbolAtLocation(read.name)
    return symbol !== undefined && checker.getTypeOfSymbol(symbol) === type
  }
  return false
}

const soleVariableDeclarationOf = (checker: ts.TypeChecker, read: ts.Identifier): ts.VariableDeclaration | null => {
  const declarations = checker.getSymbolAtLocation(read)?.declarations
  const declaration = declarations?.length === 1 ? declarations[0] : undefined
  return declaration && ts.isVariableDeclaration(declaration) ? declaration : null
}

/** What a reference names: a local cell, or `this.<name>` inside one non-arrow function body. */
type Reference =
  | { readonly kind: 'local'; readonly symbol: ts.Symbol; readonly declaration: ts.VariableDeclaration; readonly container: ts.Node }
  | { readonly kind: 'field'; readonly name: string; readonly container: ts.Node }

/** The walk met a write it does not follow; the answer is "cannot decide". */
class Undecided extends Error {}
const undecided = (): never => {
  throw new Undecided()
}

type Source = ReachingValue['source']
type State = ReadonlyMap<Source, number>

const EMPTY: State = new Map()

const join = (left: State, right: State): State => {
  if (left.size === 0) return right
  if (right.size === 0) return left
  const joined = new Map(left)
  for (const [source, kinds] of right) joined.set(source, (joined.get(source) ?? 0) | kinds)
  return joined
}

const restrict = (state: State, mask: number): State => {
  const kept = new Map<Source, number>()
  for (const [source, kinds] of state) if ((kinds & mask) !== 0) kept.set(source, kinds & mask)
  return kept
}

/** The nearest function-like node, class static block or source file around a node. */
const containerOf = (node: ts.Node): ts.Node => {
  let current = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isClassStaticBlockDeclaration(current) && !ts.isSourceFile(current)) {
    current = current.parent
  }
  return current ?? node.getSourceFile()
}

const unwrapParens = (node: ts.Expression): ts.Expression => {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

const contains = (outer: ts.Node, inner: ts.Node): boolean => inner.pos >= outer.pos && inner.end <= outer.end && outer !== inner

const isAssignmentOperator = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/**
 * The values that can reach this read of a local or of a `this` field.
 *
 * A forward walk over the one function body that holds the read, in source
 * order. A statement-level `ref = e`, or the local's own initializer,
 * replaces every value with that write. An `if` narrows each branch by its
 * condition (`=== / !== / == / !=` against `null` or `undefined`,
 * `typeof ref === 'undefined'`, truthiness, `!`, `&&`, `||`) and joins the
 * branches; `return`, `throw`, `break` and `continue` end a path. A statement
 * that writes the reference in any other way -- inside a loop, a `switch`, a
 * `try`, a nested function, a compound or destructuring assignment -- makes
 * the answer `null`: the caller keeps its own answer. A statement that does
 * not write the reference keeps the values (the set it keeps is a superset of
 * what really arrives, so a loop or a `switch` with no write is sound).
 *
 * three's three shapes, all read by the checker as `any` or as the declared
 * type, so no checker narrowing removes the arm:
 * - WebGLState.drawBuffers: `drawBuffers = map.get( fb )`, then
 *   `if ( drawBuffers === undefined ) drawBuffers = []`: the `.get()` arrives
 *   without `undefined`, so `gl.drawBuffers( drawBuffers )` reads no absence.
 * - Renderer._createObjectPipeline: `if ( this._compilationPromises !== null )
 *   { ...; return }`: after it the field is `null`.
 * - WebGLAttributeUtils.createAttribute: the `attributeData` passed to
 *   `new DualAttributeData( attributeData, ... )` sees only the initializer.
 *
 * A local's writes must all be in the function that declares it, and the
 * read too; otherwise a closure may write the cell at any call, and the
 * answer is `null`. A field follows the checker's own rule for narrowing a
 * `this.x` reference, where a call does not reset the narrowing -- the rule
 * the compiler already takes when the checker narrows a stated field; a
 * write of `this.x` inside a nested function of the body still makes the
 * answer `null`.
 *
 * The one authority for which values reach a read; `readFollowsEveryWrite`
 * above is its special case "every write reaches". Asked by
 * `structural-local-union.ts` (a synthesized-union local takes the reaching
 * writes' arms) and by the structural read path (`absenceKindsReachingRead`,
 * a read drops the absence arms no reaching value holds).
 */
export const valuesReachingRead = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex | undefined,
  read: ts.Expression
): readonly ReachingValue[] | null => {
  const reference = referenceOf(checker, flow, read)
  if (!reference) return null
  const isReference = (node: ts.Node): boolean => {
    if (reference.kind === 'local') {
      return ts.isIdentifier(node) && node.text === reference.symbol.name && checker.getSymbolAtLocation(node) === reference.symbol
    }
    return (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === reference.name &&
      thisOwnerOf(node) === reference.container
    )
  }
  if (writeFormOf(read) !== 'none') return null
  const writes = new Map<ts.Node, boolean>()
  /** Whether a subtree writes the reference at all (nested functions included). */
  const containsWrite = (node: ts.Node): boolean => {
    const known = writes.get(node)
    if (known !== undefined) return known
    let found = false
    const visit = (child: ts.Node): void => {
      if (found) return
      if (isReference(child) && writeFormOf(child as ts.Expression) !== 'none') {
        found = true
        return
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    writes.set(node, found)
    return found
  }
  /** The reference's own simple write `ref = e` as a whole expression, or `null`. */
  const simpleWriteOf = (expression: ts.Expression): ts.Expression | null => {
    const inner = unwrapParens(expression)
    if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
    return isReference(unwrapParens(inner.left)) ? inner.right : null
  }
  const absenceTestOf = (expression: ts.Expression): { readonly whenTrue: number; readonly whenFalse: number } | null => {
    const inner = unwrapParens(expression)
    if (isReference(inner)) return { whenTrue: PRESENT_KIND, whenFalse: ALL_KINDS }
    if (!ts.isBinaryExpression(inner)) return null
    const operator = inner.operatorToken.kind
    const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    const loose = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
    if (!strict && !loose) return null
    const negated = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
    const left = unwrapParens(inner.left)
    const right = unwrapParens(inner.right)
    let equal: number | null = null
    for (const [one, other] of [
      [left, right],
      [right, left]
    ] as const) {
      if (isReference(one)) {
        if (other.kind === ts.SyntaxKind.NullKeyword) equal = loose ? NULL_KIND | UNDEFINED_KIND : NULL_KIND
        else if (checker.getTypeAtLocation(other).flags === ts.TypeFlags.Undefined)
          equal = loose ? NULL_KIND | UNDEFINED_KIND : UNDEFINED_KIND
      } else if (
        strict &&
        ts.isTypeOfExpression(one) &&
        isReference(unwrapParens(one.expression)) &&
        ts.isStringLiteral(other) &&
        other.text === 'undefined'
      ) {
        equal = UNDEFINED_KIND
      }
      if (equal !== null) break
    }
    if (equal === null) return null
    const unequal = ALL_KINDS & ~equal
    return negated ? { whenTrue: unequal, whenFalse: equal } : { whenTrue: equal, whenFalse: unequal }
  }
  /** The values when a condition is true and when it is false. */
  const narrow = (condition: ts.Expression, state: State): { readonly whenTrue: State; readonly whenFalse: State } => {
    if (containsWrite(condition)) undecided()
    const inner = unwrapParens(condition)
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = narrow(inner.operand, state)
      return { whenTrue: operand.whenFalse, whenFalse: operand.whenTrue }
    }
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = narrow(inner.left, state)
      const right = narrow(inner.right, left.whenTrue)
      return { whenTrue: right.whenTrue, whenFalse: join(left.whenFalse, right.whenFalse) }
    }
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const left = narrow(inner.left, state)
      const right = narrow(inner.right, left.whenFalse)
      return { whenTrue: join(left.whenTrue, right.whenTrue), whenFalse: right.whenFalse }
    }
    const test = absenceTestOf(inner)
    if (!test) return { whenTrue: state, whenFalse: state }
    return { whenTrue: restrict(state, test.whenTrue), whenFalse: restrict(state, test.whenFalse) }
  }
  /** The values after an expression evaluated for its effect. */
  const afterExpression = (expression: ts.Expression, state: State): State => {
    const inner = unwrapParens(expression)
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return afterExpression(inner.right, afterExpression(inner.left, state))
    }
    const written = simpleWriteOf(inner)
    if (written) {
      if (containsWrite(written)) undecided()
      return new Map([[written, ALL_KINDS]])
    }
    if (containsWrite(inner)) undecided()
    return state
  }
  const afterDeclaration = (declaration: ts.VariableDeclaration, state: State): State => {
    if (reference.kind === 'local' && declaration === reference.declaration) {
      if (declaration.initializer) {
        if (containsWrite(declaration.initializer)) undecided()
        return new Map([[declaration.initializer, ALL_KINDS]])
      }
      // A fresh `let` binding holds `undefined`; a `var` redeclaration
      // without an initializer writes nothing.
      const list = declaration.parent
      const lexical = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0
      return lexical ? new Map([[declaration, UNDEFINED_KIND]]) : state
    }
    if (containsWrite(declaration)) undecided()
    return state
  }
  /** The values after a statement completes normally. */
  const afterStatement = (statement: ts.Statement, state: State): State => {
    if (ts.isBlock(statement)) return statement.statements.reduce((current, child) => afterStatement(child, current), state)
    if (ts.isExpressionStatement(statement)) return afterExpression(statement.expression, state)
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.reduce((current, declaration) => afterDeclaration(declaration, current), state)
    }
    if (ts.isIfStatement(statement)) {
      const { whenTrue, whenFalse } = narrow(statement.expression, state)
      const thenState = afterStatement(statement.thenStatement, whenTrue)
      return join(thenState, statement.elseStatement ? afterStatement(statement.elseStatement, whenFalse) : whenFalse)
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (statement.expression && containsWrite(statement.expression)) undecided()
      return EMPTY
    }
    if (ts.isBreakOrContinueStatement(statement)) return EMPTY
    if (ts.isFunctionDeclaration(statement)) return state
    // Loops, `switch`, `try`, labels and the rest: kept when they do not
    // write the reference (every value they let through was already here).
    if (containsWrite(statement)) undecided()
    return state
  }
  /** The values at the read, somewhere inside `node` (an expression, or a part of one), evaluated from `state`. */
  const atInExpression = (node: ts.Node, state: State): State => {
    if (node === read) return state
    const inner = ts.isParenthesizedExpression(node) ? unwrapParens(node) : node
    if (inner !== node) return atInExpression(inner, state)
    if (ts.isBinaryExpression(inner)) {
      const operator = inner.operatorToken.kind
      if (contains(inner.left, read) || inner.left === read) {
        if (isAssignmentOperator(operator) && isReference(unwrapParens(inner.left))) undecided()
        return atInExpression(inner.left, state)
      }
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return atInExpression(inner.right, narrow(inner.left, state).whenTrue)
      if (operator === ts.SyntaxKind.BarBarToken) return atInExpression(inner.right, narrow(inner.left, state).whenFalse)
      if (operator === ts.SyntaxKind.EqualsToken && isReference(unwrapParens(inner.left))) return atInExpression(inner.right, state)
      if (containsWrite(inner.left)) undecided()
      return atInExpression(inner.right, state)
    }
    if (ts.isConditionalExpression(inner)) {
      if (contains(inner.condition, read) || inner.condition === read) return atInExpression(inner.condition, state)
      const { whenTrue, whenFalse } = narrow(inner.condition, state)
      return contains(inner.whenTrue, read) || inner.whenTrue === read
        ? atInExpression(inner.whenTrue, whenTrue)
        : atInExpression(inner.whenFalse, whenFalse)
    }
    // A nested function runs later, not here.
    if (ts.isFunctionLike(inner) || ts.isClassLike(inner)) return undecided()
    // Any other expression evaluates its operands in source order; one that
    // writes the reference before the read is not followed.
    let result: State | null = null
    ts.forEachChild(inner, (child) => {
      if (result !== null) return true
      if (child === read || contains(child, read)) {
        result = atInExpression(child, state)
        return true
      }
      if (containsWrite(child)) undecided()
      return undefined
    })
    return result ?? undecided()
  }
  const holds = (node: ts.Node): boolean => node === read || contains(node, read)
  /** The values at the read, somewhere inside `statement`. */
  const atInStatement = (statement: ts.Statement, state: State): State => {
    if (ts.isBlock(statement)) return atInStatements(statement.statements, state)
    if (ts.isExpressionStatement(statement)) return atInExpression(statement.expression, state)
    if ((ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) && statement.expression) {
      return atInExpression(statement.expression, state)
    }
    if (ts.isVariableStatement(statement)) {
      let current = state
      for (const declaration of statement.declarationList.declarations) {
        if (!holds(declaration)) {
          current = afterDeclaration(declaration, current)
          continue
        }
        return declaration.initializer && holds(declaration.initializer) ? atInExpression(declaration.initializer, current) : undecided()
      }
      return undecided()
    }
    if (ts.isIfStatement(statement)) {
      if (holds(statement.expression)) return atInExpression(statement.expression, state)
      const { whenTrue, whenFalse } = narrow(statement.expression, state)
      if (holds(statement.thenStatement)) return atInStatement(statement.thenStatement, whenTrue)
      return statement.elseStatement ? atInStatement(statement.elseStatement, whenFalse) : undecided()
    }
    // Inside a loop or another compound statement that writes the reference,
    // the values at the read depend on the iteration; not followed.
    if (containsWrite(statement)) undecided()
    if (ts.isWhileStatement(statement) && holds(statement.statement)) {
      return atInStatement(statement.statement, narrow(statement.expression, state).whenTrue)
    }
    if (ts.isForStatement(statement) && holds(statement.statement)) {
      return atInStatement(statement.statement, statement.condition ? narrow(statement.condition, state).whenTrue : state)
    }
    if ((ts.isForOfStatement(statement) || ts.isForInStatement(statement) || ts.isDoStatement(statement)) && holds(statement.statement)) {
      return atInStatement(statement.statement, state)
    }
    if (ts.isLabeledStatement(statement)) return atInStatement(statement.statement, state)
    if (ts.isTryStatement(statement) && holds(statement.tryBlock)) return atInStatement(statement.tryBlock, state)
    // Anything else with no write: every value here may reach the read.
    return state
  }
  const atInStatements = (statements: readonly ts.Statement[], state: State): State => {
    let current = state
    for (const statement of statements) {
      if (holds(statement)) return atInStatement(statement, current)
      current = afterStatement(statement, current)
    }
    return undecided()
  }
  try {
    const container = reference.container
    let state: State
    if (reference.kind === 'field') state = new Map([[null, ALL_KINDS]])
    else {
      // A `var` is `undefined` from the top of its function; a `let` or
      // `const` is not readable before its declaration runs.
      const list = reference.declaration.parent
      const lexical = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0
      state = lexical ? EMPTY : new Map([[reference.declaration, UNDEFINED_KIND]])
    }
    let at: State
    if (ts.isSourceFile(container)) at = atInStatements(container.statements, state)
    else if (ts.isFunctionLike(container) && 'body' in container && container.body) {
      const body = container.body as ts.Node
      at = ts.isBlock(body) ? atInStatements(body.statements, state) : atInExpression(body as ts.Expression, state)
    } else return null
    if (at.size === 0) return null
    return [...at].map(([source, kinds]) => ({ source, kinds }))
  } catch (error) {
    if (error instanceof Undecided) return null
    throw error
  }
}

/** The non-arrow function whose `this` a `this` token inside `node` names, or `null`. */
const thisOwnerOf = (node: ts.Node): ts.Node | null => {
  let current = node.parent
  while (current) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return current
    if (ts.isClassStaticBlockDeclaration(current) || ts.isPropertyDeclaration(current) || ts.isSourceFile(current)) return null
    current = current.parent
  }
  return null
}

/** How a mention of the reference writes it: not at all, as `ref = e`, or some other way. */
const writeFormOf = (mention: ts.Expression): 'none' | 'simple' | 'other' => {
  let node: ts.Node = mention
  let parent = node.parent
  while (parent && ts.isParenthesizedExpression(parent)) {
    node = parent
    parent = parent.parent
  }
  if (!parent) return 'none'
  if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'simple' : 'other'
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return 'other'
  if (ts.isDeleteExpression(parent)) return 'other'
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return 'other'
  // A destructuring assignment target: `[ ref ] = v`, `({ k: ref } = v)`, `({ ref } = v)`.
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node)
  ) {
    let pattern: ts.Node = parent
    while (
      pattern.parent &&
      (ts.isArrayLiteralExpression(pattern.parent) ||
        ts.isObjectLiteralExpression(pattern.parent) ||
        ts.isSpreadElement(pattern.parent) ||
        ts.isPropertyAssignment(pattern.parent) ||
        ts.isShorthandPropertyAssignment(pattern.parent) ||
        ts.isParenthesizedExpression(pattern.parent) ||
        ts.isSpreadAssignment(pattern.parent))
    )
      pattern = pattern.parent
    const top = pattern.parent
    if (top && ts.isBinaryExpression(top) && top.left === pattern && top.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'other'
    if (top && (ts.isForOfStatement(top) || ts.isForInStatement(top)) && top.initializer === pattern) return 'other'
  }
  return 'none'
}

const referenceOf = (checker: ts.TypeChecker, flow: ValueFlowIndex | undefined, read: ts.Expression): Reference | null => {
  if (ts.isIdentifier(read)) {
    const declaration = soleVariableDeclarationOf(checker, read)
    const symbol = checker.getSymbolAtLocation(read)
    if (!declaration || !symbol || !ts.isIdentifier(declaration.name) || read === declaration.name) return null
    const container = containerOf(declaration)
    if (containerOf(read) !== container) return null
    // A write from a closure can run at any call; only the declaring
    // function's own writes are ordered against the read.
    if (flow) {
      const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
      if (writes.some((write) => containerOf(write.site) !== container && write.site !== declaration)) return null
    }
    return { kind: 'local', symbol, declaration, container }
  }
  if (ts.isPropertyAccessExpression(read) && read.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = thisOwnerOf(read)
    // Only a read in the owner's own body (not inside an arrow function it
    // creates, which runs later) is ordered against the owner's statements.
    if (!owner || containerOf(read) !== owner) return null
    return { kind: 'field', name: read.name.text, container: owner }
  }
  return null
}

/** The absence kinds a value expression can hold, from its syntax alone; `null` when its syntax does not say. */
export const syntacticAbsenceKindsOf = (checker: ts.TypeChecker, expression: ts.Expression): number | null => {
  const inner = unwrapParens(expression)
  if (inner.kind === ts.SyntaxKind.NullKeyword) return NULL_KIND
  if (checker.getTypeAtLocation(inner).flags === ts.TypeFlags.Undefined) return UNDEFINED_KIND
  if (
    ts.isArrayLiteralExpression(inner) ||
    ts.isObjectLiteralExpression(inner) ||
    ts.isNewExpression(inner) ||
    ts.isFunctionExpression(inner) ||
    ts.isArrowFunction(inner) ||
    ts.isClassExpression(inner) ||
    ts.isStringLiteral(inner) ||
    ts.isNumericLiteral(inner) ||
    ts.isNoSubstitutionTemplateLiteral(inner) ||
    ts.isTemplateExpression(inner) ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword
  )
    return PRESENT_KIND
  return null
}

/**
 * The absence kinds that can reach this read: the kinds of every reaching
 * value (`valuesReachingRead`), each as its guards allow. `kindsOf` answers
 * for a write's value whose syntax does not say (its layout's absence arms).
 * `null` when the reaching values cannot be decided.
 */
export const absenceKindsReachingRead = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex | undefined,
  read: ts.Expression,
  kindsOf: (source: ts.Expression) => number
): number | null => {
  const values = valuesReachingRead(checker, flow, read)
  if (!values) return null
  let kinds = 0
  for (const value of values) {
    const own =
      value.source === null
        ? ALL_KINDS
        : ts.isVariableDeclaration(value.source)
          ? UNDEFINED_KIND
          : (syntacticAbsenceKindsOf(checker, value.source) ?? kindsOf(value.source))
    kinds |= own & value.kinds
  }
  return kinds
}
