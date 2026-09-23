import ts from 'typescript'

/**
 * Which value-position names resolve to no binding anywhere in the program.
 *
 * `typeof Float16Array !== 'undefined' && array instanceof Float16Array` --
 * three's `WebGLAttributes.js:24`, and the same shape for `XRWebGLBinding`,
 * `XRWebGLLayer` and `__THREE_DEVTOOLS__` -- names a global no declaration in
 * this program introduces and no host declares. `getSymbolAtLocation` returns
 * `undefined` for it, so there is no cell for `GetValue` to read and no
 * `binding` operation any producer could mint, exactly as for the magic
 * `arguments` binding.
 *
 * This is the same shape of fact as `arguments-objects.ts` and exists for the
 * same reason: a question only the checker can answer, asked once here so a
 * syntactic layer downstream can consult it without one.
 * `producers/references.ts` PUBLISHES an unresolvable name's value and
 * `citeExpressionResult` PREDICTS the result that publication carries -- and
 * the two disagreeing is not an error anywhere, only a withheld citation that
 * silently takes its consumers with it. That is precisely what happened: the
 * producer published a Reference Record and no read, the predictor predicted a
 * read, and every `typeof`/`instanceof` feature-detection guard in three.js
 * was withheld along with the operations around it.
 *
 * ⛔ This census states only that a name has NO CELL. It says nothing about
 * whether a branch guarded on that name is dead -- that is
 * `dead-typeof-guards.ts`, whose warrant is a HOST'S STATEMENT about a global
 * it declares absent, and which must not be widened to rest on an inference
 * this compiler drew from a missing declaration.
 */
export interface UnresolvableNameCensus {
  /** Whether a value-position name here resolves to no binding at all. */
  readonly hasNoCell: (node: ts.Node) => boolean
  /** Whether this is TypeScript's declarationless intrinsic `globalThis` symbol. */
  readonly isIntrinsicGlobalThis: (node: ts.Node) => boolean
  /** How many such names this census found, for measurement. */
  readonly count: number
}

/** A census that finds nothing, for callers that state no program. */
export const emptyUnresolvableNameCensus: UnresolvableNameCensus = {
  hasNoCell: () => false,
  isIntrinsicGlobalThis: () => false,
  count: 0
}

/**
 * The symbol a name in value position resolves to.
 *
 * For a shorthand property (`{ durationMs }`) the name is doing two jobs at
 * once -- it is the property key AND a reference to the local binding of the
 * same name -- and `getSymbolAtLocation` answers with the property symbol,
 * which has no value cell. `getShorthandAssignmentValueSymbol` is the
 * checker's own answer to the second job, so asking it is a citation rather
 * than a repair: the value symbol is the local `durationMs`, exactly as it
 * would be had the source spelled `{ durationMs: durationMs }`.
 *
 * Owned here rather than in `producers/references.ts` (its only other reader)
 * so that the producer and this census cannot answer "does this name resolve"
 * two different ways. One rule, one place.
 */
export const valueSymbolAt = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined => {
  const parent = node.parent
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return checker.getShorthandAssignmentValueSymbol(parent) ?? checker.getSymbolAtLocation(node)
  }
  const symbol = checker.getSymbolAtLocation(node)
  return symbol && ts.isIdentifier(node) ? (lexicalSymbolBehindExportSynthesis(checker, node, symbol) ?? symbol) : symbol
}

/**
 * Whether a symbol is the checker's module-shape bookkeeping rather than a
 * lexical binding: the `Assignment`/`ModuleExports` synthesis, an `Alias` that
 * `exports.x = f` declares by its own target expression, or the file's module
 * symbol. A lexical binding is declared by a declaration node; these are
 * declared by expressions or by the source file itself.
 */
const isExportSynthesis = (symbol: ts.Symbol): boolean => {
  if ((symbol.flags & (ts.SymbolFlags.Assignment | ts.SymbolFlags.ModuleExports)) !== 0) return true
  const declarations = symbol.declarations ?? []
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        ts.isSourceFile(declaration) ||
        ts.isPropertyAccessExpression(declaration) ||
        ts.isElementAccessExpression(declaration) ||
        ts.isBinaryExpression(declaration)
    )
  )
}

/**
 * Checked JavaScript: the checker binds the `module` of `module.exports = f`
 * (and the `exports` of `exports.x = ...`) to the FILE's own synthetic
 * `export=` symbol -- an `Assignment` symbol whose declarations are the
 * assignment itself, or an `Alias | Assignment` onto `f` when `f` is a
 * function or class -- not to whatever the identifier resolves to lexically.
 * That synthesis is the checker's module-shape bookkeeping; a value cell is
 * a question about the lexical declaration, and for these names that is
 * Node's wrapper parameter, declared by the host. The scope chain of a
 * JavaScript file still answers with the file's `ModuleExports` symbol, so
 * when it does the global scope is asked directly. Null when the checker's
 * answer was not that synthesis, or nothing lexical declares the name.
 */
