import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { isTypePositionReference, resolveFlowSymbolAlias, statedModuleSetOf, type StatedModuleSet } from './targets.js'
import { nodeIsReachable } from '../reachability.js'

/**
 * Every in-program reference an exported binding reaches, or null when its
 * exposure is not closed.
 *
 * `exportIsUnimported` closes an export nobody imports. Three's
 * `WebGLRenderLists.js` is the case it cannot: `WebGLRenderer.js` imports
 * `WebGLRenderLists` and calls it once, and that is the only module that does
 * -- the same holds for `WebGLState`, `WebGLProperties`, `WebGLExtensions`. An
 * import is not an escape; it is a set of references the importer spells, and
 * inside a stated module set every one of them is enumerable. What is NOT
 * enumerable is a module object handed to code this layer cannot follow, an
 * `export *` or re-export chain that reaches an entry module's surface, or a
 * dynamic `import()`/`require` -- each makes the binding reachable by code
 * outside the program, and each answers null here.
 */

/** A static module reference that names some module, as its importer spells it. */
interface ModuleEdge {
  readonly file: ts.SourceFile
  readonly declaration: ts.ImportDeclaration | ts.ExportDeclaration
}

interface ImportGraph {
  /** Some dynamic module reference names no module this layer can state. */
  readonly opaque: boolean
  /** Last path segments of static specifiers that resolved to no module. */
  readonly unresolved: ReadonlySet<string>
  /** Modules reached by `import()`, `require` or `import x = require()`. */
  readonly dynamic: ReadonlySet<ts.Symbol>
  readonly edges: ReadonlyMap<ts.Symbol, readonly ModuleEdge[]>
  readonly files: ReadonlySet<ts.SourceFile>
  readonly entries: ReadonlySet<ts.SourceFile>
  /** Identifier mentions per file and symbol, built once per importing file. */
  readonly mentions: Map<ts.SourceFile, Map<ts.Symbol, ts.Identifier[]>>
}

const graphs = new WeakMap<StatedModuleSet, ImportGraph>()
const lastSegment = (path: string): string => path.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
const DYNAMIC_MODULE_REFERENCE = /\bimport\s*\(|\brequire\s*\(/

const importGraphOf = (checker: ts.TypeChecker, modules: StatedModuleSet): ImportGraph => {
  const known = graphs.get(modules)
  if (known) return known
  const edges = new Map<ts.Symbol, ModuleEdge[]>()
  const dynamic = new Set<ts.Symbol>()
  const unresolved = new Set<string>()
  let opaque = false
  const moduleAt = (specifier: ts.Expression | undefined): ts.Symbol | null => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      opaque = true
      return null
    }
    const module = checker.getSymbolAtLocation(specifier)
    if (!module) unresolved.add(lastSegment(specifier.text))
    return module ?? null
  }
  const dynamicAt = (specifier: ts.Expression | undefined): void => {
    const module = moduleAt(specifier)
    if (module) dynamic.add(module)
  }
  const scan = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      dynamicAt(node.arguments[0])
    ts.forEachChild(node, scan)
  }
  for (const file of modules.files) {
    if (file.isDeclarationFile) continue
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)) {
        const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly
        const module = moduleAt(statement.moduleSpecifier)
        if (!module || typeOnly) continue
        const list = edges.get(module) ?? []
        list.push({ file, declaration: statement })
        edges.set(module, list)
      } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        dynamicAt(statement.moduleReference.expression)
      }
    }
    if (DYNAMIC_MODULE_REFERENCE.test(file.text)) ts.forEachChild(file, scan)
  }
  const graph: ImportGraph = {
    opaque,
    unresolved,
    dynamic,
    edges,
    files: new Set(modules.files),
    entries: new Set(modules.entries),
    mentions: new Map()
  }
  graphs.set(modules, graph)
  return graph
}

/** Every identifier in `file` the checker resolves to `symbol`. */
const mentionsOf = (checker: ts.TypeChecker, graph: ImportGraph, file: ts.SourceFile, symbol: ts.Symbol): readonly ts.Identifier[] => {
  let index = graph.mentions.get(file)
  if (!index) {
    const built = new Map<ts.Symbol, ts.Identifier[]>()
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const resolved =
          ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node)
        if (resolved) {
          const list = built.get(resolved) ?? []
          list.push(node)
          built.set(resolved, list)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    graph.mentions.set(file, (index = built))
  }
  return index.get(symbol) ?? []
}

