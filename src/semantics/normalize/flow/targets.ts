import ts from 'typescript'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { literalMemberNameOf } from '../derived-expression-type.js'
import type { FlowTarget, ValueFlowIndex } from './model.js'
import type { ProgramReachability } from '../reachability.js'

/**
 * Resolving an expression to the storage cell it NAMES -- the one place that
 * question is answered.
 *
 * Before this, each census carried its own copy: `collection-bindings.ts`'s
 * `ownerDeclOfExpr`, `object-bag-bindings.ts`'s same-named twin,
 * `field-bindings.ts`'s inline `checker.getSymbolAtLocation(node.left)`,
 * `local-bindings.ts`'s `declarationOf`. They disagreed in ways nobody
 * intended: two of them read a property access's `.name`, one read the access
 * itself, and those are not the same symbol (see `FlowTarget`).
 */

/** The stable, reference-independent key: a symbol's first declaration node. */
const declarationOf = (symbol: ts.Symbol | null): ts.Node | null => symbol?.getDeclarations()?.[0] ?? null

/** Export-list aliases do not appear as expression references in value flow.
 * Ask the module's resolved export identities before claiming local closure. */
export const isModuleExportedDeclaration = (checker: ts.TypeChecker, declaration: ts.Declaration, symbol: ts.Symbol | null): boolean => {
  const module = checker.getSymbolAtLocation(declaration.getSourceFile())
  if (!module) return false
  return checker.getExportsOfModule(module).some((exported) => {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported
    return target === symbol || (target.declarations?.includes(declaration) ?? false)
  })
}

/** A symbol that is a source module itself -- what a namespace import binds. */
const isSourceModuleSymbol = (symbol: ts.Symbol | undefined): symbol is ts.Symbol =>
  symbol !== undefined &&
  (symbol.flags & ts.SymbolFlags.ValueModule) !== 0 &&
  (symbol.declarations?.some((declaration) => ts.isSourceFile(declaration) && !declaration.isDeclarationFile) ?? false)

/**
 * The source module whose namespace object `expression` names, or `null`.
 *
 * A namespace import (`import * as dns`) is the direct spelling, but the same
 * immutable object reaches a program through ANY alias chain ending at the
 * module: `import { NS } from 'lib'` where the package index does `import * as
 * NS from './ns'; export { NS }`, and `dns.promises` where a `dns` module
 * re-exports `import * as promises from './dns/promises'`. The
 * checker resolves every such chain to the module symbol, so the module
 * symbol -- not the spelling of the last hop -- is the authority. A module
 * namespace is a path: a member read off it is that export's own binding
 * (`namespaceMemberDeclarationOf`, `properties.ts`'s resolved binding), and no
 * cell ever holds the object itself.
 */
export const moduleNamespaceOf = (checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | null => {
  const named = unwrapNaming(expression)
  if (ts.isIdentifier(named)) {
    const binding = checker.getSymbolAtLocation(named)
    if (!binding || (binding.flags & ts.SymbolFlags.Alias) === 0) return null
    const module = resolveAlias(checker, binding)
    return isSourceModuleSymbol(module) ? module : null
  }
  if (!ts.isPropertyAccessExpression(named) || !ts.isIdentifier(named.name)) return null
  if (moduleNamespaceOf(checker, named.expression) === null) return null
  const member = resolveAlias(checker, checker.getSymbolAtLocation(named.name))
  return isSourceModuleSymbol(member) ? member : null
}

/**
 * The exports a module-namespace read under a computed key may select, one per
 * string literal the key's type admits, or `null`.
 *
 * `crypto[method]` with `method: 'createCipheriv' | 'createDecipheriv'`: the
 * checker closed the key to a finite set of names, so the `[[Get]]` on the
 * namespace object (ECMA-262 10.4.6.8) answers with one of exactly these
 * exports' bindings. `null` unless every admitted literal is a string naming a
 * value export -- a key type that also admits `string`, a number or a symbol
 * leaves a key this closed set cannot answer. The one authority both the
 * reachability walk (which exports stay live) and the property producer (which
 * cells the read selects between) consult.
 */
export const namespaceMembersUnderClosedKeyOf = (
  checker: ts.TypeChecker,
  access: ts.ElementAccessExpression
): readonly { readonly key: string; readonly member: ts.Symbol }[] | null => {
  if (moduleNamespaceOf(checker, access.expression) === null) return null
  const keyType = checker.getTypeAtLocation(access.argumentExpression)
  const literals = keyType.isUnion() ? keyType.types : [keyType]
  const namespaceType = checker.getTypeAtLocation(access.expression)
  const members: { key: string; member: ts.Symbol }[] = []
  for (const literal of literals) {
    if (!literal.isStringLiteral()) return null
    const member = checker.getPropertyOfType(namespaceType, literal.value)
    if (!member || ((resolveAlias(checker, member)?.flags ?? 0) & ts.SymbolFlags.Value) === 0) return null
    members.push({ key: literal.value, member })
  }
  return members.length > 0 ? members : null
}

/** An immutable module-namespace selection, authenticated by the import
 * binding and the module's export symbol. A mutable object with the same
 * checker shape is deliberately not a namespace authority. */
export const namespaceMemberDeclarationOf = (checker: ts.TypeChecker, expression: ts.Expression): ts.Declaration | null => {
  const selected = unwrapNaming(expression)
  if (!ts.isPropertyAccessExpression(selected) && !ts.isElementAccessExpression(selected)) return null
  const receiver = unwrapNaming(selected.expression)
  const module = moduleNamespaceOf(checker, receiver)
  if (!module) return null
  const key = ts.isPropertyAccessExpression(selected)
    ? selected.name.text
    : ts.isStringLiteral(selected.argumentExpression)
      ? selected.argumentExpression.text
      : null
  if (key === null) return null
  const exported = checker.getExportsOfModule(module).find((symbol) => symbol.name === key)
  const named = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), key)
  const target = exported ? resolveAlias(checker, exported) : null
  if (!target || !named || resolveAlias(checker, named) !== target) return null
  return target.valueDeclaration ?? target.declarations?.[0] ?? null
}

