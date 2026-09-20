// The corpus oracle asks the compiler's resolver which source implements an
// import, then lets Node/tsx execute it. It never borrows the native host shims.
import { registerHooks, isBuiltin } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, dirname, sep } from 'node:path'
import ts from 'typescript'
import { createModuleResolver } from './module-resolution.js'
import { defaultCompilerOptions } from './program.js'
import type { PackageSource } from './package-sources.js'

interface SourceContext {
  readonly root: string
  readonly packageSources: readonly PackageSource[]
  readonly projectFile?: string
}
const serialized = process.env.GEATSC_SOURCE_CONTEXT
if (serialized) {
  const context = JSON.parse(serialized) as SourceContext
  let options: ts.CompilerOptions = { ...defaultCompilerOptions, types: [] }
  if (context.projectFile) {
    const config = ts.readConfigFile(context.projectFile, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
    options = { ...options, ...ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(context.projectFile)).options }
  }
  const resolver = createModuleResolver(ts.sys, options, new Set(), context.packageSources)
  const selected = new Set<string>()
  const roots = [resolve(context.root), ...context.packageSources.map((source) => resolve(source.root))]
  const inSource = (url: string | undefined): boolean => {
    if (!url?.startsWith('file:')) return false
    const file = fileURLToPath(url)
    return selected.has(url) || roots.some((root) => file === root || file.startsWith(`${root}${sep}`))
  }
  registerHooks({
    resolve(specifier, hookContext, nextResolve) {
      if (isBuiltin(specifier) || (!inSource(hookContext.parentURL) && !inSource(specifier))) return nextResolve(specifier, hookContext)
      if (specifier.startsWith('file:') && (specifier.includes('?') || specifier.includes('#'))) return nextResolve(specifier, hookContext)
      const from = hookContext.parentURL?.startsWith('file:') ? fileURLToPath(hookContext.parentURL) : resolve(context.root, '__entry__.ts')
      const name = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
      const mode = hookContext.conditions.includes('require') ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext
      const result = resolver.resolve(name, from, mode).implementation
      if (!result) return nextResolve(specifier, hookContext)
      const url = pathToFileURL(result.resolvedFileName).href
      selected.add(url)
      return nextResolve(url, hookContext)
    },
    load(url, hookContext, nextLoad) {
      if (!selected.has(url) || !/\.[cm]?tsx?$/.test(fileURLToPath(url))) return nextLoad(url, hookContext)
      const file = fileURLToPath(url)
      const source = ts.sys.readFile(file)
      if (source === undefined) throw new Error(`Source disappeared: ${file}`)
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      const commonJS =
        file.endsWith('.cts') || ast.statements.some((statement) => ts.isExportAssignment(statement) && statement.isExportEquals)
      // A source checkout may have type:commonjs while its published import
      // branch is ESM. Transpile the source module itself; package-scope format
      // inference would add a spurious second default export around it.
      const transformed = ts.transpileModule(source, {
        fileName: file,
        compilerOptions: { ...options, module: commonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, noEmit: false, declaration: false }
      })
      return { format: commonJS ? 'commonjs' : 'module', source: transformed.outputText, shortCircuit: true }
    }
  })
}
