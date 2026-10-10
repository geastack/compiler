import ts from 'typescript'

/**
 * `Owner.prototype.m.call(this, ...args)` inside a class that is NOT `Owner`
 * -- a program class's method borrowed onto an instance of an unrelated class
 * -- rewritten to `this.<copy>(...args)` against a copy of `m`'s declaration
 * placed in the calling class.
 *
 * The measured shape: a case-insensitive `URLSearchParams` subclass that
 * normalizes keys with `LowerCaseMap.prototype._normalizeKey.call(this, name)`,
 * where `LowerCaseMap` is an unrelated `Map` subclass whose body iterates
 * `this.keys()`. Compiled once, that body is `LowerCaseMap`'s:
 * its `this` is a `Map` subclass's layout and `this.keys()` is `Map`'s, so no
 * conversion makes a `URLSearchParams` instance its receiver
 * (`conversion/nodes.ts`'s foreign-receiver reason). The language, though,
 * only ever runs the body on the receiver it is given: every `this.x` inside
 * it is looked up on THAT object. A copy of the body compiled as the calling
 * class's own method is exactly that lookup, stated where the checker can
 * resolve it -- `this.keys()` becomes `URLSearchParams`'s.
 *
 * ## Why this is the receiver-specialized copy, and where it refuses
 *
 * The copy is ordinary source the checker then type-checks against the
 * receiver's class. So "every `this` member the body touches exists on the
 * receiver with a compatible type" is not re-derived here: it is the
 * checker's own verdict on the copy, and a body that does not fit is a
 * diagnostic on the copy rather than a body bound to the wrong layout.
 *
 * What the checker cannot see is that the copy still MEANS the original, and
 * those facts are the guard, each one leaving the call untouched (so the
 * compiler's own foreign-receiver refusal still names it) when it fails:
 *
 * - `Owner` is a class declared at the top level of this same file, and `m`
 *   is one non-static, non-overloaded method with a body there -- so the
 *   borrowed body is known, and nothing else in the file assigns
 *   `Owner.prototype.m` (which would make `.call` run something else).
 * - The body names no `super` (it would bind to the calling class's base)
 *   and no `#private` name (it would brand-check against `Owner`).
 * - `this` at the call is the calling class's own instance: the nearest
 *   non-arrow function around it is that class's method, accessor or
 *   constructor.
 * - The calling class is not `Owner` and does not name it in `extends`:
 *   there the call already binds `Owner`'s body directly.
 * - Every name the body reads resolves to the same declaration at the copy's
 *   new home: none is declared by a scope enclosing the calling class. The
 *   owner's own type parameters are replaced by their defaults (or
 *   constraints), since the calling class cannot name them; one with neither
 *   leaves the call untouched.
 */
export const borrowedMethodReceiverCopySourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!input.text.includes('.prototype.') || !input.text.includes('.call(this')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
  const owners = topLevelClassesOf(file)
  if (owners.size === 0) return null
  const reassigned = reassignedPrototypeMembersOf(file)
  const edits: { start: number; end: number; text: string }[] = []
  const injected = new Map<ts.ClassLikeDeclaration, Map<string, string>>()
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit)
    if (!ts.isCallExpression(node)) return
    const borrow = borrowOf(node)
    if (borrow === null) return
    const owner = owners.get(borrow.owner)
    if (owner === undefined || reassigned.has(`${borrow.owner}.${borrow.member}`)) return
    const method = borrowableMethodOf(owner, borrow.member)
    if (method === null) return
    const receiverClass = thisClassOf(node)
    if (receiverClass === null || receiverClass === owner || extendsName(receiverClass) === borrow.owner) return
    // A borrow nested in another's arguments was already rewritten; splicing
    // the outer one would re-insert the inner call's original text.
    if (edits.some((edit) => edit.start >= node.getStart(file) && edit.end <= node.getEnd())) return
    const copyText = copyTextOf(file, owner, method, receiverClass)
    if (copyText === null) return
    const copies = injected.get(receiverClass) ?? new Map<string, string>()
    const copyName = `__gea_borrowed_${borrow.owner}_${borrow.member}`
    if (receiverClass.members.some((member) => member.name !== undefined && ts.isIdentifier(member.name) && member.name.text === copyName))
      return
    const copy = oneLineMemberOf(`${copyName}${copyText}`)
    if (copy === null) return
    copies.set(copyName, copy)
    injected.set(receiverClass, copies)
    const argumentsText = node.arguments
      .slice(1)
      .map((argument) => argument.getText(file))
      .join(', ')
    edits.push({ start: node.getStart(file), end: node.getEnd(), text: `this.${copyName}(${argumentsText})` })
  }
  visit(file)
  if (edits.length === 0) return null
  for (const [receiverClass, copies] of injected) {
    const close = receiverClass.getEnd() - 1
    edits.push({ start: close, end: close, text: ` ${[...copies.values()].join(' ')} ` })
  }
  let rewritten = input.text
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}