/** Erased wrappers name the same storage as their evaluated expression. */
export const unwrapNaming = (expression: ts.Expression): ts.Expression => unwrapErasedExpression(expression)

/**
 * The cell `expression` names, or `null` when it names none this layer can
 * resolve. A plain identifier, a property access, and a bracket access with a
 * LITERAL key (a named member spelled the other way) are the three shapes;
 * anything else -- a call result, a computed index, a literal -- names no
 * persistent storage location and is deliberately not guessed at.
 */
export const flowTargetOf = (checker: ts.TypeChecker, expression: ts.Expression): FlowTarget | null => {
  const current = unwrapNaming(expression)
  if (ts.isIdentifier(current)) {
    // `{ a }` -- as a shorthand object-literal VALUE (`{ val: { a } }`) or as
    // a shorthand assignment-pattern TARGET (`({ a } = source)`) -- names the
    // cell `a` reads or writes, not a property of the literal. Ordinary
    // `getSymbolAtLocation` on the shorthand's own name resolves a distinct,
    // synthetic PROPERTY symbol whose declaration happens to print the same
    // text but is not `===` the variable's own symbol object -- confirmed
    // empirically: `var a; ({ a } = ...)` gives two different `ts.Symbol`s
    // for `a`'s `VariableDeclaration` name and the shorthand's name, even
    // though `checker.getShorthandAssignmentValueSymbol` (the API TypeScript
    // ships for exactly this) returns the variable's own symbol for both.
    // Without this, a destructuring-assignment write to a shorthand target
    // is filed under a symbol `writesToSymbol` never sees queried, and the
    // cell looks unwritten to every consumer of this index.
    if (ts.isShorthandPropertyAssignment(current.parent) && current.parent.name === current) {
      const symbol = checker.getShorthandAssignmentValueSymbol(current.parent) ?? null
      if (!symbol) return null
      return { symbol, nameSymbol: symbol, declaration: declarationOf(symbol) }
    }
    const symbol = checker.getSymbolAtLocation(current) ?? null
    if (!symbol) return null
    return { symbol, nameSymbol: symbol, declaration: declarationOf(symbol) }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const symbol = checker.getSymbolAtLocation(current) ?? null
    const nameSymbol = checker.getSymbolAtLocation(current.name) ?? null
    if (!symbol && !nameSymbol) return null
    return { symbol, nameSymbol, declaration: declarationOf(nameSymbol ?? symbol) }
  }
  if (ts.isElementAccessExpression(current)) {
    const key = literalMemberNameOf(current)
    if (key === null) return null
    // The checker can leave the whole bracket expression symbol-less while
    // resolving its literal member on the receiver. Keep that write attached
    // to the same cell as `object.member`, including namespace exports.
    const symbol =
      checker.getSymbolAtLocation(current) ?? checker.getPropertyOfType(checker.getTypeAtLocation(current.expression), key) ?? null
    if (!symbol) return null
    return { symbol, nameSymbol: symbol, declaration: declarationOf(symbol) }
  }
  return null
}

