import ts from 'typescript'
import { dirname, resolve } from 'node:path'
import { createPackageSourceHost, type PackageSource } from './package-sources.js'

export const isDeclarationPath = (file: string): boolean => /\.d\.(?:ts|mts|cts)$/.test(file)

export const moduleExtension = (file: string): ts.Extension => {
  if (file.endsWith('.d.mts')) return ts.Extension.Dmts
  if (file.endsWith('.d.cts')) return ts.Extension.Dcts
  if (file.endsWith('.d.ts')) return ts.Extension.Dts
  if (file.endsWith('.tsx')) return ts.Extension.Tsx
  if (file.endsWith('.mts')) return ts.Extension.Mts
  if (file.endsWith('.cts')) return ts.Extension.Cts
  if (file.endsWith('.mjs')) return ts.Extension.Mjs
  if (file.endsWith('.cjs')) return ts.Extension.Cjs
  if (file.endsWith('.jsx')) return ts.Extension.Jsx
  if (file.endsWith('.js')) return ts.Extension.Js
  if (file.endsWith('.json')) return ts.Extension.Json
  return ts.Extension.Ts
}

export interface ModuleResolution {
  /** The unfiltered type lookup, retained even when its package cannot supply an implementation overlay. */
  readonly typeDeclaration: ts.ResolvedModuleFull | undefined
  readonly declaration: ts.ResolvedModuleFull | undefined
  readonly implementation: ts.ResolvedModuleFull | undefined
  readonly native: boolean
}

/** The package that owns a resolved file, using the program host's own view. */
const packageRootOf = (file: string, host: ts.ModuleResolutionHost): string | undefined => {
  let directory = dirname(resolve(file))
  for (;;) {
    if (host.fileExists(`${directory}/package.json`)) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * A declaration may describe an implementation only when the same package
 * ships both. In particular, `@types/three` is a third party package and must
 * not replace Three's real JavaScript source, including for type-only imports.
 */
const ownedDeclaration = (
  declaration: ts.ResolvedModuleFull | undefined,
  implementation: ts.ResolvedModuleFull | undefined,
  host: ts.ModuleResolutionHost
): ts.ResolvedModuleFull | undefined => {
  if (!declaration || !implementation) return declaration
  const declaredPackage = packageRootOf(declaration.resolvedFileName, host)
  const implementedPackage = packageRootOf(implementation.resolvedFileName, host)
  return declaredPackage !== undefined && declaredPackage === implementedPackage ? declaration : undefined
}

/** Remove type-only lookup metadata, preserving runtime condition order and null exclusions. */
const runtimeConditions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(runtimeConditions)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'types' && !key.startsWith('types@'))
      .map(([key, entry]) => [key, runtimeConditions(entry)])
  )
}

/**
 * Ask the same resolver two questions, through separate caches. Hiding declarations
 * only on the implementation view keeps TypeScript's exports/imports, conditions,
 * paths, package self references, and nested dependency search authoritative.
 * No package names, source-directory guesses, or package code execution belong here.
 */
