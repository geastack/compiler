import ts from 'typescript'

/**
 * An object literal a script uses only as a prototype, rewritten into the class
 * whose prototype it is.
 *
 * ## The shape
 *
 * `@hono/node-server`'s lightweight `Request` is a plain object of methods and
 * accessors, grown with `Object.defineProperty`, re-parented onto the global
 * `Request` and instantiated with `Object.create`:
 *
 *     const requestPrototype: Record<string | symbol, any> = { get method() {...}, [getRequestCache]() {...} }
 *     Object.defineProperty(requestPrototype, 'signal', { get() {...} })
 *     Object.setPrototypeOf(requestPrototype, Request.prototype)
 *     const req = Object.create(requestPrototype)
 *
 * The checker types that object as a dictionary and every instance as `any`,
 * so nothing downstream can see that the instances share one layout and one
 * set of members. A class states exactly that: its prototype holds the same
 * methods and accessors, `new C()` on a class with no constructor and no fields
 * is `Object.create(C.prototype)`, and the installs and the re-parenting then
 * read as the class forms `prototypeInstallSourceTransform` and
 * `prototype-reparenting.ts` already model.
 *
 * ## What the rewrite preserves, and what it does not
 *
 * - Every member keeps its text. A `this` that reads a member the class
 *   declares stays the class; every other `this` is read as `any`, as the
 *   literal's contextual `ThisType` typed it, so the symbol-keyed state the
 *   object gains at run time stays dynamic and the class states no storage.
 * - Instances stay `any` (`new C() as any`), as `Object.create` typed them.
 * - Literal members are enumerable where class members are not. The rewrite
 *   is only admitted when the object's name appears in nothing but
 *   `Object.defineProperty`, `Object.setPrototypeOf` and one-argument
 *   `Object.create` calls, so no enumeration of it can be observed.
 * - A literal with a data property, a spread, a shorthand, a `super` read, or
 *   `__proto__` is left as written, as is a name that is exported or
 *   declared twice in the file.
 *
 * ## Instances typed as the class, and the per-instance symbol slots that earns
 *
 * The paragraph above was the whole rewrite until this file also proved: when
 * every symbol-keyed slot the module writes onto a created instance -- from
 * inside the class's own members (`this[incomingKey]`) and from the site that
 * calls `Object.create` (`req[incomingKey] = incoming`, right after) -- names
 * a `const key = Symbol(...)` this file can see, the class declares a field
 * for each one (`[incomingKey]: T | undefined`, the same shape
 * `records.ts`'s declared-symbol-field dispatch already answers reads,
 * writes, `in` and `delete` for) and the instance keeps the class as its
 * static type instead of losing it to `Object.create`'s `any`. A dynamic
 * receiver over that same instance -- `(this as any)[key]` inside a getter,
 * or a helper function typed `Record<string | symbol, any>` -- still reaches
 * the declared field rather than a side-table entry, so this file does not
 * need to also rewrite those internal reads; only the instance's own static
 * type, and the fields that let dropping `any` still type-check, are new.
 *
 * A slot's declared type is read from what this file can prove locally, with
 * no checker: a parameter's own annotation, a `new X(...)`, a literal, or a
 * same-file function's explicit return type. Whatever cannot be proven that
 * way is `unknown` on that one field -- honest, and safe, because every read
 * this file leaves untouched is already behind an `any`-shaped receiver.
 *
 * The rewrite backs out of typing the instance -- keeping today's `any` --
 * the moment `Object.create`'s result is not a plain `const`/assigned
 * identifier, or anything reachable from that identifier writes or reads a
 * member this file cannot attribute to either a declared name or a `Symbol`
 * constant: an unrecognized shape must fail closed rather than emit a class
 * that does not cover everything the module does to it.
 */

const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const isObjectMember = (expression: ts.Expression, member: string): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  expression.expression.text === 'Object' &&
  expression.name.text === member

const readsSuper = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.SuperKeyword || (ts.forEachChild(node, readsSuper) ?? false)

/** The member names the class will declare: the literal's own and every install's. */
interface Declared {
  readonly names: ReadonlySet<string>
  /** Computed keys named by a plain identifier (`[getRequestCache]() {...}`). */
  readonly computed: ReadonlySet<string>
}