/**
 * The function-like declaration whose return cell a `return` statement fills
 * -- the nearest enclosing one, stopping at the boundary every census that
 * reads returns already stops at (a class body owns no returns, and a nested
 * function owns its own).
 */
export const returnOwnerOf = (statement: ts.ReturnStatement): ts.SignatureDeclaration | null => {
  for (let current: ts.Node | undefined = statement.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current) || ts.isSourceFile(current)) return null
    if (ts.isFunctionLike(current)) return current
  }
  return null
}

/**
 * The callee declaration a call reaches, when the checker resolves it to one
 * -- the same resolution `parameter-bindings.ts` records as
 * `checkerAttribution`. `null` for an unresolvable or ambient callee, whose
 * parameter slots are a host-boundary question, not this layer's.
 */
export const calleeDeclarationOf = (
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression
): ts.SignatureDeclaration | null => {
  return callableDeclarationOfExpression(checker, call.expression)
}

/** The source callable named by a value, independent of invocation syntax. */
export const callableDeclarationOfExpression = (checker: ts.TypeChecker, callee: ts.Expression): ts.SignatureDeclaration | null => {
  const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee
  const symbol = resolveAlias(checker, checker.getSymbolAtLocation(name))
  const declaration = symbol?.valueDeclaration ?? symbol?.getDeclarations()?.[0]
  if (!declaration) return null
  const callable = callableValueOf(declaration)
  // ⛔ `ts.isFunctionLike` is not the test. It admits a `JSDocFunctionType`
  // (`@param {function(string): void}`) and a `JSDocSignature`, whose
  // "parameters" are `ParameterDeclaration` nodes with NO `name` at all --
  // a shape `ts.isIdentifier` crashes on rather than rejecting, and a slot
  // with no name is no slot. Real library JSDoc carries such annotations.
  if (!callable) return null
  return callable.getSourceFile().isDeclarationFile ? null : callable
}

/**
 * An imported name and the function it names are ONE callable, so a call
 * through the import must reach the same parameter slots a call in the
 * declaring module does.
 *
 * Without this, `checker.getSymbolAtLocation` at a cross-module call site
 * answers with the local ALIAS symbol, whose only declaration is the
 * `ImportSpecifier` -- not a callable, so the callee resolved to nothing and
 * every argument written at that call reached no slot. Measured on a large JS
 * library: dozens of unannotated parameters were refused for want of exactly these edges,
 * with the argument types sitting right there at the call. `getAliasedSymbol`
 * THROWS for a non-alias rather than answering, so the flag is tested first.
 */
const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
  let current = symbol
  for (let depth = 0; current && (current.flags & ts.SymbolFlags.Alias) !== 0 && depth < 8; depth += 1) {
    const aliased = checker.getAliasedSymbol(current)
    if (!aliased || aliased === current) return current
    current = aliased
  }
  return current
}

export { resolveAlias as resolveFlowSymbolAlias }

/**
 * The callable a declaration node's VALUE is, following the one hop that
 * separates a name from the function it holds.
 *
 * `function f() {}` declares the callable directly, but `const f = ( x ) =>
 * ...`, `{ f: function ( x ) { ... } }` and `class C { f = ( x ) => ... }`
 * declare a CELL whose initializer is the callable -- and the cell's own
 * declaration node is not a signature, so a resolution stopping there reports
 * no callee at all. Measured on a large JS library: a dozen unannotated
 * parameters refused purely because their callback was passed to a function spelled the second
 * way. `nameOfCallable` (`derived-expression-type.ts`) already draws the same
 * equivalence from the other direction -- it names a function expression by
 * the variable or property that holds it -- so this is that fact asked
 * forwards rather than a new one.
 *
 * Only an initializer written IN PLACE qualifies. A cell filled from
 * elsewhere (`const f = pick( ... )`, a later assignment) can hold different
 * callables at different times, and picking one would be a guess; those are
 * the transitive question `callable-reach.ts` answers with a closure proof,
 * not something to settle here.
 */
const callableValueOf = (declaration: ts.Node): ts.SignatureDeclaration | null => {
  if (isRealCallableDeclaration(declaration)) return declaration
  const initializer =
    ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration)
      ? declaration.initializer
      : undefined
  if (initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))) return initializer
  return null
}

/** The syntactic function forms whose parameters are real, named slots. */
export const isRealCallableDeclaration = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isFunctionTypeNode(node) ||
  ts.isConstructorTypeNode(node) ||
  ts.isMethodSignature(node) ||
  ts.isConstructSignatureDeclaration(node) ||
  ts.isCallSignatureDeclaration(node)

