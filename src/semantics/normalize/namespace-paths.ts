import ts from 'typescript'

/**
 * Which expressions name a source `namespace` -- a PATH -- rather than a value.
 *
 * `namespace Debug { export function assert(...) {...}; export let level = 0 }`
 * followed by `Debug.assert(x)` / `Debug.level = 2` is, in TypeScript's own
 * semantics, a QUALIFIED NAME: the checker resolves `Debug.assert` straight to
 * the member's declaration, exactly as it resolves a bare `assert` written
 * inside the namespace body. At run time the JS emit does allocate an object
 * and install the exports on it, but that object is an artifact of the emit
 * target, not a fact of the program: nothing the program can write depends on
 * its identity, and a native C++ namespace has no object at all.
 *
 * Reading `Debug` as a VALUE is what broke TypeScript's own compiler. The
 * checker types the namespace as a record whose fields are its exports, and a
 * generic export (`checkDefined<T>(value: T | undefined): T`) puts an OPEN
 * type parameter into that record. Every `Debug.*` site then selected a
 * carrier with a hole in it -- 2,811 "type parameter reached representation
 * without monomorphization" rows from one namespace, at sites that never
 * instantiate anything -- and even a namespace with no generics at all failed
 * at emission, because no producer ever introduces a cell for `Debug`
 * (`binding-external`).
 *
 * So a namespace is modelled the way host namespaces already are
 * (`host-protocols.ts`'s `hostNamespaceRoots`: "a name in here is a path,
 * never a value"): `Debug` in `Debug.x` is no reference at all, `Debug.x` is
 * the member's own binding reference -- the same `reference`/`binding` pair
 * `references.ts` publishes for an identifier, cited by the same
 * `citeExpressionResult` rule -- and `Debug.log.trace` walks the path one
 * segment further. A namespace import (`import * as ts`) may ROOT such a path
 * (`ts.Debug.loggingHost = ...` in tsc.ts), but a plain member of the import
 * (`ts.foo`) keeps its existing `resolvedBinding` property get: only paths that
 * pass through a source namespace are this census's business.
 *
 * Asked once here, with the checker, so the syntactic layers downstream --
 * `census.ts`'s family rule and `citeExpressionResult`'s prediction of it --
 * read ONE answer. Those two disagreeing is not an error anywhere, only a
 * withheld citation that silently takes its consumers with it.
 *
 * Deliberately NOT a path: a namespace merged with a function, class, enum or
 * variable (`function f() {}; namespace f { export const x = 1 }`) -- there the
 * exports really are properties on a runtime object -- and anything ambient,
 * which `host-protocols.ts` owns.
 */
export interface NamespacePathCensus {
  /** Whether this expression names a source namespace, i.e. is a path and never a value. */
  readonly isPath: (node: ts.Node) => boolean
  /**
   * The member symbol a `Ns.member` property access names as a qualified
   * binding, or `null` when the access is not one (an ordinary property, a
   * path segment naming a nested namespace, a name that resolves to no value).
   */
  readonly memberSymbolOf: (node: ts.Node) => ts.Symbol | null
}

/** A census that finds nothing, for callers that state no program. */
export const emptyNamespacePathCensus: NamespacePathCensus = {
  isPath: () => false,
  memberSymbolOf: () => null
}

const resolveAlias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

const isAmbient = (declaration: ts.Declaration): boolean => {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * A symbol that is a source namespace and nothing else: instantiated
 * (`ValueModule` -- a namespace holding only types is never in value position),
 * every value-bearing declaration a non-ambient `namespace X` block in a
 * source file, and merged with no function/class/enum/variable.
 *
 * A type alias or interface merged with the namespace (`type State = <T>(...)
 * => number; namespace State { export function enter ... }`, the
 * callable-type-plus-statics idiom, `test/runtime/generic-state-function-array.ts`)
 * is erased: it contributes no runtime value, so the namespace is still
 * nothing but a path. Requiring EVERY declaration to be a module block made
 * `State` a value here, and a value nothing ever produces is the `Debug`
 * failure above -- every `State.enter` read refused as `binding-external`.
 */
const isSourceNamespace = (checker: ts.TypeChecker, symbol: ts.Symbol): boolean => {
  const resolved = resolveAlias(checker, symbol)
  if ((resolved.flags & ts.SymbolFlags.ValueModule) === 0) return false
  if ((resolved.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function | ts.SymbolFlags.Enum | ts.SymbolFlags.Variable)) !== 0)
    return false
  const declarations = resolved.getDeclarations()
  if (!declarations || declarations.length === 0) return false
  return (
    declarations.some(ts.isModuleDeclaration) &&
    declarations.every(
      (declaration) =>
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isInterfaceDeclaration(declaration) ||
        (ts.isModuleDeclaration(declaration) &&
          ts.isIdentifier(declaration.name) &&
          !declaration.getSourceFile().isDeclarationFile &&
          !isAmbient(declaration))
    )
  )
}

const isNamespaceImportName = (checker: ts.TypeChecker, node: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(node)
  return symbol?.declarations?.some((declaration) => ts.isNamespaceImport(declaration)) ?? false
}

export const censusNamespacePaths = (checker: ts.TypeChecker): NamespacePathCensus => {
  const paths = new WeakMap<ts.Node, boolean>()
  const members = new WeakMap<ts.Node, ts.Symbol | null>()

  const isPath = (node: ts.Node): boolean => {
    const known = paths.get(node)
    if (known !== undefined) return known
    const answer = computePath(node)
    paths.set(node, answer)
    return answer
  }

  /** A path, or the namespace import that may root one. */
  const isPathRoot = (node: ts.Node): boolean => isPath(node) || (ts.isIdentifier(node) && isNamespaceImportName(checker, node))

  const computePath = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      return symbol !== undefined && isSourceNamespace(checker, symbol)
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      if (!isPathRoot(node.expression)) return false
      const symbol = checker.getSymbolAtLocation(node.name)
      return symbol !== undefined && isSourceNamespace(checker, symbol)
    }
    return false
  }

  const memberSymbolOf = (node: ts.Node): ts.Symbol | null => {
    const known = members.get(node)
    if (known !== undefined) return known
    const answer = computeMember(node)
    members.set(node, answer)
    return answer
  }

  const computeMember = (node: ts.Node): ts.Symbol | null => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.name)) return null
    // Through a SOURCE namespace, not merely a namespace import: `ts.foo` is
    // `properties.ts`'s own `resolvedBinding` shape and stays that way.
    if (!isPath(node.expression)) return null
    const symbol = checker.getSymbolAtLocation(node.name)
    if (!symbol) return null
    const resolved = resolveAlias(checker, symbol)
    // A nested namespace is one more path segment, not a member with a cell.
    if (isSourceNamespace(checker, resolved)) return null
    if ((resolved.flags & ts.SymbolFlags.Value) === 0) return null
    const declarations = resolved.getDeclarations()
    if (!declarations || declarations.length === 0) return null
    if (declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile || isAmbient(declaration))) return null
    return symbol
  }

  return { isPath, memberSymbolOf }
}
