import ts from 'typescript'

/**
 * Methods and getters a script installs onto its own class with
 * `Object.defineProperty`, rewritten into the class members they install.
 *
 * ## The shape
 *
 * `@hono/node-server`'s lightweight `Response` declares the members it can
 * answer cheaply and installs the rest after the class, from literal key
 * lists:
 *
 *     ;['body', 'bodyUsed'].forEach((k) => {
 *       Object.defineProperty(Response.prototype, k, { get() { return this[getResponseCache]()[k] } })
 *     })
 *     Object.defineProperty(Response, 'json', { value: function json(...) {...}, writable: true, configurable: true })
 *
 * The checker cannot see any of it: a descriptor's functions are typed with
 * `ThisType<any>`, the key is a `string`, and the class's declared type has no
 * such member. A class member states the same function with the receiver and
 * the key the program means, so every layer after this one compiles an
 * ordinary member.
 *
 * ## What the rewrite preserves, and what it does not
 *
 * - The function: its parameters, annotations and body, with the loop key
 *   replaced by its literal (the one value it holds for that install). A
 *   `forEach` over a fresh array literal of string literals calls the arrow
 *   once per element in order, so one install per element is the loop.
 * - When the member exists: from class definition instead of from the
 *   install. The rewrite only fires when nothing between the two can observe
 *   the class -- every statement in between is itself a rewritten install, a
 *   `setPrototypeOf` of the class, a declaration whose initializer calls
 *   nothing of the program's, or an empty statement.
 * - A STATIC install whose descriptor says `writable: true, configurable:
 *   true` and nothing else has exactly a static method's attributes, so it is
 *   rewritten with nothing lost.
 * - A PROTOTYPE install with no attributes installs a non-writable,
 *   non-configurable property where a class member is writable and
 *   configurable. Reflection on the prototype (`getOwnPropertyDescriptor`,
 *   `delete`) is where that shows, and a class prototype that escapes into
 *   reflection is refused downstream (`projection/classes.ts`), so the
 *   rewrite is only admitted when this file names `C.prototype` in nothing but
 *   these installs and `Object.setPrototypeOf`. A store onto an instance
 *   (`response.text = f`) is the one difference left: the install makes it a
 *   TypeError, the member makes it an own property.
 *
 * Accessor descriptors with a setter, attribute keys on a prototype install,
 * computed keys other than a literal or `Symbol.for('...')`, functions that
 * read `arguments`, `super`, `new.target` or their own name, and a loop key
 * that is reassigned or shadowed are all left as written.
 *
 * Text in, text out, like the other transforms in this directory.
 */

interface Install {
  readonly statement: ts.Statement
  readonly members: readonly string[]
}

const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression

const isObjectMember = (expression: ts.Expression, member: string): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === 'Object' &&
  expression.name.text === member

/** `C.prototype` for the class named `className`. */
const isPrototypeOf = (expression: ts.Expression, className: string): boolean => {
  const target = unwrap(expression)
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'prototype' &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === className
  )
}

const isClassName = (expression: ts.Expression, className: string): boolean => {
  const target = unwrap(expression)
  return ts.isIdentifier(target) && target.text === className
}

/** Whether a function body reads something a class member would answer differently. */
const readsFunctionIdentity = (fn: ts.FunctionExpression | ts.MethodDeclaration): boolean => {
  const ownName = ts.isFunctionExpression(fn) ? fn.name?.text : undefined
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)) found = true
    else if (ts.isIdentifier(node) && (node.text === 'arguments' || (ownName !== undefined && node.text === ownName))) found = true
    // A nested ordinary function has its own `arguments` and `new.target`.
    else if (!(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)))
      ts.forEachChild(node, visit)
  }
  if (fn.body) ts.forEachChild(fn.body, visit)
  for (const parameter of fn.parameters) visit(parameter)
  return found
}

/**
 * The function text with every read of the loop key replaced by its literal,
 * or `null` when the key is written or shadowed anywhere inside.
 */
const substituted = (
  node: ts.Node,
  file: ts.SourceFile,
  key: { readonly name: string; readonly literal: string; readonly read: string } | null
): string | null => {
  const text = node.getText(file)
  if (key === null) return text
  const start = node.getStart(file)
  const edits: { readonly at: number; readonly end: number; readonly text: string }[] = []
  let refused = false
  const visit = (current: ts.Node): void => {
    if (refused) return
    if (ts.isIdentifier(current) && current.text === key.name) {
      const parent = current.parent
      const declares =
        (ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isClassLike(parent) ||
          ts.isBindingElement(parent)) &&
        parent.name === current
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current) ||
        ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === current)
      if (declares || ts.isShorthandPropertyAssignment(parent)) refused = true
      else if (
        ts.isBinaryExpression(parent) &&
        parent.left === current &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        refused = true
      else if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === current) refused = true
      else if (!isMemberName) {
        // As an element key the literal names the member it reads; anywhere
        // else it keeps the loop's `string` type.
        const keyed = ts.isElementAccessExpression(parent) && parent.argumentExpression === current
        edits.push({ at: current.getStart(file) - start, end: current.end - start, text: keyed ? key.literal : key.read })
      }
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  if (refused) return null
  let out = text
  for (const edit of [...edits].reverse()) out = out.slice(0, edit.at) + edit.text + out.slice(edit.end)
  return out
}