/**
 * The copy printed on one line, comments dropped, so inserting it moves no
 * later line of the file: every diagnostic and row the compiler reports
 * against this file after the calling class keeps its line number. `null`
 * for a member whose text holds a raw line break a line join would change (a
 * multi-line template literal).
 */
const oneLineMemberOf = (member: string): string | null => {
  const holder = ts.createSourceFile('copy.ts', `class __gea_copy { ${member} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = holder.statements[0]
  const method = declaration !== undefined && ts.isClassDeclaration(declaration) ? declaration.members[0] : undefined
  if (method === undefined || declaration === undefined || !ts.isClassDeclaration(declaration) || declaration.members.length !== 1)
    return null
  let multiline = false
  const visit = (node: ts.Node): void => {
    if ((ts.isTemplateLiteralToken(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.getText(holder).includes('\n'))
      multiline = true
    ts.forEachChild(node, visit)
  }
  visit(method)
  if (multiline) return null
  const printed = ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, method, holder)
  return printed.replace(/\r?\n\s*/g, ' ')
}

const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const topLevelClassesOf = (file: ts.SourceFile): ReadonlyMap<string, ts.ClassDeclaration> => {
  const classes = new Map<string, ts.ClassDeclaration>()
  const duplicated = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue
    if (classes.has(statement.name.text)) duplicated.add(statement.name.text)
    classes.set(statement.name.text, statement)
  }
  for (const name of duplicated) classes.delete(name)
  return classes
}

/** `Owner.prototype.m` written anywhere as an assignment target. */
const reassignedPrototypeMembersOf = (file: ts.SourceFile): ReadonlySet<string> => {
  const written = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = prototypeMemberOf(node.left)
      if (target !== null) written.add(`${target.owner}.${target.member}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return written
}

const prototypeMemberOf = (expression: ts.Expression): { owner: string; member: string } | null => {
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)) return null
  const prototype = expression.expression
  if (!ts.isPropertyAccessExpression(prototype) || prototype.name.text !== 'prototype' || !ts.isIdentifier(prototype.expression))
    return null
  return { owner: prototype.expression.text, member: expression.name.text }
}

/** `Owner.prototype.m.call(this, ...)`, with a plain `this` and no spread. */
const borrowOf = (call: ts.CallExpression): { owner: string; member: string } | null => {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'call' || call.questionDotToken !== undefined) return null
  const target = prototypeMemberOf(callee.expression)
  if (target === null) return null
  const [thisArgument] = call.arguments
  if (thisArgument === undefined || thisArgument.kind !== ts.SyntaxKind.ThisKeyword) return null
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return null
  return target
}

const borrowableMethodOf = (owner: ts.ClassDeclaration, member: string): ts.MethodDeclaration | null => {
  const named = owner.members.filter(
    (candidate) => candidate.name !== undefined && ts.isIdentifier(candidate.name) && candidate.name.text === member
  )
  if (named.length !== 1) return null
  const method = named[0]!
  if (!ts.isMethodDeclaration(method) || method.body === undefined || method.asteriskToken !== undefined) return null
  if (ts.getCombinedModifierFlags(method) & (ts.ModifierFlags.Static | ts.ModifierFlags.Async | ts.ModifierFlags.Abstract)) return null
  let unsupported = false
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isPrivateIdentifier(node)) unsupported = true
    if (!unsupported) ts.forEachChild(node, visit)
  }
  visit(method)
  return unsupported ? null : method
}