/**
 * Whether a reference to a callable's name stands in a TYPE position, where
 * nothing can call or construct through it.
 *
 * A class is named by its constructor's own name, so every `x: Foo`
 * annotation is a reference to the same symbol `new Foo(...)` reaches --
 * and the escape test, which asks "does anything hold this function as a
 * VALUE", counted those annotations as holders. A generic class referenced by its
 * own field annotation is the case: `#req: Request<P, I['out']> | undefined`
 * made its constructor's parameters unbindable, which left `matchResult:
 * Result<[unknown, Route]>` at its annotation while the only caller passes a
 * `Result<[H, Route]>` -- two carriers for one cell, reconcilable
 * only by rebuilding the arrays inside it.
 *
 * A type annotation constructs nothing. Anything that does needs a VALUE
 * reference, and every one of those is still counted here -- an `extends`
 * clause included, whose reference is an expression and not a type node.
 */
export const isTypePositionReference = (reference: ts.Node): boolean => {
  const parent = reference.parent
  if (!parent) return false
  if (ts.isTypeReferenceNode(parent)) return parent.typeName === reference
  if (ts.isTypeQueryNode(parent)) return parent.exprName === reference
  if (ts.isQualifiedName(parent)) return isTypePositionReference(parent)
  return false
}

/**
 * The application's complete module set, as the CALLER stated it by compiling
 * a module graph (`ProgramInput.statedModuleSet`). A project's `include` glob
 * says what a typechecker may look at, not what the application is, so
 * without this statement no export can be claimed unimported.
 */
export interface StatedModuleSet {
  /** Every implementation module of the program. */
  readonly files: readonly ts.SourceFile[]
  /** Modules evaluated from outside the program; their exports are its public surface. */
  readonly entries: readonly ts.SourceFile[]
  /**
   * What of `files` the program actually runs. `files` is every module the
   * checker loaded; a mention outside this reads nothing. Absent, every
   * statement counts.
   */
  readonly reachable?: ProgramReachability
}

const statedModuleSets = new WeakMap<ValueFlowIndex, StatedModuleSet>()
export const attachStatedModuleSet = (flow: ValueFlowIndex, modules: StatedModuleSet): void => {
  statedModuleSets.set(flow, modules)
}
/** The module set the caller stated for this flow round, or null when none was. */
export const statedModuleSetOf = (flow: ValueFlowIndex): StatedModuleSet | null => statedModuleSets.get(flow) ?? null

/** Caller-stated complete classic-script lexical realm, independent of ESM exports. */
export interface ClosedScriptScope {
  readonly files: ReadonlySet<ts.SourceFile>
}

const closedScriptScopes = new WeakMap<ValueFlowIndex, ClosedScriptScope>()
export const attachClosedScriptScope = (flow: ValueFlowIndex, scope: ClosedScriptScope): void => {
  const known = closedScriptScopes.get(flow)
  if (known !== undefined && known !== scope) throw new Error('A value-flow round cannot change its script lexical boundary')
  closedScriptScopes.set(flow, scope)
}
export const closedScriptScopeOf = (flow: ValueFlowIndex): ClosedScriptScope | null => closedScriptScopes.get(flow) ?? null

interface ModuleExposure {
  /** Some module reference could not be resolved to anything at all. */
  readonly opaque: boolean
  /** Declarations some import, re-export, namespace or entry surface reaches. */
  readonly exposed: ReadonlySet<ts.Symbol>
  /** Last path segments of module specifiers that resolved to no module. */
  readonly unresolved: ReadonlySet<string>
  readonly files: ReadonlySet<ts.SourceFile>
  readonly entries: ReadonlySet<ts.SourceFile>
}

