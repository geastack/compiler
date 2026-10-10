import ts from 'typescript'

/**
 * A pre-class constructor function and the methods its script assigns onto
 * `F.prototype`, rewritten into the class it is.
 *
 * ## The shape
 *
 * Many small npm packages are ES5:
 *
 *     function Pager (pageSize, opts) {
 *       if (!(this instanceof Pager)) return new Pager(pageSize, opts)
 *       this.length = 0
 *       ...
 *     }
 *     Pager.prototype.get = function (i, noAllocate) { ... }
 *
 * The checker infers the instance type from the `this.x =` writes and the
 * prototype assignments, but an instance of such a function is a record with
 * no prototype chain and no method table, so every method read is refused
 * (`producers/properties.ts`, "model the constructor as the class it is").
 * A class states the same members in the one form every later layer already
 * compiles: the constructor body becomes `constructor`, each prototype
 * assignment becomes a method.
 *
 * ## What the rewrite preserves, and what it does not
 *
 * - Every body keeps its text, parameters and JSDoc.
 * - When the class exists: a function declaration is hoisted, a class is not,
 *   and such a module's first line may well be `module.exports = Pager`. The class goes
 *   at the head of the file, after the directive prologue. Its definition has
 *   no heritage clause, no computed key and no field, so evaluating it runs
 *   nothing and reads nothing -- exactly as early and as inert as the hoisted
 *   function it replaces.
 * - The call-without-`new` guard (`if (!(this instanceof F)) return new F(a,
 *   b)`, the whole guard, forwarding every parameter in order) says a plain
 *   `F(a, b)` IS `new F(a, b)`. A class cannot be called, so a guarded `F`
 *   stays a function -- one whose body is that construction -- and the class
 *   takes the name `F$class`. Every `new F(...)` and `instanceof F` in the file
 *   names the class. `new F(...)` from another module still answers the class
 *   instance the factory returns; `x instanceof F` there reads the factory's
 *   own, unrelated `prototype` and answers `false`.
 * - Class bodies are strict code. A sloppy-mode body that relied on sloppy
 *   semantics would change; neither package does.
 *
 * Refused, leaving the file as written: a prototype member that is not a
 * plain `function` expression (a data value, an arrow), one assigned twice or
 * named `constructor`, `F.prototype` read anywhere else, `F` used as a value
 * (passed, stored, given static members, inherited from), a constructor that
 * returns a value or reads `new.target`, a named method expression that reads
 * its own name, and an unguarded `F` called without `new`.
 *
 * Text in, text out, spliced from the end backward, like the other transforms
 * in this directory.
 */

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression

interface Method {
  readonly statement: ts.ExpressionStatement
  readonly name: string
  readonly value: ts.FunctionExpression
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** `F.prototype.name = function (...) {...}` as a top-level statement. */
const prototypeMethodOf = (statement: ts.Statement, className: string): Method | null => {
  if (!ts.isExpressionStatement(statement)) return null
  const assignment = statement.expression
  if (!ts.isBinaryExpression(assignment) || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const target = assignment.left
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.name)) return null
  const owner = target.expression
  if (
    !ts.isPropertyAccessExpression(owner) ||
    owner.name.text !== 'prototype' ||
    !ts.isIdentifier(owner.expression) ||
    owner.expression.text !== className
  )
    return null
  const value = unwrap(assignment.right)
  if (!ts.isFunctionExpression(value)) return null
  return { statement, name: target.name.text, value }
}

/** Whether `node` reads `name` as an identifier anywhere, ignoring property-name positions. */
const readsName = (node: ts.Node, name: string): boolean => {
  const visit = (child: ts.Node): boolean => {
    if (ts.isIdentifier(child) && child.text === name) {
      const parent = child.parent
      if (ts.isPropertyAccessExpression(parent) && parent.name === child) return false
      if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === child) return false
      return true
    }
    return ts.forEachChild(child, visit) ?? false
  }
  return visit(node)
}

/** Whether the function's own body (not a nested function's) returns a value or reads `new.target`. */
const constructorBodyRefused = (body: ts.Block, guard: ts.Statement | null): boolean => {
  const visit = (node: ts.Node): boolean => {
    if (node === guard) return false
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword) return true
    if (ts.isReturnStatement(node) && node.expression !== undefined) return true
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return false
    if (ts.isClassLike(node)) return false
    return ts.forEachChild(node, visit) ?? false
  }
  return ts.forEachChild(body, visit) ?? false
}

const readsNewTarget = (node: ts.Node): boolean =>
  (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.NewKeyword) || (ts.forEachChild(node, readsNewTarget) ?? false)