const lexicalSymbolBehindExportSynthesis = (checker: ts.TypeChecker, node: ts.Identifier, symbol: ts.Symbol): ts.Symbol | null => {
  if (!isExportSynthesis(symbol)) return null
  if ((symbol.declarations ?? []).some((declaration) => ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) return null
  const scoped = checker.resolveName(node.text, node, ts.SymbolFlags.Value, false)
  const lexical =
    scoped !== undefined && !isExportSynthesis(scoped) ? scoped : checker.resolveName(node.text, undefined, ts.SymbolFlags.Value, false)
  return lexical ?? null
}

/**
 * Whether every declaration of `symbol` is an ambient, initializer-less
 * `var` whose declared type is the type query `typeof globalThis`. A
 * declaration with an initializer, or a non-ambient one, allocates its own
 * cell and stays a binding; a type other than the singleton's own says the
 * value merely resembles it.
 */
/**
 * Whether `node` sits in an ambient context: a declaration file, or under a
 * `declare` modifier on itself or an enclosing statement/namespace (`declare
 * global { var global: typeof globalThis }` puts the modifier on the block,
 * not the `var`). The checker's own `Ambient` node flag is internal API.
 */
const isInAmbientContext = (node: ts.Node): boolean => {
  if (node.getSourceFile().isDeclarationFile) return true
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.canHaveModifiers(current) && (ts.getCombinedModifierFlags(current as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0)
      return true
  }
  return false
}

const isAmbientAliasOfGlobalThis = (symbol: ts.Symbol): boolean => {
  const declarations = symbol.declarations ?? []
  if (declarations.length === 0) return false
  return declarations.every(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === undefined &&
      isInAmbientContext(declaration) &&
      declaration.type !== undefined &&
      ts.isTypeQueryNode(declaration.type) &&
      ts.isIdentifier(declaration.type.exprName) &&
      declaration.type.exprName.text === 'globalThis'
  )
}

export const censusUnresolvableNames = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): UnresolvableNameCensus => {
  const withoutCell = new Set<ts.Node>()
  const intrinsicGlobalThis = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    // Only identifiers, and only where one could denote a binding at all. A
    // type position, a property key and a declaration's own name all resolve
    // through machinery that has nothing to do with a value cell, and asking
    // about them would put nodes in this set that no reference producer ever
    // reaches.
    if (ts.isIdentifier(node) && !ts.isTypeReferenceNode(node.parent)) {
      const symbol = valueSymbolAt(checker, node)
      if (symbol === undefined) withoutCell.add(node)
      // TypeScript creates `globalThis` as a synthetic value symbol whose own
      // declaration list is empty. It is neither an unresolvable name nor an
      // ambient cell a host can define. Record that checker fact once so the
      // reference producer and every citation predictor agree on the direct
      // value result it publishes. A program binding named `globalThis` has a
      // declaration and therefore stays an ordinary binding.
      else if (node.text === 'globalThis' && symbol.name === 'globalThis' && (symbol.declarations?.length ?? 0) === 0) {
        intrinsicGlobalThis.add(node)
      }
      // Node's `global` (and any other name a declaration file spells as
      // `declare var x: typeof globalThis` with no initializer) is the SAME
      // singleton, not a second cell: ECMA-262 9.3 gives a realm exactly one
      // global object, and an ambient `var` typed as THE type of that object,
      // with nothing to initialize it, states that it is that object under
      // another name -- `@types/node`'s own spelling is precisely this. Read
      // as an ordinary ambient binding it becomes an `extern` the emitter
      // expects a host to define, and no host does: `@hono/node-server`'s
      // `global.Request !== LightweightRequest` linked against an undefined
      // `_global`. So the alias publishes the same direct value result the
      // intrinsic does, and every consumer (the reference producer, the
      // global-host-mutation census) sees one object.
      // A declaration's own name is where the alias is SPELLED, not a read
      // of the object; counting it would make the ambient `var` itself look
      // like the global object escaping into a binding.
      else if (!(ts.isVariableDeclaration(node.parent) && node.parent.name === node) && isAmbientAliasOfGlobalThis(symbol)) {
        intrinsicGlobalThis.add(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
  return {
    hasNoCell: (node) => withoutCell.has(node),
    isIntrinsicGlobalThis: (node) => intrinsicGlobalThis.has(node),
    count: withoutCell.size
  }
}