const exposures = new WeakMap<StatedModuleSet, ModuleExposure>()
const lastSegment = (path: string): string => path.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
const DYNAMIC_MODULE_REFERENCE = /\bimport\s*\(|\brequire\s*\(/

/** One pass over every module's import surface, shared by every flow round
 * that carries the same stated module set. */
const moduleExposureOf = (checker: ts.TypeChecker, modules: StatedModuleSet): ModuleExposure => {
  const known = exposures.get(modules)
  if (known) return known
  const exposed = new Set<ts.Symbol>()
  const unresolved = new Set<string>()
  let opaque = false
  const expose = (symbol: ts.Symbol | undefined): void => {
    const target = resolveAlias(checker, symbol)
    // An alias chain that does not bottom out within the depth bound is not
    // an answer; nothing can be claimed unimported against it.
    if (!target || (target.flags & ts.SymbolFlags.Alias) !== 0) opaque = true
    else exposed.add(target)
  }
  const exposeModule = (module: ts.Symbol | undefined): void => {
    if (!module) return
    for (const exported of checker.getExportsOfModule(module)) expose(exported)
  }
  // A namespace import, `export *`, `import()` or `require` exposes the whole
  // module object. A specifier that resolves to nothing is remembered by its
  // last segment, and an unwritten one is opaque.
  const exposeModuleAt = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      opaque = true
      return
    }
    const module = checker.getSymbolAtLocation(specifier)
    if (module) exposeModule(module)
    else unresolved.add(lastSegment(specifier.text))
  }
  const dynamic = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      exposeModuleAt(node.arguments[0])
    ts.forEachChild(node, dynamic)
  }
  for (const file of modules.files) {
    if (file.isDeclarationFile) continue
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (!clause || clause.isTypeOnly) continue
        if (clause.name) expose(checker.getSymbolAtLocation(clause.name))
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) exposeModuleAt(statement.moduleSpecifier)
        else if (bindings)
          for (const element of bindings.elements) if (!element.isTypeOnly) expose(checker.getSymbolAtLocation(element.name))
      } else if (ts.isExportDeclaration(statement)) {
        // A local export list is the export itself, not a use of it.
        if (!statement.moduleSpecifier || statement.isTypeOnly) continue
        const clause = statement.exportClause
        if (!clause || ts.isNamespaceExport(clause)) exposeModuleAt(statement.moduleSpecifier)
        else for (const element of clause.elements) if (!element.isTypeOnly) expose(checker.getExportSpecifierLocalTargetSymbol(element))
      } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        exposeModuleAt(statement.moduleReference.expression)
      }
    }
    if (DYNAMIC_MODULE_REFERENCE.test(file.text)) ts.forEachChild(file, dynamic)
  }
  for (const entry of modules.entries) exposeModule(checker.getSymbolAtLocation(entry))
  const exposure: ModuleExposure = { opaque, exposed, unresolved, files: new Set(modules.files), entries: new Set(modules.entries) }
  exposures.set(modules, exposure)
  return exposure
}

/**
 * Whether NOTHING in the program imports this export.
 *
 * `export { Lists, List }` closes a library's `Lists.js`, but only one other
 * module imports anything from it, and only `Lists`. An export list is not an expression, so
 * value flow records no use for it, and `isModuleExportedDeclaration` has to
 * treat every exported declaration as published to unknown code. Inside a
 * stated module set that is too coarse: an export no import, re-export,
 * namespace, dynamic `import()`/`require`, or entry surface reaches is
 * unreachable from any code at all.
 *
 * True only when the module set is stated, the file is an ES module of that
 * set and not an entry, and every module reference in the program resolved;
 * anything else answers false.
 */
export const exportIsUnimported = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  specifierOrDeclaration: ts.ExportSpecifier | ts.Declaration
): boolean => {
  const modules = statedModuleSets.get(flow)
  if (!modules) return false
  const file = specifierOrDeclaration.getSourceFile()
  // A file that also assigns `module.exports` publishes through CommonJS too.
  if (file.isDeclarationFile || !ts.isExternalModule(file) || (file as { commonJsModuleIndicator?: ts.Node }).commonJsModuleIndicator)
    return false
  const exposure = moduleExposureOf(checker, modules)
  if (exposure.opaque || !exposure.files.has(file) || exposure.entries.has(file)) return false
  const segment = lastSegment(file.fileName)
  if (
    exposure.unresolved.has(segment) ||
    (segment === 'index' && exposure.unresolved.has(lastSegment(file.fileName.replace(/[\\/][^\\/]*$/, ''))))
  )
    return false
  const name = ts.isExportSpecifier(specifierOrDeclaration) ? null : ts.getNameOfDeclaration(specifierOrDeclaration)
  const symbol = ts.isExportSpecifier(specifierOrDeclaration)
    ? checker.getExportSpecifierLocalTargetSymbol(specifierOrDeclaration)
    : name
      ? checker.getSymbolAtLocation(name)
      : undefined
  const target = resolveAlias(checker, symbol)
  if (!target || (target.flags & ts.SymbolFlags.Alias) !== 0) return false
  return !exposure.exposed.has(target)
}

/** Executable argument positions exclude the erased TypeScript receiver declaration. */
export const runtimeParametersOf = (declaration: ts.Node): readonly ts.ParameterDeclaration[] =>
  isRealCallableDeclaration(declaration)
    ? declaration.parameters.filter((parameter) => !ts.isIdentifier(parameter.name) || parameter.name.text !== 'this')
    : []