/** `if (!(this instanceof F)) return new F(<every parameter, in order>)`, the whole first statement. */
const callGuardOf = (fn: ts.FunctionDeclaration, className: string): ts.IfStatement | null => {
  const first = fn.body?.statements[0]
  if (!first || !ts.isIfStatement(first) || first.elseStatement) return null
  const test = unwrap(first.expression)
  if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken) return null
  const check = unwrap(test.operand)
  if (
    !ts.isBinaryExpression(check) ||
    check.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword ||
    check.left.kind !== ts.SyntaxKind.ThisKeyword ||
    !ts.isIdentifier(check.right) ||
    check.right.text !== className
  )
    return null
  let then = first.thenStatement
  if (ts.isBlock(then)) {
    if (then.statements.length !== 1) return null
    then = then.statements[0]!
  }
  if (!ts.isReturnStatement(then) || !then.expression) return null
  const construction = unwrap(then.expression)
  if (!ts.isNewExpression(construction) || !ts.isIdentifier(construction.expression) || construction.expression.text !== className)
    return null
  const args = construction.arguments ?? ts.factory.createNodeArray()
  if (args.length !== fn.parameters.length) return null
  for (const [index, parameter] of fn.parameters.entries()) {
    const arg = args[index]!
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer) return null
    if (!ts.isIdentifier(arg) || arg.text !== parameter.name.text) return null
  }
  return first
}

type Use = 'construct' | 'call' | 'instanceof' | 'export' | 'declaration' | 'prototype-member' | 'other'

/** How one read of the name `F` uses it. */
const useOf = (identifier: ts.Identifier, fn: ts.FunctionDeclaration, methods: ReadonlySet<ts.Node>): Use => {
  const parent = identifier.parent
  if (parent === fn) return 'declaration'
  if (ts.isNewExpression(parent) && parent.expression === identifier) return 'construct'
  if (ts.isCallExpression(parent) && parent.expression === identifier) return 'call'
  if (ts.isBinaryExpression(parent) && parent.right === identifier && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
    return 'instanceof'
  if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier && parent.name.text === 'prototype') {
    const member = parent.parent
    return ts.isPropertyAccessExpression(member) && methods.has(member.parent) ? 'prototype-member' : 'other'
  }
  if (ts.isExportAssignment(parent)) return 'export'
  // `module.exports = F`, `exports.name = F`, `module.exports.name = F`.
  if (ts.isBinaryExpression(parent) && parent.right === identifier && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const text = parent.left.getText()
    if (/^(?:module\.exports|exports|module\.exports\.[\w$]+|exports\.[\w$]+)$/.test(text)) return 'export'
  }
  return 'other'
}

/** Every identifier reading `name` outside property-name positions. */
const identifiersNamed = (file: ts.SourceFile, name: string): ts.Identifier[] => {
  const found: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent
      const namePosition =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)
      if (!namePosition) found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** A statement's own leading comments (its JSDoc), from its full start to its first token. */
const leadingText = (node: ts.Node, file: ts.SourceFile): string => {
  const text = file.text.slice(node.getFullStart(), node.getStart(file)).trim()
  return text.length > 0 ? `${text}\n  ` : ''
}

/** Source text of `[start, end)` with the rename edits inside it applied. */
const sliceWith = (file: ts.SourceFile, start: number, end: number, renames: readonly Edit[]): string => {
  let text = ''
  let at = start
  for (const rename of renames) {
    if (rename.start < start || rename.end > end) continue
    text += file.text.slice(at, rename.start) + rename.text
    at = rename.end
  }
  return text + file.text.slice(at, end)
}

const parameterListText = (parameters: ts.NodeArray<ts.ParameterDeclaration>, file: ts.SourceFile, renames: readonly Edit[]): string =>
  parameters.length === 0 ? '' : sliceWith(file, parameters[0]!.getStart(file), parameters.end, renames)