/** A mention that constructs, calls or reads nothing. */
const typeOnlyMention = (reference: ts.Identifier): boolean =>
  isTypePositionReference(reference) || ts.isTypeQueryNode(reference.parent) || ts.isImportTypeNode(reference.parent)

const exportedSymbolOf = (checker: ts.TypeChecker, specifierOrDeclaration: ts.ExportSpecifier | ts.Declaration): ts.Symbol | undefined => {
  if (ts.isExportSpecifier(specifierOrDeclaration)) return checker.getExportSpecifierLocalTargetSymbol(specifierOrDeclaration)
  const name = ts.getNameOfDeclaration(specifierOrDeclaration)
  return name ? checker.getSymbolAtLocation(name) : undefined
}

/**
 * Every in-program mention of the import bindings that name this export -- an
 * importer's local identifier, or `ns.name` for a namespace import whose
 * every use selects a member -- or null when any path could expose the
 * binding to code outside the compiled program.
 *
 * Null (open) when: the module set is unstated; the declaring file is not an
 * ES module of the set, is CommonJS, or is an entry; some dynamic module
 * reference is non-literal; the module (or any module re-exporting the
 * binding) is reached by `import()`/`require`/`import = require`, is an
 * entry, or matches an unresolved specifier; a namespace import of such a
 * module is used other than by static member selection; `export * as ns`
 * re-exports it; or `export =` publishes the import.
 *
 * Followed (closed): named and default imports, local `export { x }` /
 * `export default x` of an import, and `export { x } from` / `export * from`
 * re-exports -- each re-exporting module is itself subjected to the same
 * proof. References inside the declaring module are NOT included; the caller
 * has them from value flow. Type-only mentions are omitted. An export no
 * module imports answers `[]`.
 */
