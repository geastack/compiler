import ts from 'typescript'
import { inheritedImplementationOf } from './merged-declaration.js'
import { isFreshOrLastUseOfFreshLocal, type FreshValueKind } from './fresh-table-last-use.js'

/**
 * The method body a member call runs when it returns an array NO OTHER
 * REFERENCE holds: every `return` hands back an array literal, or a local
 * initialized with one that the body only fills, indexes and measures.
 *
 * This is the one fact that makes converting an `array-object` between two
 * element carriers sound. A conversion between them has to allocate, and for
 * a mutable array a second array loses every write through the other alias
 * (`array-object-call-argument-aliasing`). A call result proven fresh has no
 * other alias: the callee dropped its own reference when it returned, so the
 * converted array is the only one the program can ever observe, and a
 * one-time element-wise copy at the call is indistinguishable from the
 * callee having built it at the caller's element type.
 *
 * An `async` body qualifies the same way: its promise settles with the
 * array its `return` names, and that array is still held by nothing else.
 * A generic cursor's `async toArray()` is the shape this exists for -- it
 * builds `const array: T[] = []`, pushes every item and returns it, while the
 * cursor class is folded onto its `any` copy (`specialization.ts`'s
 * reinterpreted classes), so the body hands back `any[]` where the caller's
 * view declares `Info[]`.
 *
 * Deliberately syntactic and small. Any use of the local outside the listed
 * forms -- passing it as an argument, storing it, capturing it in a closure,
 * a method whose result aliases it (`reverse`, `sort`), iteration protocol
 * hooks -- refuses, and a refusal only keeps the conversion refused. The key
 * is returned alongside so lowering can confirm the call it runs really
 * reaches this body: an override in the receiver's family, or a prototype
 * write, would run a different body the proof never saw.
 */
export const unsharedArrayResultBodyOf = (checker: ts.TypeChecker, node: ts.CallExpression): ts.MethodDeclaration | null => {
  if (ts.isOptionalChain(node)) return null
  const callee = skipParentheses(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null
  const member = checker.getSymbolAtLocation(callee.name)
  if (!member) return null
  const implementation = inheritedImplementationOf(checker, member) ?? member
  const bodies = (implementation.declarations ?? []).filter(
    (declaration): declaration is ts.MethodDeclaration =>
      ts.isMethodDeclaration(declaration) && declaration.body !== undefined && ts.isClassLike(declaration.parent)
  )
  const body = bodies.length === 1 ? bodies[0]! : null
  if (!body || body.asteriskToken !== undefined) return null
  return returnsFreshArray(checker, body) ? body : null
}

const returnsFreshArray = (checker: ts.TypeChecker, body: ts.MethodDeclaration): boolean => {
  const returns: ts.Expression[] = []
  let bare = false
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(skipParentheses(node.expression))
      else bare = true
    }
    ts.forEachChild(node, collect)
  }
  ts.forEachChild(body.body!, collect)
  if (bare || returns.length === 0) return false
  return returns.every((expression) => ts.isArrayLiteralExpression(expression) || freshLocal(checker, body, expression))
}