const memberNameText = (key: string): string => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : `[${JSON.stringify(key)}]`)

/** A `Symbol.for('...')` key's text, or `null`. */
const registeredSymbolKey = (expression: ts.Expression, file: ts.SourceFile): string | null => {
  const key = unwrap(expression)
  if (!ts.isCallExpression(key) || key.arguments.length !== 1 || !ts.isStringLiteralLike(key.arguments[0]!)) return null
  const callee = key.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null
  return callee.expression.text === 'Symbol' && callee.name.text === 'for' ? key.getText(file) : null
}

/** The descriptor's one function, as the class member it states. */
const memberFrom = (
  descriptor: ts.Expression,
  keyText: string,
  placement: 'prototype' | 'static',
  file: ts.SourceFile,
  loopKey: { readonly name: string; readonly literal: string; readonly read: string } | null
): string | null => {
  if (!ts.isObjectLiteralExpression(descriptor)) return null
  type Installed = { readonly kind: 'get' | 'value'; readonly node: ts.FunctionExpression | ts.MethodDeclaration }
  const functions: Installed[] = []
  const attributes = new Set<string>()
  for (const property of descriptor.properties) {
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null
    if (name === null) return null
    if (name === 'writable' || name === 'configurable' || name === 'enumerable') {
      if (!ts.isPropertyAssignment(property) || property.initializer.kind !== ts.SyntaxKind.TrueKeyword || attributes.has(name)) return null
      attributes.add(name)
      continue
    }
    if ((name !== 'get' && name !== 'value') || functions.length > 0) return null
    if (ts.isMethodDeclaration(property) && !property.asteriskToken && !property.questionToken)
      functions.push({ kind: name, node: property })
    else if (ts.isPropertyAssignment(property) && ts.isFunctionExpression(unwrap(property.initializer))) {
      const expression = unwrap(property.initializer) as ts.FunctionExpression
      if (expression.asteriskToken) return null
      functions.push({ kind: name, node: expression })
    } else return null
  }
  const fn = functions[0] ?? null
  if (fn === null || !fn.node.body || readsFunctionIdentity(fn.node)) return null
  if ((ts.getCombinedModifierFlags(fn.node as ts.Declaration) & ts.ModifierFlags.Async) !== 0) return null
  // Exactly the attributes the member form grants: a prototype getter or
  // method with none stated (see the module comment for the one difference),
  // a static method with `writable` and `configurable`.
  const expected = placement === 'static' ? ['configurable', 'writable'] : []
  if ([...attributes].sort().join() !== expected.join()) return null
  if (placement === 'static' && fn.kind !== 'value') return null
  if (fn.kind === 'get' && fn.node.parameters.length > 0) return null
  const parameters = fn.node.parameters.map((parameter) => substituted(parameter, file, loopKey))
  const body = substituted(fn.node.body, file, loopKey)
  if (body === null || parameters.some((parameter) => parameter === null)) return null
  const returnType = fn.node.type ? `: ${fn.node.type.getText(file)}` : ''
  const prefix = placement === 'static' ? 'static ' : ''
  return fn.kind === 'get'
    ? `${prefix}get ${keyText}()${returnType} ${body}`
    : `${prefix}${keyText}(${parameters.join(', ')})${returnType} ${body}`
}

/** One `Object.defineProperty(C.prototype | C, key, descriptor)` call as members, or `null`. */
const installMembers = (
  call: ts.Expression,
  className: string,
  file: ts.SourceFile,
  loopKey: { readonly name: string; readonly literal: string; readonly read: string } | null
): string | null => {
  if (!ts.isCallExpression(call) || !isObjectMember(call.expression, 'defineProperty') || call.arguments.length !== 3) return null
  const [target, key, descriptor] = call.arguments as unknown as readonly [ts.Expression, ts.Expression, ts.Expression]
  const placement = isPrototypeOf(target, className) ? 'prototype' : isClassName(target, className) ? 'static' : null
  if (placement === null) return null
  const keyNode = unwrap(key)
  let keyText: string | null = null
  if (ts.isStringLiteralLike(keyNode)) keyText = memberNameText(keyNode.text)
  else if (loopKey !== null && ts.isIdentifier(keyNode) && keyNode.text === loopKey.name)
    keyText = memberNameText(JSON.parse(loopKey.literal))
  else if (placement === 'prototype') {
    const registered = registeredSymbolKey(keyNode, file)
    keyText = registered === null ? null : `[${registered}]`
  }
  // A static member named `prototype`, `name` or `length` is not an ordinary method.
  if (keyText === null || (placement === 'static' && ['prototype', 'name', 'length'].includes(keyText))) return null
  return memberFrom(unwrap(descriptor), keyText, placement, file, loopKey)
}