/**
 * Whether a `this` stays the class: a read of a member the class declares
 * resolves on it exactly as it did on the literal. Every other `this` -- a
 * key the object only gains at run time, or the receiver passed on as a
 * value -- is read as `any`, which is what the literal's `ThisType` gave it.
 */
const staysTyped = (node: ts.Node, declared: Declared): boolean => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return declared.names.has(parent.name.text)
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const key = parent.argumentExpression
    if (ts.isStringLiteralLike(key)) return declared.names.has(key.text)
    return ts.isIdentifier(key) && declared.computed.has(key.text)
  }
  return false
}

/**
 * A member's text with every `this` it binds that does not stay the class
 * read as `any` (see `staysTyped`). Nested ordinary functions and classes
 * bind their own `this` and are left alone.
 */
const memberTextOf = (member: ts.ObjectLiteralElementLike, file: ts.SourceFile, declared: Declared | null): string => {
  const text = member.getText(file)
  if (declared === null) return text
  const start = member.getStart(file)
  const at: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node) || ts.isObjectLiteralElementLike(node))
      if (node !== member) return
    if (node.kind === ts.SyntaxKind.ThisKeyword && !staysTyped(node, declared)) at.push(node.getStart(file) - start)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(member, visit)
  let out = text
  for (const offset of at.reverse()) out = `${out.slice(0, offset)}(this as any)${out.slice(offset + 'this'.length)}`
  return out
}

/** Where each `this` a descriptor's own functions bind, and that does not stay the class, sits in the file. */
const receiverOffsetsIn = (descriptor: ts.Expression, file: ts.SourceFile, declared: Declared): number[] => {
  const offsets: number[] = []
  const visit = (node: ts.Node, bound: boolean): void => {
    if (ts.isFunctionDeclaration(node) || ts.isClassLike(node)) return
    // A function that is the descriptor's own `get`/`value` binds the receiver; any other ordinary function binds its own.
    if (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      const owned = ts.isPropertyAssignment(node.parent) ? node.parent.parent === descriptor : node.parent === descriptor
      if (!owned) return
      ts.forEachChild(node, (child) => visit(child, true))
      return
    }
    if (bound && node.kind === ts.SyntaxKind.ThisKeyword && !staysTyped(node, declared)) offsets.push(node.getStart(file))
    ts.forEachChild(node, (child) => visit(child, bound))
  }
  visit(descriptor, false)
  return offsets
}

/** The names a literal and its installs declare. */
const declaredOf = (literal: ts.ObjectLiteralExpression, installs: readonly ts.CallExpression[]): Declared => {
  const names = new Set<string>()
  const computed = new Set<string>()
  for (const property of literal.properties) {
    const name = property.name
    if (name === undefined) continue
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.add(name.text)
    else if (ts.isComputedPropertyName(name) && ts.isIdentifier(name.expression)) computed.add(name.expression.text)
  }
  for (const call of installs) {
    const key = call.arguments[1]
    if (key === undefined) continue
    if (ts.isStringLiteralLike(key)) names.add(key.text)
    else if (ts.isIdentifier(key)) {
      // `[...literals].forEach((k) => Object.defineProperty(P, k, ...))`
      let arrow: ts.Node = call
      while (!ts.isArrowFunction(arrow) && !ts.isSourceFile(arrow)) arrow = arrow.parent
      const loop = arrow.parent
      if (ts.isArrowFunction(arrow) && ts.isCallExpression(loop) && ts.isPropertyAccessExpression(loop.expression)) {
        const list = loop.expression.expression
        if (ts.isArrayLiteralExpression(list))
          for (const element of list.elements) if (ts.isStringLiteralLike(element)) names.add(element.text)
      }
    }
  }
  return { names, computed }
}

/** A name declared exactly `const NAME = Symbol(...)` -- usable as a computed class member name. */
const symbolConstNamesIn = (file: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'Symbol' &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    )
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/** A same-file `function NAME(...): T` or `const NAME = (...): T => ...`'s explicit return-type text, by name. */
const declaredReturnTypesIn = (file: ts.SourceFile): ReadonlyMap<string, string> => {
  const types = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.type) types.set(node.name.text, node.type.getText(file))
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.type
    )
      types.set(node.name.text, node.initializer.type.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return types
}