const freshLocal = (checker: ts.TypeChecker, body: ts.MethodDeclaration, expression: ts.Expression): boolean => {
  if (!ts.isIdentifier(expression)) return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
  if (!declaration.initializer || !ts.isArrayLiteralExpression(skipParentheses(declaration.initializer))) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  if (enclosingFunction(declaration) !== body) return false
  let admitted = true
  const visit = (node: ts.Node): void => {
    if (!admitted) return
    if (ts.isIdentifier(node) && node !== declaration.name && checker.getSymbolAtLocation(node) === symbol) {
      admitted = enclosingFunction(node) === body && nonEscapingUse(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body.body!, visit)
  return admitted
}

/** A use that reads, fills or measures the array and hands no reference to it anywhere. */
const nonEscapingUse = (use: ts.Identifier): boolean => {
  const parent = use.parent
  if (ts.isReturnStatement(parent)) return true
  if (ts.isParenthesizedExpression(parent)) return false
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use && ts.isIdentifier(parent.name)) {
    const name = parent.name.text
    if (name === 'length') return !isAssignmentTarget(parent)
    const call = parent.parent
    return (name === 'push' || name === 'unshift') && ts.isCallExpression(call) && call.expression === parent
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === use) return true
  return false
}

/**
 * `Array.prototype` members that read their receiver and hand no reference to
 * it anywhere: the result is a value, an element, or a NEW array of the
 * receiver's elements. A member answering an iterator (`entries`, `values`)
 * would keep the receiver alive past the call and is not listed. The number
 * is how many parameters the member's callback may declare without receiving
 * the array itself (ECMA-262 passes it as the callback's last argument);
 * `null` for a member taking no callback.
 */
const READING_ARRAY_MEMBERS: ReadonlyMap<string, number | null> = new Map([
  ['forEach', 2],
  ['map', 2],
  ['filter', 2],
  ['some', 2],
  ['every', 2],
  ['find', 2],
  ['findIndex', 2],
  ['findLast', 2],
  ['findLastIndex', 2],
  ['flatMap', 2],
  ['reduce', 3],
  ['reduceRight', 3],
  ['indexOf', null],
  ['lastIndexOf', null],
  ['includes', null],
  ['join', null],
  ['at', null],
  ['slice', null]
])

/** Only the lib's own `Array<T>`/`ReadonlyArray<T>` member: a program body of the same name is not known to only read. */
const libArrayMember = (checker: ts.TypeChecker, name: ts.Identifier): boolean => {
  const declarations = checker.getSymbolAtLocation(name)?.declarations ?? []
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (!declaration.getSourceFile().hasNoDefaultLib) return false
      const owner = declaration.parent
      return ts.isInterfaceDeclaration(owner) && (owner.name.text === 'Array' || owner.name.text === 'ReadonlyArray')
    })
  )
}

/**
 * `use.member(...)` where the member only reads its receiver: its callback, if
 * any, is an arrow function (no `this`, no `arguments`) that declares too few
 * parameters to receive the array. Its arguments are checked as uses of their
 * own: one naming the array again is a separate, refused use.
 */
const readingMemberCall = (checker: ts.TypeChecker, use: ts.Identifier): boolean => {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use || !ts.isIdentifier(access.name)) return false
  const call = access.parent
  if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken !== undefined) return false
  const name = access.name.text
  if (!READING_ARRAY_MEMBERS.has(name) || !libArrayMember(checker, access.name)) return false
  const arity = READING_ARRAY_MEMBERS.get(name)!
  if (arity === null) return true
  const callback = call.arguments[0]
  return (
    callback !== undefined &&
    ts.isArrowFunction(callback) &&
    callback.parameters.length <= arity &&
    callback.parameters.every((parameter) => parameter.dotDotDotToken === undefined)
  )
}

const isUpdate = (operator: ts.SyntaxKind): boolean =>
  operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken

/** `array[i]` read and nothing else: no store, no update, no delete, and not a call whose receiver would be the array. */
const elementRead = (use: ts.Identifier): boolean => {
  const access = use.parent
  if (!ts.isElementAccessExpression(access) || access.expression !== use) return false
  const outer = access.parent
  if (isAssignmentTarget(access) || ts.isDeleteExpression(outer)) return false
  if ((ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) && isUpdate(outer.operator)) return false
  if (ts.isCallExpression(outer) && outer.expression === access) return false
  // Possibly a destructuring target (`[a[0]] = ...`, `({ x: a[0] } = ...)`), which stores.
  return !ts.isArrayLiteralExpression(outer) && !ts.isPropertyAssignment(outer) && !ts.isShorthandPropertyAssignment(outer)
}

/** `array.length` read, never stored. */
const lengthRead = (use: ts.Identifier): boolean => {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use || access.name.text !== 'length') return false
  const outer = access.parent
  if (isAssignmentTarget(access) || ts.isDeleteExpression(outer)) return false
  return !((ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) && isUpdate(outer.operator))
}

/** `for (... of array)`: the elements are read; the array is held only by the loop. */
const iterated = (use: ts.Identifier): boolean => ts.isForOfStatement(use.parent) && use.parent.expression === use

