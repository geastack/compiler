import ts from 'typescript'
import { dirname, resolve, relative } from 'node:path'

export interface PackageSource {
  readonly root: string
  /** Installed location whose dependency search this checkout inherits. */
  readonly origin?: string
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
// TypeScript reports paths with forward slashes on every platform, while
// node:path joins with a backslash on Windows. Appending `sep` therefore made
// every containment test fail there: the `sourceRoot` walk in readRecord climbed
// to the drive root, where `dirname('C:/')` stops changing, and the loop spun
// forever — a Windows build never finished, it only looked slow. Compare the two
// paths on a single separator instead.
const separators = /[\\/]+/g
const sameShape = (value: string): string => value.replace(separators, '/').replace(/\/$/, '')
const inside = (file: string, directory: string): boolean => {
  const target = sameShape(file)
  const root = sameShape(directory)
  return target === root || target.startsWith(`${root}/`)
}
const typedFile = (file: string): boolean => /\.(?:ts|tsx|mts|cts)$/.test(file) && !/\.d\.(?:ts|mts|cts)$/.test(file)

/**
 * Source discovery is a filesystem view shared by installed packages and source
 * checkouts. Only package/build metadata supplies an output-to-input mapping;
 * exports still decide whether the requested subpath is public.
 */
export const createPackageSourceHost = (host: ts.ModuleResolutionHost, packages: readonly PackageSource[] = []) => {
  const parseHost = host as ts.ModuleResolutionHost & Partial<Pick<ts.ParseConfigHost, 'readDirectory'>>
  const readDirectory = parseHost.readDirectory?.bind(host) ?? ts.sys.readDirectory
  const records = new Map<
    string,
    | {
        manifest: Record<string, unknown>
        mappings: Map<string, string>
        patterns: readonly [string, string][]
        roots: readonly [string, string][]
        inputs: readonly string[]
      }
    | undefined
  >()
  const packageOf = (file: string): string | undefined => {
    let directory = dirname(resolve(file))
    for (;;) {
      if (host.fileExists(`${directory}/package.json`)) return directory
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
  const readRecord = (root: string) => {
    if (records.has(root)) return records.get(root)
    // Install the sentinel before parsing configs, whose extends can re-enter lookup.
    records.set(root, undefined)
    const text = host.readFile(`${root}/package.json`)
    if (text === undefined) return undefined
    let manifest: Record<string, unknown> | undefined
    try {
      manifest = recordOf(JSON.parse(text))
    } catch {
      return undefined
    }
    if (!manifest) return undefined
    const mappings = new Map<string, string>()
    const roots: [string, string][] = []
    const patterns: [string, string][] = []
    const inputs: string[] = []
    const add = (output: string, source: string): void => {
      const from = resolve(root, output)
      const to = resolve(root, source)
      if (!inside(from, root) || !inside(to, root) || !typedFile(to)) return
      if (from.includes('*') && to.includes('*')) patterns.push([from, to])
      else if (host.fileExists(to)) mappings.set(from, to)
    }
    const sourceConditions = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(sourceConditions)
        return
      }
      const object = recordOf(value)
      if (!object) return
      const sources = Object.entries(object).filter(
        ([key, entry]) => (key === 'source' || key.endsWith('/source')) && typeof entry === 'string'
      )
      if (sources.length === 1) {
        const source = sources[0]?.[1]
        if (typeof source === 'string')
          for (const [key, output] of Object.entries(object)) {
            if (key !== 'types' && typeof output === 'string') add(output, source)
          }
      }
      Object.values(object).forEach(sourceConditions)
    }
    sourceConditions(manifest.exports)
    if (typeof manifest.source === 'string') {
      for (const field of ['main', 'module']) if (typeof manifest[field] === 'string') add(manifest[field], manifest.source)
    }
    for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
      const file = resolve(root, name)
      if (!host.fileExists(file)) continue
      const config = ts.readConfigFile(file, host.readFile)
      if (config.error) continue
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        {
          useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
          fileExists: host.fileExists,
          readFile: host.readFile,
          readDirectory
        },
        root
      )
      let sourceRoot = parsed.options.rootDir
      const configInputs = parsed.fileNames.filter(typedFile)
      inputs.push(...configInputs)
      if (!sourceRoot && configInputs.length > 0) {
        sourceRoot = dirname(configInputs[0]!)
        // Stop at the filesystem root even when an input is genuinely outside it:
        // dirname() is idempotent there, so without this the walk cannot end.
        for (const input of configInputs)
          while (!inside(input, sourceRoot)) {
            const parent = dirname(sourceRoot)
            if (parent === sourceRoot) break
            sourceRoot = parent
          }
      }
      if (sourceRoot && parsed.options.outDir) roots.push([parsed.options.outDir, sourceRoot])
    }
    // Packages commonly emit declarations and JavaScript into sibling trees:
    // `src/index.ts` -> `dist/types/index.d.ts` and `dist/index.js`. The
    // tsconfig proves the first relationship, while the exports entry proves
    // that both outputs implement the same public subpath. Carry that proof
    // across to the runtime target so a source checkout does not need to keep
    // generated JavaScript or add geatsc-specific metadata.
    const sourceFromDeclaredOutput = (output: string): string | undefined => {
      const absolute = resolve(root, output)
      for (const [outDir, sourceDir] of roots) {
        if (!inside(absolute, outDir)) continue
        const base = resolve(sourceDir, relative(outDir, absolute)).replace(/\.d\.(?:ts|mts|cts)$/, '')
        if (base.includes('*')) return `${base}.ts`
        const candidates = ['.ts', '.tsx', '.mts', '.cts'].map((extension) => `${base}${extension}`).filter(host.fileExists)
        if (candidates.length === 1) return candidates[0]
        const suffix = relative(outDir, absolute).replace(/\.d\.(?:ts|mts|cts)$/, '')
        const suffixCandidates = inputs.filter((input) => {
          const source = relative(root, input).replace(/\.(?:ts|tsx|mts|cts)$/, '')
          return source === suffix || source.endsWith(`/${suffix}`)
        })
        if (suffixCandidates.length === 1) return suffixCandidates[0]
      }
      return undefined
    }
    const inferRuntimeSources = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(inferRuntimeSources)
        return
      }
      const object = recordOf(value)
      if (!object) return
      const declared = typeof object.types === 'string' ? sourceFromDeclaredOutput(object.types) : undefined
      if (declared)
        for (const [condition, output] of Object.entries(object))
          if (condition !== 'types' && typeof output === 'string' && !/\.d\.(?:ts|mts|cts)$/.test(output)) add(output, declared)
      Object.values(object).forEach(inferRuntimeSources)
    }
    inferRuntimeSources(manifest.exports)
    // Static Rollup input/output declarations are data. Never execute build configs
    // or plugins to discover a file; dynamic configs retain normal resolution.
    for (const extension of ['js', 'mjs', 'cjs', 'ts']) {
      const file = resolve(root, `rollup.config.${extension}`)
      const code = host.readFile(file)
      if (code === undefined) continue
      const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
      const constants = new Map<string, ts.Expression>()
      for (const statement of ast.statements)
        if (ts.isVariableStatement(statement)) {
          if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer)
          }
        }
      const valueOf = (node: ts.Expression, seen = new Set<string>()): ts.Expression => {
        if (!ts.isIdentifier(node) || seen.has(node.text)) return node
        const value = constants.get(node.text)
        if (!value) return node
        seen.add(node.text)
        return valueOf(value, seen)
      }
      const property = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
        for (const item of node.properties) {
          if (!item.name || (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name)) || item.name.text !== name) continue
          if (ts.isPropertyAssignment(item)) return valueOf(item.initializer)
          if (ts.isShorthandPropertyAssignment(item)) return valueOf(item.name)
        }
        return undefined
      }
      const visit = (expression: ts.Expression): void => {
        const node = valueOf(expression)
        if (ts.isArrayLiteralExpression(node)) {
          node.elements.forEach(visit)
          return
        }
        if (!ts.isObjectLiteralExpression(node)) return
        const input = property(node, 'input')
        const output = property(node, 'output')
        if (!input || !ts.isStringLiteralLike(input) || !output) return
        const outputs = ts.isArrayLiteralExpression(output) ? output.elements : [output]
        for (const item of outputs) {
          const target = valueOf(item)
          if (!ts.isObjectLiteralExpression(target)) continue
          const destination = property(target, 'file')
          if (destination && ts.isStringLiteralLike(destination)) add(destination.text, input.text)
        }
      }
      for (const statement of ast.statements) if (ts.isExportAssignment(statement)) visit(statement.expression)
    }
    // esbuild's explicit outbase/outdir pair identifies preserved module paths.
    // Inspect only scripts named by package metadata, never execute their code.
    const buildFiles = new Set<string>()
    for (const [name, script] of Object.entries(recordOf(manifest.scripts) ?? {})) {
      if (!/^(?:build|compile)(?::|$)/.test(name) || typeof script !== 'string') continue
      for (const token of script.matchAll(/(?:^|\s)([\w./-]+\.(?:mjs|cjs|js|ts))(?=\s|$)/g)) buildFiles.add(resolve(root, token[1]!))
    }
    for (const file of buildFiles) {
      if (!inside(file, root)) continue
      const code = host.readFile(file)
      if (code === undefined) continue
      const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const fields = new Map<string, string>()
          for (const property of node.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              ts.isStringLiteralLike(property.initializer)
            ) {
              fields.set(property.name.text, property.initializer.text)
            }
          }
          const source = fields.get('outbase'),
            output = fields.get('outdir')
          if (source && output && inside(resolve(root, source), root) && inside(resolve(root, output), root))
            roots.push([resolve(root, output), resolve(root, source)])
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
    // A literal build-script move relocates already identified outputs without
    // evaluating the script. It cannot create a new source association.
    for (const script of Object.values(recordOf(manifest.scripts) ?? {})) {
      if (typeof script !== 'string') continue
      for (const match of script.matchAll(/(?:^|&&|;)\s*mv\s+([\w./-]+)\/\*\.js\s+([\w./-]+)(?=\s*(?:&&|;|$))/g)) {
        const from = resolve(root, match[1]!)
        const to = resolve(root, match[2]!)
        for (const [output, input] of [...mappings]) if (dirname(output) === from) add(resolve(to, relative(from, output)), input)
      }
    }
    const result = { manifest, mappings, patterns, roots, inputs }
    records.set(root, result)
    return result
  }
  const entries = packages.map((entry) => ({ ...entry, root: resolve(entry.root), name: readRecord(resolve(entry.root))?.manifest.name }))
  const aliases = entries
    .filter((entry) => typeof entry.name === 'string')
    .map((entry) => ({
      ...entry,
      prefix: resolve(entry.root, 'node_modules', String(entry.name))
    }))
  const unalias = (file: string): string => {
    const absolute = resolve(file)
    const alias = aliases.find((entry) => inside(absolute, entry.prefix))
    if (alias) return resolve(alias.root, relative(alias.prefix, absolute))
    // A dependency installed INSIDE the origin (`<origin>/node_modules/x`) is the
    // install's, not the checkout's: the checkout never holds it, and re-rooting
    // it there makes resolution walk past it to whatever version is hoisted.
    const origin = entries
      .filter(
        (entry) => entry.origin && inside(absolute, resolve(entry.origin)) && !inside(absolute, resolve(entry.origin, 'node_modules'))
      )
      .sort((left, right) => right.origin!.length - left.origin!.length)[0]
    return origin?.origin ? resolve(origin.root, relative(resolve(origin.origin), absolute)) : absolute
  }
  const sourceOf = (file: string): string => {
    const absolute = unalias(file)
    const root = packageOf(absolute)
    const record = root ? readRecord(root) : undefined
    const stated = record?.mappings.get(absolute)
    if (stated) return stated
    for (const [output, input] of record?.patterns ?? []) {
      const [prefix, suffix] = output.split('*')
      if (!prefix || suffix === undefined || !absolute.startsWith(prefix) || !absolute.endsWith(suffix)) continue
      const candidate = input.replace('*', absolute.slice(prefix.length, absolute.length - suffix.length))
      if (inside(candidate, root!) && host.fileExists(candidate)) return candidate
    }
    for (const [output, source] of record?.roots ?? []) {
      if (!inside(absolute, output)) continue
      const base = resolve(source, relative(output, absolute)).replace(/(?:\.d)?\.(?:js|jsx|mjs|cjs|ts|mts|cts)$/, '')
      const candidates = ['.ts', '.tsx', '.mts', '.cts'].map((extension) => `${base}${extension}`).filter(host.fileExists)
      if (candidates.length === 1 && candidates[0]) return candidates[0]
    }
    return host.fileExists(absolute) ? absolute : resolve(file)
  }
  const view: ts.ModuleResolutionHost = {
    ...host,
    fileExists: (file) => host.fileExists(sourceOf(file)),
    readFile: (file) => host.readFile(sourceOf(file)),
    directoryExists: (directory) => {
      if (aliases.some((entry) => inside(entry.prefix, resolve(directory)))) return true
      const dir = unalias(directory)
      if (host.directoryExists?.(dir)) return true
      const root = packageOf(`${dir}/__module__.ts`)
      const record = root ? readRecord(root) : undefined
      if ([...(record?.mappings.keys() ?? [])].some((file) => inside(file, dir))) return true
      if (record?.patterns.some(([pattern]) => inside(pattern, dir) || dir.startsWith(pattern.split('*')[0]!))) return true
      return (record?.roots ?? []).some(
        ([output, source]) => inside(dir, output) && host.directoryExists?.(resolve(source, relative(output, dir)))
      )
    },
    realpath: (file) => {
      const source = sourceOf(file)
      return host.realpath?.(source) ?? source
    }
  }
  return {
    host: view,
    sourceOf,
    containingFile: (specifier: string, containingFile: string): string => {
      const own = entries.find(
        (entry) => !entry.origin && typeof entry.name === 'string' && (specifier === entry.name || specifier.startsWith(`${entry.name}/`))
      )
      if (own) return resolve(own.root, '__geatsc_entry__.ts')
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        const source = entries
          .filter((entry) => entry.origin && inside(resolve(containingFile), entry.root))
          .sort((left, right) => right.root.length - left.root.length)[0]
        if (source?.origin) return resolve(source.origin, relative(source.root, containingFile))
      }
      return containingFile
    }
  }
}