/** The value an element-access write assigns, or `null` when the access is not the target of `=`/`||=`/`??=`/`&&=`. */
const writeRhsOf = (elementAccess: ts.ElementAccessExpression): ts.Expression | null => {
  const parent = elementAccess.parent
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === elementAccess &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken)
  )
    return parent.right
  return null
}

/** Every `<root>[identifier]` this file finds within a subtree, and the value assigned at each write. */
interface ElementKeyScan {
  readonly keys: ReadonlySet<string>
  readonly writes: ReadonlyMap<string, readonly ts.Expression[]>
}

const emptyScan = (): { keys: Set<string>; writes: Map<string, ts.Expression[]> } => ({ keys: new Set(), writes: new Map() })

/** Records one `root[key]` use, skipping a key called as a method (`root[key](...)`) -- that is a member read, not a data slot. */
const recordElementKeyUse = (
  scan: { keys: Set<string>; writes: Map<string, ts.Expression[]> },
  access: ts.ElementAccessExpression
): void => {
  const arg = access.argumentExpression
  if (!ts.isIdentifier(arg)) return
  const parent = access.parent
  if (ts.isCallExpression(parent) && parent.expression === access) return
  scan.keys.add(arg.text)
  const rhs = writeRhsOf(access)
  if (rhs) {
    const list = scan.writes.get(arg.text) ?? []
    list.push(rhs)
    scan.writes.set(arg.text, list)
  }
}

/** Every `this[identifier]` a literal member's own body reaches -- nested functions/classes bind their own `this` and are skipped. */
const thisElementAccessScanIn = (member: ts.ObjectLiteralElementLike): ElementKeyScan => {
  const scan = emptyScan()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node) || ts.isObjectLiteralElementLike(node))
      if (node !== member) return
    if (node.kind === ts.SyntaxKind.ThisKeyword && ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
      recordElementKeyUse(scan, node.parent)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(member, visit)
  return scan
}

/** Every `this[identifier]` an install descriptor's own `get`/`set`/`value` function reaches (mirrors `receiverOffsetsIn`'s bound tracking). */
const thisElementAccessScanInDescriptor = (descriptor: ts.Expression): ElementKeyScan => {
  const scan = emptyScan()
  const visit = (node: ts.Node, bound: boolean): void => {
    if (ts.isFunctionDeclaration(node) || ts.isClassLike(node)) return
    if (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
      const owned = ts.isPropertyAssignment(node.parent) ? node.parent.parent === descriptor : node.parent === descriptor
      if (!owned) return
      ts.forEachChild(node, (child) => visit(child, true))
      return
    }
    if (bound && node.kind === ts.SyntaxKind.ThisKeyword && ts.isElementAccessExpression(node.parent) && node.parent.expression === node)
      recordElementKeyUse(scan, node.parent)
    ts.forEachChild(node, (child) => visit(child, bound))
  }
  visit(descriptor, false)
  return scan
}

const mergeScans = (scans: readonly ElementKeyScan[]): { keys: Set<string>; writes: Map<string, ts.Expression[]> } => {
  const merged = emptyScan()
  for (const scan of scans) {
    for (const key of scan.keys) merged.keys.add(key)
    for (const [key, exprs] of scan.writes) {
      const list = merged.writes.get(key) ?? []
      list.push(...exprs)
      merged.writes.set(key, list)
    }
  }
  return merged
}

/** The nearest enclosing function (or the file itself) a node sits in -- the scope a `const x = Object.create(...)` result is live in. */
const enclosingScopeOf = (node: ts.Node): ts.Node => {
  let scope: ts.Node = node
  while (
    !ts.isSourceFile(scope) &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope)
  )
    scope = scope.parent
  return scope
}

/**
 * Every use of `varName` in `scope`: an element/property access must resolve to a name the class
 * already declares or a `Symbol` constant this file can turn into a field, or `allResolved` is
 * `false` -- the signal to keep `Object.create`'s instance untyped rather than emit a class that
 * does not cover something the module does to it.
 */
