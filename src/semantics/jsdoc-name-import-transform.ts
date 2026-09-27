import ts from 'typescript'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { dirname, relative, resolve, sep } from 'path'
import { modulesReachableFrom } from './declaration-overlay-transform.js'

/**
 * A JSDoc type name the file never imports, brought into scope from the one
 * module in the program that declares it.
 *
 * three writes `@param {Array<BindGroup>} bindings` in `Bindings.js`, which
 * imports nothing named `BindGroup`, and `@param {?Array<LightingNode>}` in
 * `LightingContextNode.js`, which imports nothing named `LightingNode`. The
 * checker reads each name as an error type, so the array's element is `any`
 * -- printed as `BindGroup[]`, carried as a box -- while the file the array
 * came from imports the class and lays the same array out with a class
 * element. One storage, two carriers, and array carriers are invariant.
 *
 * `jsdoc-type-names.ts` resolves a bare `{Name}` at a `@param` one scope
 * wider, as a census. That cannot reach a name inside `Array<...>`, and a
 * census answer at the declaration was tried for it and is wrong: the body's
 * reads keep the checker's `any[]`, so the ABI projection refuses the
 * function (batch 7, D1). The CHECKER has to bind the name, and the
 * declaration overlay's `@import` header is how a JSDoc name is bound: this
 * adds the same header for the names the overlay does not supply.
 *
 * ## What is imported
 *
 * A name a JSDoc type expression in this file references INSIDE a composite
 * type (a generic argument, a union, `?T`, a function type), when
 *
 * A name that is the whole tag (`@param {Backend} backend`) is not a reason
 * to import: `jsdoc-type-names.ts` already answers a bare `@param` name as
 * a census, and letting the checker bind one changes the dispatch of every
 * call through it -- a field stated `{Backend}` becomes a class receiver, so
 * `this.backend.createNodeBuilder(...)` resolves to a base method its
 * subclasses redeclare, which three's `NodeManager` relies on staying dynamic
 * (`jsdoc-override-parameter-contradicted-through-base-call`). Once one
 * composite tag imports a name, the checker binds it for the whole file.
 *
 * - the file does not bind it (a top-level declaration, an import, an
 *   `@import`, a `@typedef`/`@callback`, or a `@template` anywhere in it);
 * - no default library declares it: DOM's `Node` stays DOM's, which is what
 *   the checker already reads, so no tag the checker could read changes
 *   meaning;
 * - exactly one module of the program declares and exports a class by that
 *   name, or declares a `@typedef`/`@callback` by it at top level, or several
 *   do and one is nearest by shared path (`jsdoc-type-names.ts`'s tie-break);
 * - importing it cannot close a runtime cycle: the declaration overlay's
 *   `modulesReachableFrom` guard, since an `@import` is a real module edge and
 *   a cycle makes the checker answer `any` for every symbol caught in it.
 *
 * ## Where it goes
 *
 * At the END of the file. TypeScript binds an `@import` attached to the end
 * of file token like any other, and appending moves no line and no offset,
 * so every location a refusal or a diagnostic names stays the source's own.
 */

const isModuleSourcePath = (fileName: string): boolean => /\.m?js$/.test(fileName)

let libraryNames: ReadonlySet<string> | null = null
/** Every name a default library file declares at top level, read once. */
const defaultLibraryNames = (): ReadonlySet<string> => {
  if (libraryNames) return libraryNames
  const names = new Set<string>()
  const directory = dirname(ts.getDefaultLibFilePath({}))
  for (const entry of readdirSync(directory)) {
    if (!/^lib\..*\.d\.ts$/.test(entry)) continue
    const file = ts.createSourceFile(
      entry,
      readFileSync(resolve(directory, entry), 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS
    )
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
        continue
      }
      const name = (statement as ts.Node & { readonly name?: ts.Node }).name
      if (name && ts.isIdentifier(name)) names.add(name.text)
    }
  }
  libraryNames = names
  return names
}

const jsDocOf = (node: ts.Node): readonly ts.JSDoc[] => (node as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

const isModuleFile = (file: ts.SourceFile): boolean =>
  file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      hasExportModifier(statement)
  )

/** The JSDoc blocks of a file's top-level statements and of its end, where the tags that bind file-wide sit. */
const topLevelJsDocOf = (file: ts.SourceFile): readonly ts.JSDoc[] => [...file.statements.flatMap(jsDocOf), ...jsDocOf(file.endOfFileToken)]

/** How a module exports a type name: by that name, or as its default. */
type ExportForm = 'named' | 'default'