/** A top-level statement that installs members onto `className`, or `null`. */
const installOf = (statement: ts.Statement, className: string, file: ts.SourceFile): Install | null => {
  if (!ts.isExpressionStatement(statement)) return null
  const expression = statement.expression
  const direct = installMembers(expression, className, file, null)
  if (direct !== null) return { statement, members: [direct] }
  // `[...literals].forEach((k) => { <one install> })`
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return null
  const callee = expression.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'forEach') return null
  const list = unwrap(callee.expression)
  if (!ts.isArrayLiteralExpression(list) || list.elements.length === 0 || !list.elements.every(ts.isStringLiteralLike)) return null
  const arrow = unwrap(expression.arguments[0]!)
  if (!ts.isArrowFunction(arrow) || arrow.parameters.length !== 1 || arrow.modifiers?.length) return null
  const parameter = arrow.parameters[0]!
  if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return null
  let inner: ts.Expression
  if (ts.isBlock(arrow.body)) {
    const [only, ...rest] = arrow.body.statements
    if (!only || rest.length > 0 || !ts.isExpressionStatement(only)) return null
    inner = only.expression
  } else inner = arrow.body
  const members: string[] = []
  for (const element of list.elements as ts.NodeArray<ts.StringLiteralLike>) {
    const literal = JSON.stringify(element.text)
    // The key was a `string` in the loop; a bare literal would narrow every
    // comparison against it into a no-overlap type error.
    const read = /\.[cm]?tsx?$/.test(file.fileName) && !file.isDeclarationFile ? `(${literal} as string)` : literal
    const member = installMembers(inner, className, file, { name: parameter.name.text, literal, read })
    if (member === null) return null
    members.push(member)
  }
  return { statement, members }
}

/** Whether evaluating `statement` can reach program code: any call or construction outside a nested function. */
const statementRunsCode = (statement: ts.Statement): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDecorator(node)) {
      const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression
      // The standard constructors and the class's own prototype surgery run no program code.
      const standard =
        ts.isIdentifier(callee) && ['Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Symbol', 'Error', 'TypeError'].includes(callee.text)
      const surgery = ts.isCallExpression(node) && (isObjectMember(callee, 'setPrototypeOf') || isObjectMember(callee, 'freeze'))
      const registry = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Symbol'
      if (!standard && !surgery && !registry) {
        found = true
        return
      }
    }
    // A getter or a Proxy can run on any property read; only plain names are safe to read here.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = node.expression
      // `Base.prototype`, as the surgery reads it: a constructor's own
      // `prototype` is a data property, never a getter.
      const prototypeRead = ts.isPropertyAccessExpression(node) && ts.isIdentifier(root) && node.name.text === 'prototype'
      if (
        !(ts.isIdentifier(root) && ['Object', 'Symbol', 'globalThis', 'global'].includes(root.text)) &&
        !ts.isPropertyAccessExpression(root) &&
        !prototypeRead
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(statement)
  return found
}

/** Every read of `className.prototype` in the file, outside `installs` and `Object.setPrototypeOf(C.prototype, ...)`. */
const prototypeEscapes = (file: ts.SourceFile, className: string, installs: ReadonlySet<ts.Statement>): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || (ts.isStatement(node) && installs.has(node))) return
    if (ts.isCallExpression(node) && isObjectMember(node.expression, 'setPrototypeOf') && node.arguments.length === 2) {
      if (isPrototypeOf(node.arguments[0]!, className) || isClassName(node.arguments[0]!, className)) {
        ts.forEachChild(node.arguments[1]!, visit)
        return
      }
    }
    if (isPrototypeOf(node as ts.Expression, className) && ts.isPropertyAccessExpression(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

export const prototypeInstallSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!input.text.includes('defineProperty')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  const statements = file.statements
  statements.forEach((statement, index) => {
    if (!ts.isClassDeclaration(statement) || !statement.name || statement.heritageClauses?.length) return
    if (ts.getDecorators(statement)?.length || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      return
    const className = statement.name.text
    const installs: Install[] = []
    for (const following of statements.slice(index + 1)) {
      const install = installOf(following, className, file)
      if (install !== null) {
        installs.push(install)
        continue
      }
      if (ts.isEmptyStatement(following)) continue
      // Past this point the class may be observed, so no later install moves.
      if (statementRunsCode(following)) break
    }
    if (installs.length === 0) return
    const installed = new Set(installs.map((install) => install.statement))
    if (prototypeEscapes(file, className, installed)) return
    // A member the class already declares would be redefined by the install;
    // two members of one name are not what the program means.
    const declared = new Set(
      statement.members.flatMap((member) =>
        member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? [member.name.text] : []
      )
    )
    const members = installs.flatMap((install) => install.members)
    const names = members.map((member) => /^(?:static )?(?:get )?([A-Za-z_$][\w$]*)\(/.exec(member)?.[1] ?? null)
    if (names.some((name) => name !== null && declared.has(name))) return
    if (new Set(members).size !== members.length) return
    for (const install of installs) edits.push({ start: install.statement.getStart(file), end: install.statement.end, text: ';' })
    const close = statement.members.end
    edits.push({ start: close, end: close, text: `\n${members.join('\n')}\n` })
  })
  if (edits.length === 0) return null
  let rewritten = input.text
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  return rewritten
}