const scanVariableUses = (
  scope: ts.Node,
  varName: string,
  declared: Declared,
  symbolConsts: ReadonlySet<string>
): ElementKeyScan & { readonly allResolved: boolean } => {
  const scan = emptyScan()
  let allResolved = true
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === varName) {
      const parent = node.parent
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const arg = parent.argumentExpression
        if (ts.isStringLiteralLike(arg)) {
          if (!declared.names.has(arg.text)) allResolved = false
        } else if (ts.isIdentifier(arg)) {
          if (!declared.computed.has(arg.text) && !symbolConsts.has(arg.text)) allResolved = false
          else recordElementKeyUse(scan, parent)
        } else allResolved = false
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node && !declared.names.has(parent.name.text))
        allResolved = false
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return { ...scan, allResolved }
}

/** The best-effort static type of an expression assigned to a data-slot field, from local syntax alone -- `null` when not confidently known. */
const syntacticTypeOf = (expr: ts.Expression, file: ts.SourceFile, returnTypes: ReadonlyMap<string, string>): string | null => {
  if (ts.isParenthesizedExpression(expr)) return syntacticTypeOf(expr.expression, file, returnTypes)
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return 'boolean'
  if (ts.isStringLiteralLike(expr)) return 'string'
  if (ts.isNumericLiteral(expr)) return 'number'
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return returnTypes.get(expr.expression.text) ?? null
  if (ts.isIdentifier(expr)) {
    if (expr.text === 'undefined') return null
    for (let node: ts.Node = expr; !ts.isSourceFile(node); node = node.parent) {
      const parent = node.parent
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent)
      )
        for (const p of parent.parameters) if (ts.isIdentifier(p.name) && p.name.text === expr.text && p.type) return p.type.getText(file)
    }
  }
  return null
}

/** A data-slot field's declared type: the union of every write this file can attribute a type to, or `unknown` when none can be. */
const fieldTypeOf = (writes: readonly ts.Expression[], file: ts.SourceFile, returnTypes: ReadonlyMap<string, string>): string => {
  const texts = new Set<string>()
  for (const write of writes) {
    const type = syntacticTypeOf(write, file, returnTypes)
    if (type) texts.add(type)
  }
  return texts.size === 0 ? 'unknown' : [...texts].join(' | ')
}

/** The literal's members as class member texts, or `null` when one has no class form. */
const classMembersOf = (literal: ts.ObjectLiteralExpression, file: ts.SourceFile, declared: Declared | null): string[] | null => {
  const members: string[] = []
  for (const property of literal.properties) {
    if (!(ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property))) return null
    const name = property.name
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === '__proto__') return null
    if (readsSuper(property)) return null
    members.push(memberTextOf(property, file, declared))
  }
  return members
}

type Use = { readonly kind: 'target'; readonly node: ts.Identifier } | { readonly kind: 'create'; readonly node: ts.CallExpression }

const isCreateUse = (use: Use): use is { readonly kind: 'create'; readonly node: ts.CallExpression } => use.kind === 'create'

/** The identifier a `const NAME = Object.create(...)` or `NAME = Object.create(...)` binds its result to, or `null` for any other shape. */
const boundNameOf = (call: ts.CallExpression): string | null => {
  const parent = call.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left))
    return parent.left.text
  return null
}

/**
 * The fields to declare on the class for the symbol-keyed slots the module writes on its
 * instances, and whether every such write is attributable -- the gate for typing the instance as
 * the class instead of `Object.create`'s `any`. `declared === null` (an untyped `.js` file) always
 * answers no fields and no gate, matching this rewrite's existing untyped behaviour.
 */
const instanceTypingOf = (
  file: ts.SourceFile,
  literal: ts.ObjectLiteralExpression,
  installs: readonly ts.CallExpression[],
  createUses: readonly ts.CallExpression[],
  declared: Declared | null,
  symbolConsts: ReadonlySet<string>,
  returnTypes: ReadonlyMap<string, string>
): { readonly fieldMembers: readonly string[]; readonly instantiationIsTyped: boolean } => {
  if (declared === null) return { fieldMembers: [], instantiationIsTyped: false }
  const memberScans = [
    ...literal.properties.map((member) => thisElementAccessScanIn(member)),
    ...installs.flatMap((call) => (call.arguments[2] ? [thisElementAccessScanInDescriptor(call.arguments[2])] : []))
  ]
  let instantiationIsTyped = createUses.length > 0
  const instanceScans: ElementKeyScan[] = []
  for (const call of createUses) {
    const varName = boundNameOf(call)
    if (varName === null) {
      instantiationIsTyped = false
      continue
    }
    const scan = scanVariableUses(enclosingScopeOf(call), varName, declared, symbolConsts)
    if (!scan.allResolved) instantiationIsTyped = false
    instanceScans.push(scan)
  }
  const merged = mergeScans([...memberScans, ...instanceScans])
  const dataSlotNames = [...merged.keys].filter((key) => symbolConsts.has(key) && !declared.names.has(key) && !declared.computed.has(key))
  const fieldMembers = dataSlotNames.map((key) => `[${key}]: ${fieldTypeOf(merged.writes.get(key) ?? [], file, returnTypes)} | undefined`)
  return { fieldMembers, instantiationIsTyped }
}