/** The type names one module declares for other modules to import, and how each is imported. */
const declaredTypeNamesOf = (file: ts.SourceFile): ReadonlyMap<string, ExportForm> => {
  const names = new Map<string, ExportForm>()
  if (!isModuleFile(file)) return names
  const classes = new Set<string>()
  const exported = new Map<string, ExportForm>()
  // A name exported both ways is imported by name, the form that needs no alias.
  const exportAs = (name: string, form: ExportForm): void => {
    if (exported.get(name) !== 'named') exported.set(name, form)
  }
  for (const statement of file.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      classes.add(statement.name.text)
      if (hasExportModifier(statement)) {
        const isDefault = (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
        exportAs(statement.name.text, isDefault ? 'default' : 'named')
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportAs((element.propertyName ?? element.name).text, element.name.text === 'default' ? 'default' : 'named')
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      exportAs(statement.expression.text, 'default')
    }
  }
  for (const name of classes) {
    const form = exported.get(name)
    if (form) names.set(name, form)
  }
  for (const tag of topLevelJsDocOf(file).flatMap((block) => [...(block.tags ?? [])])) {
    if ((ts.isJSDocTypedefTag(tag) || ts.isJSDocCallbackTag(tag)) && tag.name && ts.isIdentifier(tag.name) && !names.has(tag.name.text))
      names.set(tag.name.text, 'named')
  }
  return names
}

interface Declaring {
  readonly file: string
  readonly form: ExportForm
}

const indexCache = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, readonly Declaring[]>>()
/** Type name -> every program module declaring it (see `declaredTypeNamesOf`), built once per program. */
const programTypeIndex = (programFiles: ReadonlySet<string>): ReadonlyMap<string, readonly Declaring[]> => {
  const cached = indexCache.get(programFiles)
  if (cached) return cached
  const index = new Map<string, Declaring[]>()
  for (const fileName of programFiles) {
    if (!isModuleSourcePath(fileName) || !existsSync(fileName)) continue
    let file: ts.SourceFile
    try {
      file = ts.createSourceFile(fileName, readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    } catch {
      continue
    }
    for (const [name, form] of declaredTypeNamesOf(file)) {
      const declaring = { file: resolve(fileName), form }
      const existing = index.get(name)
      if (existing) existing.push(declaring)
      else index.set(name, [declaring])
    }
  }
  indexCache.set(programFiles, index)
  return index
}

const sharedPathDepth = (left: string, right: string): number => {
  const from = left.split(/[\\/]/)
  const to = right.split(/[\\/]/)
  let depth = 0
  while (depth < from.length && depth < to.length && from[depth] === to[depth]) depth += 1
  return depth
}

/** The one declaring module nearest the file, or `null` when two are equally near. */
const nearestModule = (candidates: readonly Declaring[], home: string): Declaring | null => {
  let nearest: Declaring | null = null
  let bestDepth = -1
  let tied = false
  for (const candidate of candidates) {
    const depth = sharedPathDepth(home, candidate.file)
    if (depth > bestDepth) {
      bestDepth = depth
      nearest = candidate
      tied = false
    } else if (depth === bestDepth) tied = true
  }
  return tied ? null : nearest
}

/** Every name this file binds for its JSDoc, anywhere a tag can see it. */
const boundNamesOf = (file: ts.SourceFile): Set<string> => {
  const bound = new Set<string>()
  for (const statement of file.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name) bound.add(statement.name.text)
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) bound.add(declaration.name.text)
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) bound.add(element.name.text)
      if (bindings && ts.isNamespaceImport(bindings)) bound.add(bindings.name.text)
      if (statement.importClause.name) bound.add(statement.importClause.name.text)
    }
  }
  for (const tag of topLevelJsDocOf(file).flatMap((block) => [...(block.tags ?? [])])) {
    if ((ts.isJSDocTypedefTag(tag) || ts.isJSDocCallbackTag(tag)) && tag.name && ts.isIdentifier(tag.name)) bound.add(tag.name.text)
    if (!ts.isJSDocImportTag(tag)) continue
    const bindings = tag.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) bound.add(element.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) bound.add(bindings.name.text)
    if (tag.importClause?.name) bound.add(tag.importClause.name.text)
  }
  return bound
}

export const jsdocNameImportTransform = (input: {
  readonly fileName: string
  readonly text: string
  readonly programFiles?: ReadonlySet<string>
}): string | null => {
  const { fileName, text, programFiles } = input
  if (!programFiles || !isModuleSourcePath(fileName) || !text.includes('/**')) return null
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (!isModuleFile(file)) return null
  const bound = boundNamesOf(file)
  const referenced = new Set<string>()
  const visitJsDoc = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !ts.isJSDocTypeExpression(node.parent))
      referenced.add(node.typeName.text)
    if (ts.isJSDocTemplateTag(node)) for (const parameter of node.typeParameters) bound.add(parameter.name.text)
    if ((ts.isJSDocTypedefTag(node) || ts.isJSDocCallbackTag(node)) && node.name && ts.isIdentifier(node.name)) bound.add(node.name.text)
    ts.forEachChild(node, visitJsDoc)
  }
  const visit = (node: ts.Node): void => {
    for (const block of jsDocOf(node)) visitJsDoc(block)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (referenced.size === 0) return null
  const home = resolve(fileName)
  const index = programTypeIndex(programFiles)
  const library = defaultLibraryNames()
  const named = new Map<string, string[]>()
  const defaults: string[] = []
  for (const name of [...referenced].sort()) {
    if (bound.has(name) || library.has(name)) continue
    const candidates = index.get(name)
    if (!candidates || candidates.length === 0) continue
    const target = candidates.length === 1 ? candidates[0] : nearestModule(candidates, home)
    if (!target || target.file === home) continue
    if (modulesReachableFrom(target.file).has(home)) continue
    const path = relative(dirname(home), target.file).split(sep).join('/')
    const specifier = path.startsWith('.') ? path : `./${path}`
    if (target.form === 'default') {
      defaults.push(`/** @import ${name} from '${specifier}' */`)
      continue
    }
    const names = named.get(specifier)
    if (names) names.push(name)
    else named.set(specifier, [name])
  }
  if (named.size === 0 && defaults.length === 0) return null
  const header = [...[...named].map(([specifier, names]) => `/** @import { ${names.join(', ')} } from '${specifier}' */`), ...defaults]
  return `${text}${text.endsWith('\n') ? '' : '\n'}${header.join('\n')}\n`
}
