import { resolve } from 'node:path'
import ts from 'typescript'
import type { CommonJsWrapperDeclaration } from '../plugins/model.js'
import { valueSymbolAt } from './normalize/unresolvable-names.js'

export type CommonJsGlobal = 'require' | 'exports' | 'module'

export type CommonJsIdentifierIdentity =
  { readonly kind: 'wrapper'; readonly global: CommonJsGlobal } | { readonly kind: 'provenance-failure' } | { readonly kind: 'ordinary' }

const resolvedSymbolAt = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | null => {
  // One rule for what a name in value position denotes (`valueSymbolAt`),
  // including checked JavaScript's `module`/`exports`, which the checker binds
  // to the file's own export synthesis rather than to the wrapper parameter
  // the host declared. Provenance is a question about that lexical
  // declaration, and the reference producer keys the same declaration.
  const local = valueSymbolAt(checker, node)
  if (!local) return null
  return (local.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(local) : local
}

export const commonJsWrapperVariableOf = (node: ts.Node): ts.VariableDeclaration | null => {
  if (ts.isVariableDeclaration(node)) return node
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return null
  }
  return null
}

/** Whether a `var` declaration shares the outer CommonJS wrapper's VariableEnvironment. */
export const isCommonJsWrapperVarDeclaration = (node: ts.VariableDeclaration): boolean => {
  if (node.getSourceFile().isDeclarationFile) return false
  const list = node.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== 0) return false
  for (let current: ts.Node | undefined = list.parent; current; current = current.parent) {
    if (ts.isSourceFile(current)) return true
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current) || ts.isModuleBlock(current)) return false
  }
  return false
}

export const commonJsBindingIdentifiers = (name: ts.BindingName): readonly ts.Identifier[] => {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : commonJsBindingIdentifiers(element.name)))
}

const exactConfiguredDeclaration = (declaration: ts.Declaration, configured: CommonJsWrapperDeclaration): boolean => {
  if (resolve(declaration.getSourceFile().fileName) !== resolve(configured.declarationFileName)) return false
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.name.text === configured.declarationName
}

const exactCompatibleDeclaration = (declaration: ts.Declaration, configured: CommonJsWrapperDeclaration): boolean =>
  (configured.compatibleDeclarations ?? []).some(
    (compatible) =>
      resolve(declaration.getSourceFile().fileName) === resolve(compatible.declarationFileName) &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === compatible.declarationName
  )

/**
 * A lexical `var` only aliases Node's wrapper parameter when the compiler has
 * already classified this source as CommonJS.  Syntax is deliberately not
 * enough: the same declaration in an `.mjs` file or a `type: module` package
 * owns a distinct local binding.
 *
 * The checker fills `impliedNodeFormat` only under Node16/NodeNext module
 * resolution; this compiler resolves as a bundler (`program.ts`), so the
 * field was never set and every source read as "format unknown", which the
 * rule below answers as "not a wrapper" -- no `var require` in a `type:
 * commonjs` package ever authenticated. The fact itself does not depend on
 * the resolution mode: it is the nearest package.json's `type`, or the
 * `.cjs`/`.mjs` extension, decided exactly as Node's loader decides it. So
 * the same walk is asked of TypeScript directly, under the one mode that
 * makes it answer. A file the walk cannot place still answers nothing, and
 * nothing is never CommonJS.
 */
export const isCommonJsSourceFile = (file: ts.SourceFile, formats: Map<ts.SourceFile, ts.ResolutionMode>): boolean => {
  let format = file.impliedNodeFormat
  if (format === undefined) {
    if (formats.has(file)) format = formats.get(file)
    else {
      format = ts.getImpliedNodeFormatForFile(file.fileName, undefined, ts.sys, { moduleResolution: ts.ModuleResolutionKind.NodeNext })
      formats.set(file, format)
    }
  }
  return format === ts.ModuleKind.CommonJS
}

/**
 * The program's source text with every bare top-level `var` redeclaration of
 * a wrapper name blanked, keyed by resolved file name, for the CommonJS files
 * that carry one.
 *
 * `var require` at the top of a CommonJS module is what Node's own wrapper
 * makes of it: a function-scoped redeclaration of the wrapper's parameter,
 * which changes nothing at run time -- the name still holds the loader's
 * `require`. TypeScript reads the same statement as a module-local `var` with
 * no initializer and, under `strict`, gives it the evolving type every read
 * sees as `undefined`: `const load = require; load('./x')` is then TS18048
 * and TS2722, and `load`'s carrier is typed from nothing. The checker cannot
 * be told that a local redeclares an outer parameter, so the statement is
 * blanked before the final program is built: the identifier then resolves to
 * the host's authenticated global declaration, which is what it names.
 *
 * Blanked rather than cut so every other position in the file is unchanged
 * (`diagnostic-source-preparation.ts` makes the same choice). Only the bare
 * form qualifies: an initializer is a real write the wrapper identity must
 * see and refuse, a type annotation is the author's own statement about the
 * name, an exported declaration is a module's surface, and a `var` inside a
 * function is a different binding altogether. An ESM file is left alone --
 * there the `var` is a genuine local the identity layer must NOT authenticate.
 */