/** Every use of `name` in the file, or `null` when one is not a prototype-surgery argument. */
const usesOf = (file: ts.SourceFile, name: string, declaration: ts.VariableDeclaration): Use[] | null => {
  const uses: Use[] = []
  let refused = false
  const visit = (node: ts.Node): void => {
    if (refused || node === declaration.name) return
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isAccessor(parent)) && parent.name === node)
      if (isMemberName) return
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === node &&
        ((isObjectMember(parent.expression, 'defineProperty') && parent.arguments.length === 3) ||
          (isObjectMember(parent.expression, 'setPrototypeOf') && parent.arguments.length === 2))
      )
        uses.push({ kind: 'target', node })
      else if (ts.isCallExpression(parent) && isObjectMember(parent.expression, 'create') && parent.arguments.length === 1)
        uses.push({ kind: 'create', node: parent })
      else refused = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return refused ? null : uses
}

export const prototypeObjectClassSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!input.text.includes('Object.create') || !input.text.includes('setPrototypeOf')) return null
  const kind = scriptKindOf(input.fileName)
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, kind)
  const typed = kind === ts.ScriptKind.TS || kind === ts.ScriptKind.TSX
  const symbolConsts = typed ? symbolConstNamesIn(file) : new Set<string>()
  const returnTypes = typed ? declaredReturnTypesIn(file) : new Map<string, string>()
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || statement.modifiers?.length) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0 || statement.declarationList.declarations.length !== 1) continue
    const declaration = statement.declarationList.declarations[0]!
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue
    const name = declaration.name.text
    const uses = usesOf(file, name, declaration)
    if (uses === null || !uses.some((use) => use.kind === 'create')) continue
    const installs = uses.flatMap((use) =>
      use.kind === 'target' && isObjectMember((use.node.parent as ts.CallExpression).expression, 'defineProperty')
        ? [use.node.parent as ts.CallExpression]
        : []
    )
    const declared = typed ? declaredOf(declaration.initializer, installs) : null
    const members = classMembersOf(declaration.initializer, file, declared)
    if (members === null || members.length === 0) continue
    const createUses = uses.filter(isCreateUse).map((use) => use.node)
    const { fieldMembers, instantiationIsTyped } = instanceTypingOf(
      file,
      declaration.initializer,
      installs,
      createUses,
      declared,
      symbolConsts,
      returnTypes
    )
    const classMembers = [...members, ...fieldMembers]
    edits.push({ start: statement.getStart(file), end: statement.end, text: `class ${name} {\n${classMembers.join('\n')}\n}` })
    for (const use of uses) {
      if (use.kind === 'target' && declared !== null) {
        // The descriptor's functions become members of the class too
        // (`prototypeInstallSourceTransform`); their `this` reads the same way.
        const call = use.node.parent as ts.CallExpression
        const descriptor = call.arguments[2]
        if (descriptor)
          for (const offset of receiverOffsetsIn(descriptor, file, declared))
            edits.push({ start: offset, end: offset + 4, text: '(this as any)' })
      }
      if (use.kind === 'target') edits.push({ start: use.node.getStart(file), end: use.node.end, text: `${name}.prototype` })
      else
        edits.push({
          start: use.node.getStart(file),
          end: use.node.end,
          text: !typed || instantiationIsTyped ? `new ${name}()` : `(new ${name}() as any)`
        })
    }
  }
  if (edits.length === 0) return null
  let rewritten = input.text
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  return rewritten
}