export const createModuleResolver = (
  host: ts.ModuleResolutionHost,
  options: ts.CompilerOptions,
  declarationModules: ReadonlySet<string> = new Set(),
  packageSources: readonly PackageSource[] = []
): {
  readonly resolve: (specifier: string, containingFile: string, mode?: ts.ResolutionMode, statedTarget?: string) => ModuleResolution
} => {
  const currentDirectory = host.getCurrentDirectory?.() ?? ts.sys.getCurrentDirectory()
  const canonical = ts.sys.useCaseSensitiveFileNames ? (file: string): string => file : (file: string): string => file.toLowerCase()
  const typesCache = ts.createModuleResolutionCache(currentDirectory, canonical, options)
  const runtimeCache = ts.createModuleResolutionCache(currentDirectory, canonical, options)
  const sources = createPackageSourceHost(host, packageSources)
  const manifests = new Map<string, string | undefined>()
  const runtimeHost: ts.ModuleResolutionHost = {
    ...sources.host,
    fileExists: (file) => !isDeclarationPath(file) && sources.host.fileExists(file),
    readFile: (file) => {
      if (!file.endsWith('/package.json')) return sources.host.readFile(file)
      if (manifests.has(file)) return manifests.get(file)
      const text = sources.host.readFile(file)
      if (text === undefined) return undefined
      let result = text
      try {
        const manifest: unknown = JSON.parse(text)
        if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
          const fields = Object.fromEntries(
            Object.entries(manifest).filter(([key]) => !['types', 'typings', 'typesVersions'].includes(key))
          )
          if ('exports' in fields) fields.exports = runtimeConditions(fields.exports)
          if ('imports' in fields) fields.imports = runtimeConditions(fields.imports)
          result = JSON.stringify(fields)
        }
      } catch {
        // Preserve malformed metadata for the resolver's own diagnostic behaviour.
      }
      manifests.set(file, result)
      return result
    }
  }
  const nativeModule = (specifier: string): boolean =>
    declarationModules.has(specifier) ||
    [...declarationModules].some((pattern) => pattern.endsWith('/*') && specifier.startsWith(pattern.slice(0, -1)))
  return {
    resolve: (specifier, containingFile, mode, statedTarget) => {
      // Asked from where the runtime half below asks: a bare specifier in a
      // source checkout resolves through the installed location it stands in
      // for, and a declaration found from the checkout's own directory names
      // whatever version is hoisted above the cache instead.
      const typed = ts.resolveModuleName(
        specifier,
        sources.containingFile(specifier, containingFile),
        options,
        host,
        typesCache,
        undefined,
        mode
      ).resolvedModule
      const native = nativeModule(specifier)
      let declaration = typed && isDeclarationPath(typed.resolvedFileName) ? typed : undefined
      // A plugin that declares a module native owns its declarations, and the
      // importing file is not always able to reach them: a package inside the
      // module graph may import a peer the bundler resolved through the *app's*
      // node_modules rather than its own, leaving `node_modules/@scope` empty
      // next to the importer. The file the graph itself resolved to always lives
      // inside the owning package, so ask again from there before concluding the
      // declarations are missing -- otherwise the native package's runtime
      // JavaScript is compiled as ordinary source and its classes collide with
      // the host-bound ambient ones they shadow.
      if (native && declaration === undefined && statedTarget !== undefined && !isDeclarationPath(statedTarget)) {
        const owned = ts.resolveModuleName(specifier, statedTarget, options, host, typesCache, undefined, mode).resolvedModule
        if (owned && isDeclarationPath(owned.resolvedFileName)) declaration = owned
      }
      if (native && declaration) return { typeDeclaration: declaration, declaration, implementation: undefined, native }
      if (statedTarget !== undefined) {
        const target = { resolvedFileName: statedTarget, extension: moduleExtension(statedTarget), isExternalLibraryImport: false }
        if (isDeclarationPath(statedTarget))
          return { typeDeclaration: target, declaration: target, implementation: undefined, native: true }
        // Fail closed rather than substituting source for a module a plugin
        // declared native: no declarations is a broken installation, and the
        // resulting "cannot find module" names it, where a source overlay would
        // silently duplicate every host-bound type.
        if (native) return { typeDeclaration: undefined, declaration: undefined, implementation: undefined, native }
        return {
          typeDeclaration: declaration,
          declaration: ownedDeclaration(declaration, target, host),
          implementation: target,
          native: false
        }
      }
      // Relative imports inside declaration trees must continue to describe types.
      // They never cause executable files to be substituted into those trees.
      if (isDeclarationPath(containingFile)) {
        return {
          typeDeclaration: declaration,
          declaration,
          implementation: typed && !isDeclarationPath(typed.resolvedFileName) ? typed : undefined,
          native
        }
      }
      const resolved = ts.resolveModuleName(
        specifier,
        sources.containingFile(specifier, containingFile),
        options,
        runtimeHost,
        runtimeCache,
        undefined,
        mode
      ).resolvedModule
      const source = resolved ? sources.sourceOf(resolved.resolvedFileName) : undefined
      const implementation = resolved && source ? { ...resolved, resolvedFileName: source, extension: moduleExtension(source) } : resolved
      return { typeDeclaration: declaration, declaration: ownedDeclaration(declaration, implementation, host), implementation, native }
    }
  }
}

export const typeOnlyModuleUse = (literal: ts.StringLiteralLike, checker?: ts.TypeChecker, verbatim = false): boolean => {
  const erasedBinding = (name: ts.Node): boolean => {
    if (!checker || verbatim) return false
    let symbol = checker.getSymbolAtLocation(name)
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Value) === 0
  }
  let node: ts.Node | undefined = literal.parent
  while (node) {
    if (ts.isImportTypeNode(node) || ts.isJSDocImportTag(node)) return true
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.isTypeOnly) return true
      const bindings = clause?.namedBindings
      return (
        (!clause?.name || erasedBinding(clause.name)) &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly || erasedBinding(item.name))
      )
    }
    if (ts.isExportDeclaration(node)) {
      return (
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((item) => item.isTypeOnly || erasedBinding(item.name)))
      )
    }
    if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly
    node = node.parent
  }
  return false
}

/** A single-file source map is explicit provenance; a directory name is not. */
export const mappedTypeScriptSource = (file: string, host: ts.ModuleResolutionHost): string | undefined => {
  if (!/\.(?:js|mjs|cjs|jsx)$/.test(file)) return undefined
  const text = host.readFile(`${file}.map`)
  if (text === undefined) return undefined
  try {
    const map: unknown = JSON.parse(text)
    if (map === null || typeof map !== 'object') return undefined
    const fields = map as { sources?: unknown; sourceRoot?: unknown }
    if (!Array.isArray(fields.sources) || fields.sources.length !== 1 || typeof fields.sources[0] !== 'string') return undefined
    if (fields.sourceRoot !== undefined && typeof fields.sourceRoot !== 'string') return undefined
    const source = fields.sources[0]
    const root = fields.sourceRoot ?? ''
    if (/^[a-z]+:/i.test(source) || /^[a-z]+:/i.test(root)) return undefined
    const target = resolve(dirname(file), root, source)
    return /\.(?:ts|mts|cts|tsx)$/.test(target) && !isDeclarationPath(target) && host.fileExists(target) ? target : undefined
  } catch {
    return undefined
  }
}