export const withoutBareWrapperRedeclarations = (
  program: ts.Program,
  globals: ReadonlySet<string>,
  prepared: ReadonlyMap<string, string>
): Map<string, string> => {
  const blanked = new Map<string, string>()
  if (globals.size === 0) return blanked
  const formats = new Map<ts.SourceFile, ts.ResolutionMode>()
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !isCommonJsSourceFile(file, formats)) continue
    const spans: { readonly at: number; readonly end: number }[] = []
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) || statement.modifiers?.length) continue
      if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) continue
      const bare = statement.declarationList.declarations.every(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          globals.has(declaration.name.text) &&
          declaration.initializer === undefined &&
          declaration.type === undefined
      )
      if (bare) spans.push({ at: statement.getStart(file), end: statement.getEnd() })
    }
    if (spans.length === 0) continue
    const fileName = resolve(file.fileName)
    let text = prepared.get(fileName) ?? file.text
    for (const span of [...spans].sort((a, b) => b.at - a.at))
      text = text.slice(0, span.at) + text.slice(span.at, span.end).replace(/[^\n\r]/g, ' ') + text.slice(span.end)
    blanked.set(fileName, text)
  }
  return blanked
}

const wrapperRedeclarationFor = (
  declaration: ts.Declaration,
  configured: CommonJsWrapperDeclaration,
  formats: Map<ts.SourceFile, ts.ResolutionMode>
): boolean => {
  const variable = commonJsWrapperVariableOf(declaration)
  if (variable === null || !isCommonJsSourceFile(variable.getSourceFile(), formats) || !isCommonJsWrapperVarDeclaration(variable))
    return false
  return commonJsBindingIdentifiers(variable.name).some((identifier) => identifier.text === configured.declarationName)
}

/**
 * One authentication result shared by host binding and static-require analysis.
 * The configured path and declaration spelling establish the host identity;
 * module-scope `var` declarations may join it only because Node's wrapper has
 * already introduced that exact parameter cell. No block binding, nested var,
 * local function, import, or caller-owned ambient declaration is admitted.
 */
export const createCommonJsWrapperIdentity = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>
): {
  readonly classify: (identifier: ts.Identifier) => CommonJsIdentifierIdentity
  readonly globalOfDeclaration: (declaration: ts.Declaration) => CommonJsGlobal | null
} => {
  const configuredByName = new Map<string, CommonJsWrapperDeclaration>()
  for (const [name, configured] of globals) {
    if (name === configured.declarationName && name === configured.global) configuredByName.set(name, configured)
  }

  const authenticatedSymbols = new Map<ts.Symbol, CommonJsGlobal>()
  const failedSymbols = new Set<ts.Symbol>()
  const formats = new Map<ts.SourceFile, ts.ResolutionMode>()
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
        const configured = configuredByName.get(node.text)
        if (configured && exactConfiguredDeclaration(node.parent, configured)) {
          const symbol = resolvedSymbolAt(checker, node)
          if (symbol) {
            const declarations = symbol.declarations ?? []
            const complete =
              declarations.length > 0 &&
              declarations.every(
                (declaration) =>
                  exactConfiguredDeclaration(declaration, configured) ||
                  exactCompatibleDeclaration(declaration, configured) ||
                  wrapperRedeclarationFor(declaration, configured, formats)
              )
            if (complete) authenticatedSymbols.set(symbol, configured.global)
            else failedSymbols.add(symbol)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    if ([...configuredByName.values()].some((configured) => resolve(configured.declarationFileName) === resolve(file.fileName))) visit(file)
  }

  const authenticatedGlobals = new Set(authenticatedSymbols.values())
  const redeclarations = new Map<ts.Symbol, ReadonlyMap<ts.SourceFile, CommonJsGlobal>>()
  const declarationGlobals = new Map<ts.Declaration, CommonJsGlobal>()
  for (const file of files) {
    if (file.isDeclarationFile || !isCommonJsSourceFile(file, formats)) continue
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && isCommonJsWrapperVarDeclaration(node)) {
        for (const identifier of commonJsBindingIdentifiers(node.name)) {
          const configured = configuredByName.get(identifier.text)
          if (!configured || !authenticatedGlobals.has(configured.global)) continue
          const symbol = resolvedSymbolAt(checker, identifier)
          if (!symbol) continue
          const perFile = new Map(redeclarations.get(symbol) ?? [])
          perFile.set(file, configured.global)
          redeclarations.set(symbol, perFile)
          const declaration = identifier === node.name ? node : identifier.parent
          if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
            declarationGlobals.set(declaration, configured.global)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  const classify = (identifier: ts.Identifier): CommonJsIdentifierIdentity => {
    const symbol = resolvedSymbolAt(checker, identifier)
    if (!symbol) return { kind: 'ordinary' }
    const redeclared = redeclarations.get(symbol)?.get(identifier.getSourceFile())
    if (redeclared !== undefined) return { kind: 'wrapper', global: redeclared }
    const authenticated = authenticatedSymbols.get(symbol)
    if (authenticated !== undefined) return { kind: 'wrapper', global: authenticated }
    if (failedSymbols.has(symbol)) return { kind: 'provenance-failure' }
    return { kind: 'ordinary' }
  }

  return {
    classify,
    globalOfDeclaration: (declaration) => declarationGlobals.get(declaration) ?? null
  }
}