export const inProgramImportReferencesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  specifierOrDeclaration: ts.ExportSpecifier | ts.Declaration
): readonly ts.Expression[] | null => {
  const modules = statedModuleSetOf(flow)
  const watched = process.env['GEA_IMPORTERS_DEBUG']
  const refuse = (reason: string, at?: ts.Node): null => {
    if (watched !== undefined) {
      const site = at ?? specifierOrDeclaration
      const source = site.getSourceFile()
      const line = source.getLineAndCharacterOfPosition(site.getStart()).line + 1
      console.error(`[IMPORTERS] ${reason} ${source.fileName}:${line} ${site.getText().replace(/\s+/g, ' ').slice(0, 60)}`)
    }
    return null
  }
  if (!modules) return refuse('no-stated-module-set')
  const file = specifierOrDeclaration.getSourceFile()
  if (file.isDeclarationFile || !ts.isExternalModule(file) || (file as { commonJsModuleIndicator?: ts.Node }).commonJsModuleIndicator)
    return refuse('not-an-es-module')
  const graph = importGraphOf(checker, modules)
  if (graph.opaque) return refuse('import-graph-opaque')
  const target = resolveFlowSymbolAlias(checker, exportedSymbolOf(checker, specifierOrDeclaration))
  const module = checker.getSymbolAtLocation(file)
  if (!target || (target.flags & ts.SymbolFlags.Alias) !== 0 || !module) return refuse('export-target-unresolved')
  const references: ts.Expression[] = []
  const visited = new Set<string>()
  const resolvesToTarget = (symbol: ts.Symbol): boolean => resolveFlowSymbolAlias(checker, symbol) === target
  // A mention in code the program never runs reads nothing and hands nothing
  // on. `files` is every module the checker loaded, which is more than the
  // program evaluates: three's `ColorSpaceNode.js` imports `ColorManagement`
  // and passes it a fresh `Matrix3`, and counting that dead call left every
  // `ColorManagement` method's parameters open -- boxed, and dispatched
  // dynamically on the three.js app's first frame.
  const reachable = modules.reachable
  const runs = (reference: ts.Node): boolean => reachable === undefined || nodeIsReachable(reachable, reference)

  /** Whether every module that can read `name` off `source` is enumerated. */
  const exportedAs = (source: ts.SourceFile, name: string): boolean => {
    const key = `${source.fileName}\0${name}`
    if (visited.has(key)) return true
    visited.add(key)
    const sourceModule = checker.getSymbolAtLocation(source)
    if (!sourceModule || !graph.files.has(source) || graph.entries.has(source) || graph.dynamic.has(sourceModule)) {
      refuse(
        `module-${!sourceModule ? 'unnamed' : !graph.files.has(source) ? 'outside-graph' : graph.entries.has(source) ? 'is-entry' : 'dynamic'}`,
        source
      )
      return false
    }
    const segment = lastSegment(source.fileName)
    if (graph.unresolved.has(segment)) {
      refuse(`unresolved-specifier:${segment}`, source)
      return false
    }
    if (segment === 'index' && graph.unresolved.has(lastSegment(source.fileName.replace(/[\\/][^\\/]*$/, '')))) {
      refuse('unresolved-index-directory', source)
      return false
    }
    for (const { file: importer, declaration } of graph.edges.get(sourceModule) ?? []) {
      if (ts.isImportDeclaration(declaration)) {
        const clause = declaration.importClause
        if (!clause) continue
        if (clause.name && name === 'default' && !bindingUses(importer, clause.name))
          return refuse('default-binding-open', clause) === null && false
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          if (!namespaceUses(importer, bindings.name, name)) return refuse('namespace-import-open', bindings) === null && false
        } else if (bindings) {
          for (const element of bindings.elements)
            if (!element.isTypeOnly && (element.propertyName ?? element.name).text === name && !bindingUses(importer, element.name))
              return false
        }
        continue
      }
      const clause = declaration.exportClause
      if (clause && ts.isNamespaceExport(clause)) return refuse('namespace-re-export', clause) === null && false
      if (!clause) {
        // `export * from` never forwards `default`, and a local export of the
        // same name shadows the star.
        if (name === 'default') continue
        const forwarding = checker.getSymbolAtLocation(importer)
        const forwarded = forwarding && checker.getExportsOfModule(forwarding).find((symbol) => symbol.name === name)
        if (forwarded && resolvesToTarget(forwarded) && !exportedAs(importer, name)) return false
        continue
      }
      for (const element of clause.elements)
        if (!element.isTypeOnly && (element.propertyName ?? element.name).text === name && !exportedAs(importer, element.name.text))
          return false
    }
    return true
  }

  /** A local import binding: its uses are references, its re-exports recurse. */
  const bindingUses = (importer: ts.SourceFile, binding: ts.Identifier): boolean => {
    const alias = checker.getSymbolAtLocation(binding)
    if (!alias) return false
    for (const statement of importer.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (!clause || !ts.isNamedExports(clause)) continue
      for (const element of clause.elements)
        if (
          !element.isTypeOnly &&
          checker.getExportSpecifierLocalTargetSymbol(element) === alias &&
          !exportedAs(importer, element.name.text)
        )
          return false
    }
    for (const reference of mentionsOf(checker, graph, importer, alias)) {
      if (reference === binding || typeOnlyMention(reference) || ts.isExportSpecifier(reference.parent) || !runs(reference)) continue
      const parent = reference.parent
      if (ts.isExportAssignment(parent)) {
        if (parent.isExportEquals || !exportedAs(importer, 'default')) return false
        continue
      }
      references.push(reference)
    }
    return true
  }

  /** A namespace import is closed only while every use selects a member statically. */
  const namespaceUses = (importer: ts.SourceFile, binding: ts.Identifier, name: string): boolean => {
    const alias = checker.getSymbolAtLocation(binding)
    if (!alias) return false
    for (const reference of mentionsOf(checker, graph, importer, alias)) {
      if (reference === binding || typeOnlyMention(reference) || !runs(reference)) continue
      const parent = reference.parent
      const selected = ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isElementAccessExpression(parent) && ts.isStringLiteralLike(parent.argumentExpression)
          ? parent.argumentExpression.text
          : null
      if (selected === null || (parent as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression !== reference) return false
      if (selected === name) references.push(parent as ts.Expression)
    }
    return true
  }

  for (const exported of checker.getExportsOfModule(module)) if (resolvesToTarget(exported) && !exportedAs(file, exported.name)) return null
  return references
}