/**
 * A formal parameter of `callee` that the body only READS as an array: it
 * measures it, indexes it, iterates it and calls reading members on it. It
 * never stores through it, stores IT anywhere, compares it by identity,
 * captures it in a closure, or hands it to another call. `arguments` would
 * alias it, so a body naming `arguments` refuses. So does a generator or an
 * `async` body, which keeps running after the call returned, when the
 * caller's array may already have changed.
 *
 * This is the callee half of a call argument's unshared copy
 * (`unsharedArrayArgumentAt`): such a formal cannot observe whether it holds
 * the caller's array or an element-wise copy of it.
 */
export const readOnlyArrayFormalOf = (checker: ts.TypeChecker, callee: ts.SignatureDeclaration, index: number): boolean => {
  if (
    !ts.isFunctionDeclaration(callee) &&
    !ts.isFunctionExpression(callee) &&
    !ts.isArrowFunction(callee) &&
    !ts.isMethodDeclaration(callee)
  )
    return false
  const body = callee.body
  if (!body || (!ts.isArrowFunction(callee) && callee.asteriskToken !== undefined) || callee.getSourceFile().isDeclarationFile) return false
  if (ts.getCombinedModifierFlags(callee) & ts.ModifierFlags.Async) return false
  // A `this` parameter is not a positional argument; it would shift every index.
  const parameters = callee.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
  const parameter = parameters[index]
  if (!parameter || parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name)) return false
  if (!checker.isArrayType(checker.getTypeAtLocation(parameter))) return false
  const symbol = checker.getSymbolAtLocation(parameter.name)
  if (!symbol) return false
  let admitted = true
  const visit = (node: ts.Node): void => {
    if (!admitted) return
    if (ts.isIdentifier(node)) {
      if (node.text === 'arguments') admitted = false
      else if (node !== parameter.name && checker.getSymbolAtLocation(node) === symbol)
        admitted =
          enclosingFunction(node) === callee &&
          (lengthRead(node) || elementRead(node) || iterated(node) || readingMemberCall(checker, node))
      return
    }
    ts.forEachChild(node, visit)
  }
  // A default initializer of another formal may name this one: the parameter list is part of the body's reach.
  for (const other of callee.parameters) if (other !== parameter) visit(other)
  visit(body)
  return admitted
}

/**
 * A `const` local initialized with an array literal whose EVERY use, before
 * or after the one asked about, keeps the array in this body: a
 * `arrayKind` use, a `return`, or an argument `readOnlyArgument` admits.
 * No closure names it (a closure could run while a copy is outstanding), and
 * it is not exported, so no other module can.
 *
 * Unlike `isFreshOrLastUseOfFreshLocal`, the array outlives the use: it is
 * the caller's, still filled and read after the call. What makes a copy at a
 * read-only argument unobservable is that nothing else can reach the array
 * while the callee runs, and the callee can neither write it nor keep it.
 */
const unsharedLocalArrayOf = (
  checker: ts.TypeChecker,
  expression: ts.Expression,
  readOnlyArgument: (use: ts.Identifier) => boolean
): boolean => {
  if (!ts.isIdentifier(expression)) return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
  if (!declaration.initializer || !ts.isArrayLiteralExpression(skipParentheses(declaration.initializer))) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  const owner = enclosingFunction(declaration)
  const file = declaration.getSourceFile()
  if (owner === undefined) {
    // Top level: only a module's own unexported binding is unreachable from elsewhere.
    if (!ts.isExternalModule(file) || !ts.isVariableStatement(list.parent)) return false
    if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) return false
    if (isExportedByName(file, declaration.name.text)) return false
  }
  let admitted = true
  const visit = (node: ts.Node): void => {
    if (!admitted) return
    if (ts.isIdentifier(node) && node !== declaration.name && checker.getSymbolAtLocation(node) === symbol) {
      admitted =
        enclosingFunction(node) === owner &&
        (ts.isReturnStatement(node.parent) || nonEscapingArrayUse(checker, node) || readOnlyArgument(node))
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(owner ?? file, visit)
  return admitted
}

/** `export { name }` / `export default name` exports a top-level binding without an `export` modifier on it. */
const isExportedByName = (file: ts.SourceFile, name: string): boolean =>
  file.statements.some(
    (statement) =>
      (ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === name)) ||
      (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && statement.expression.text === name)
  )