/** The rewrite of one constructor function, or null when any use falls outside what the class states. */
const rewriteOf = (
  fn: ts.FunctionDeclaration,
  file: ts.SourceFile
): { readonly classText: string; readonly edits: readonly Edit[] } | null => {
  const className = fn.name!.text
  if (fn.typeParameters || fn.asteriskToken || fn.modifiers?.length) return null
  const methods: Method[] = []
  for (const statement of file.statements) {
    const method = prototypeMethodOf(statement, className)
    if (method) methods.push(method)
  }
  if (methods.length === 0) return null
  const names = new Set<string>()
  for (const method of methods) {
    if (method.name === 'constructor' || names.has(method.name)) return null
    names.add(method.name)
    if (readsNewTarget(method.value.body)) return null
    if (method.value.name && readsName(method.value.body, method.value.name.text)) return null
  }
  const guard = callGuardOf(fn, className)
  if (constructorBodyRefused(fn.body!, guard)) return null
  const methodStatements = new Set<ts.Node>(methods.map((method) => method.statement.expression))
  const uses = identifiersNamed(file, className).map((identifier) => ({ identifier, use: useOf(identifier, fn, methodStatements) }))
  if (uses.some(({ use }) => use === 'other')) return null
  if (!guard && uses.some(({ use }) => use === 'call')) return null
  const instanceName = guard ? `${className}$class` : className
  if (guard && identifiersNamed(file, instanceName).length > 0) return null
  const renames: Edit[] = guard
    ? uses
        .filter(({ identifier, use }) => {
          if (use !== 'construct' && use !== 'instanceof') return false
          // The guard's own `this instanceof F` / `new F(...)` is dropped with the guard.
          return identifier.getStart(file) < guard.getStart(file) || identifier.getStart(file) >= guard.end
        })
        .map(({ identifier }) => ({ start: identifier.getStart(file), end: identifier.end, text: instanceName }))
        .sort((a, b) => a.start - b.start)
    : []
  const body = fn.body!
  const bodyText = guard
    ? `{${sliceWith(file, body.getStart(file) + 1, guard.getFullStart(), renames)}${sliceWith(file, guard.end, body.end, renames)}`
    : sliceWith(file, body.getStart(file), body.end, renames)
  const members = [
    `${leadingText(fn, file)}constructor(${parameterListText(fn.parameters, file, renames)}) ${bodyText}`,
    ...methods.map((method) => {
      const value = method.value
      const prefix = `${value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}${value.asteriskToken ? '*' : ''}`
      return `${leadingText(method.statement, file)}${prefix}${method.name}(${parameterListText(value.parameters, file, renames)}) ${sliceWith(
        file,
        value.body.getStart(file),
        value.body.end,
        renames
      )}`
    })
  ]
  const classText = `class ${instanceName} {\n  ${members.join('\n\n  ')}\n}\n`
  const edits: Edit[] = [
    ...methods.map((method) => ({ start: method.statement.getFullStart(), end: method.statement.end, text: '' })),
    ...renames
      .filter((rename) => rename.start < fn.getFullStart() || rename.start >= fn.end)
      .filter((rename) => !methods.some((method) => rename.start >= method.statement.getFullStart() && rename.end <= method.statement.end)),
    {
      start: fn.getFullStart(),
      end: fn.end,
      text: guard
        ? `${file.text.slice(fn.getFullStart(), fn.getStart(file))}function ${className}(${parameterListText(fn.parameters, file, [])}) {\n  return new ${instanceName}(${fn.parameters
            .map((parameter) => parameter.name.getText(file))
            .join(', ')})\n}`
        : ''
    }
  ]
  return { classText, edits }
}

/** Where a hoisted class goes: after a shebang line and the directive prologue (`'use strict'`), so both stay what they are. */
const headOf = (file: ts.SourceFile): number => {
  let at = file.text.startsWith('#!') ? file.text.indexOf('\n') + 1 || file.text.length : 0
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    at = statement.end
  }
  return at
}

/**
 * One constructor per pass, re-parsed between passes: a second constructor's
 * body can name the first (`new Page(...)` inside `Pager`), and those renames
 * must land in the text the second rewrite slices, not in a region it deletes.
 */
const rewriteOne = (fileName: string, text: string, done: ReadonlySet<string>): { readonly text: string; readonly name: string } | null => {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || done.has(statement.name.text)) continue
    const rewrite = rewriteOf(statement, file)
    if (!rewrite) continue
    const head = headOf(file)
    const edits = [...rewrite.edits, { start: head, end: head, text: `${head > 0 ? '\n' : ''}${rewrite.classText}` }]
    let rewritten = text
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
      rewritten = `${rewritten.slice(0, edit.start)}${edit.text}${rewritten.slice(edit.end)}`
    return { text: rewritten, name: statement.name.text }
  }
  return null
}

export const constructorFunctionClassSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName) || !input.text.includes('.prototype.')) return null
  const done = new Set<string>()
  let text = input.text
  for (let pass = rewriteOne(input.fileName, text, done); pass; pass = rewriteOne(input.fileName, text, done)) {
    done.add(pass.name)
    text = pass.text
  }
  return done.size === 0 ? null : text
}