/** The class whose instance `this` is at a node: the nearest non-arrow function must be one of its members. */
const thisClassOf = (node: ts.Node): ts.ClassLikeDeclaration | null => {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    if (ts.isClassStaticBlockDeclaration(current)) return null
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      if (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Static) return null
      return ts.isClassLike(current.parent) ? current.parent : null
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isSourceFile(current)) return null
  }
  return null
}

const extendsName = (declaration: ts.ClassLikeDeclaration): string | null => {
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    const base = clause.types[0]?.expression
    return base !== undefined && ts.isIdentifier(base) ? base.text : null
  }
  return null
}

/** Every name a node declares inside itself: parameters, locals, functions, classes, type parameters, catch bindings. */
const namesDeclaredWithin = (root: ts.Node): Set<string> => {
  const declared = new Set<string>()
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) bind(node.name)
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isFunctionExpression(node)) &&
      node.name
    )
      declared.add(node.name.text)
    else if (ts.isTypeParameterDeclaration(node)) declared.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return declared
}

/** Identifiers read as names (not as property keys) anywhere under a node. */
const referencedNamesOf = (root: ts.Node): Set<string> => {
  const referenced = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isKey =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertySignature(parent)) &&
          parent.name === node)
      if (!isKey) referenced.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return referenced
}

/** Names a scope enclosing `node` declares, from its nearest scope out to (not including) the file's top level. */
const enclosingDeclarationsOf = (node: ts.Node): Set<string> => {
  const declared = new Set<string>()
  const addStatements = (statements: ts.NodeArray<ts.Statement>): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) addBinding(declaration.name)
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
        declared.add(statement.name.text)
      else if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        statement.name
      )
        declared.add(statement.name.text)
    }
  }
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(element.name)
  }
  for (let current: ts.Node | undefined = node; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isClassLike(current) || ts.isFunctionLike(current)) {
      if (current.name !== undefined && ts.isIdentifier(current.name)) declared.add(current.name.text)
      for (const parameter of current.typeParameters ?? []) declared.add(parameter.name.text)
    }
    if (ts.isFunctionLike(current)) for (const parameter of current.parameters) addBinding(parameter.name)
    if (ts.isBlock(current) || ts.isModuleBlock(current)) addStatements(current.statements)
  }
  return declared
}

/**
 * The copy's text after its name -- `(params): R { body }` -- with the
 * owner's class type parameters replaced, or `null` when a replacement or a
 * name's resolution cannot be kept.
 */
const copyTextOf = (
  file: ts.SourceFile,
  owner: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
  receiverClass: ts.ClassLikeDeclaration
): string | null => {
  const replacements = new Map<string, string>()
  for (const parameter of owner.typeParameters ?? []) {
    const replacement = parameter.default ?? parameter.constraint
    if (replacement === undefined) return null
    replacements.set(parameter.name.text, replacement.getText(file))
  }
  const own = namesDeclaredWithin(method)
  const free = [...referencedNamesOf(method)].filter((name) => !own.has(name) && !replacements.has(name))
  const enclosing = enclosingDeclarationsOf(receiverClass)
  if (free.some((name) => enclosing.has(name))) return null
  // `NodeArray.pos` sits just past the `<` or `(` that opens it.
  const signatureStart = (method.typeParameters ?? method.parameters).pos - 1
  if (signatureStart < method.getStart(file)) return null
  const edits: { start: number; end: number; text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined) {
      const replacement = replacements.get(node.typeName.text)
      if (replacement !== undefined && !own.has(node.typeName.text)) {
        edits.push({ start: node.getStart(file), end: node.getEnd(), text: `(${replacement})` })
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(method)
  let text = file.text.slice(signatureStart, method.getEnd())
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start - signatureStart) + edit.text + text.slice(edit.end - signatureStart)
  }
  return text
}