/** `array.push(...)` / `array.unshift(...)`: fills the array, answers a number. */
const fillingCall = (use: ts.Identifier): boolean => {
  const access = use.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== use || !ts.isIdentifier(access.name)) return false
  const call = access.parent
  return (access.name.text === 'push' || access.name.text === 'unshift') && ts.isCallExpression(call) && call.expression === access
}

/** `array[i] = value`: a plain store into the local's own array. */
const indexedStore = (use: ts.Identifier): boolean => {
  const access = use.parent
  if (!ts.isElementAccessExpression(access) || access.expression !== use) return false
  const store = access.parent
  return ts.isBinaryExpression(store) && store.left === access && store.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

/**
 * An array as `fresh-table-last-use.ts` proves objects unshared: an array
 * literal is the allocation, and a use that fills, measures, indexes,
 * iterates or reads it through a reading member hands no reference to it
 * anywhere.
 */
export const arrayKind = (checker: ts.TypeChecker): FreshValueKind => ({
  isFresh: (expression) => ts.isArrayLiteralExpression(expression),
  admitsUse: (use) => nonEscapingArrayUse(checker, use)
})

const nonEscapingArrayUse = (checker: ts.TypeChecker, use: ts.Identifier): boolean =>
  lengthRead(use) || fillingCall(use) || indexedStore(use) || elementRead(use) || iterated(use) || readingMemberCall(checker, use)

/**
 * `return local`: the local array's last use (`isFreshOrLastUseOfFreshLocal`
 * over `arrayKind`), so its one holder dies here and the returned array
 * may be rebuilt at the declared carrier (`SemanticOperand.unsharedFreshArray`).
 * A literal returned directly already takes the slot's carrier from its own
 * allocation, so only the local form is asked.
 */
export const unsharedReturnedArray = (checker: ts.TypeChecker, statement: ts.ReturnStatement): boolean =>
  statement.expression !== undefined &&
  ts.isIdentifier(statement.expression) &&
  isFreshOrLastUseOfFreshLocal(checker, statement.expression, arrayKind(checker))

/** The one body a call runs, and the formal an argument binds; `null` without an exact target proof. */
export type ArgumentFormalOf = (
  call: ts.CallExpression,
  argument: ts.Expression
) => { callee: ts.SignatureDeclaration; index: number } | null

/**
 * `callee(local)` where `local` is unshared (`unsharedLocalArrayOf`) and the
 * formal it binds is read only (`readOnlyArrayFormalOf`)
 * (`SemanticOperand.readOnlyArrayArgument`). `formalOf` is asked of every call
 * the local is passed to, so each of them must be read only too.
 */
export const readOnlyArrayArgumentAt = (checker: ts.TypeChecker, argument: ts.Expression, formalOf: ArgumentFormalOf): boolean => {
  // Cheapest first: most identifier arguments are not array-literal locals at all.
  if (!ts.isIdentifier(argument) || !arrayLiteralConstOf(checker, argument)) return false
  const readOnlyArgument = (use: ts.Identifier): boolean => {
    const call = use.parent
    if (!ts.isCallExpression(call) || !call.arguments.includes(use) || call.questionDotToken !== undefined) return false
    const formal = formalOf(call, use)
    return formal !== null && readOnlyArrayFormalOf(checker, formal.callee, formal.index)
  }
  return readOnlyArgument(argument) && unsharedLocalArrayOf(checker, argument, readOnlyArgument)
}

const arrayLiteralConstOf = (checker: ts.TypeChecker, name: ts.Identifier): boolean => {
  const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0]
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    ts.isArrayLiteralExpression(skipParentheses(declaration.initializer))
  )
}

const isAssignmentTarget = (node: ts.Node): boolean =>
  ts.isBinaryExpression(node.parent) &&
  node.parent.left === node &&
  node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment

const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  return current
}

const skipParentheses = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ? skipParentheses(node.expression)
    : node
