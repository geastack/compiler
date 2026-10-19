import { readNativeIterableProviders } from './native-iterable-providers.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installedPlugins } from './installed.js'
import { noPluginCapabilities, type CompilerPlugin, type PluginInstance } from './model.js'
import { adoptApplePackage } from './apple/host.js'
import { applePlugin } from './apple/plugin.js'
import { adoptGeaPackage } from './gea/host.js'
import { geaPlugin } from './gea/plugin.js'
import { adoptWebglPackage } from './webgl/host.js'
import { webglPlugin } from './webgl/plugin.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const resolvePlugin = (specifier: string): string => {
  if (specifier.startsWith('file:')) return realpathSync(fileURLToPath(specifier))
  if (isAbsolute(specifier) || specifier.startsWith('.') || existsSync(resolve(specifier))) return realpathSync(resolve(specifier))
  return realpathSync(createRequire(join(process.cwd(), 'package.json')).resolve(specifier))
}

/**
 * The shipping build passes these packages' legacy entry points. Their native
 * implementations live in this compiler. Authenticate the package AND its
 * entry point: a custom plugin calling itself "gea" is not that adapter.
 *
 * Two shapes are authenticated. The file passed IS the package's entry
 * (`node_modules/@geastack/geatsc-plugin-gea/dist/index.js`): the nearest
 * manifest names the package and resolves to that file. Or the file is a
 * re-export shim -- an app's `geatsc-plugin.mjs` is one line re-exporting
 * `@geastack/native-webgl-angle`'s plugin -- whose nearest manifest is the
 * app's: then the package's entry is resolved from the shim's own location
 * and the loaded plugin object must be that module's default export by
 * identity, which no copy of the object can forge. The old CLI ignored
 * `--plugin` on `compile-module-graph` entirely, so the macOS build had
 * always compiled that app against the built-in webgl plugin; refusing the
 * shim here broke that build the day this loader landed.
 */
const legacyPackages = new Map([
  ['@geastack/geatsc-plugin-gea', { name: 'gea', entry: '' }],
  ['@geastack/geatsc-plugin-apple-native', { name: 'apple-native', entry: '' }],
  ['@geastack/native-webgl-angle', { name: 'native-webgl-angle-host', entry: '/geatsc-plugin' }]
])
/** The nearest manifest's path and package name, when it states one. */
const owningPackageOf = (file: string): { readonly manifest: string; readonly name: string | null } | null => {
  let directory = dirname(file)
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const metadata: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
      return { manifest, name: isRecord(metadata) && typeof metadata['name'] === 'string' ? metadata['name'] : null }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/**
 * The first shape, decided from the manifest alone, before the file is
 * imported. Evaluating a legacy package's entry only to replace it with the
 * built-in loaded the package's whole v1 pipeline, and with it the second copy
 * of TypeScript that pipeline imports -- ~7 MB of heap for the rest of a
 * compile that never calls into either.
 */
const legacyEntryAdapter = (file: string): CompilerPlugin | undefined => {
  const owner = owningPackageOf(file)
  const known = owner?.name == null ? undefined : legacyPackages.get(owner.name)
  if (owner === null || known === undefined) return undefined
  const entry = createRequire(owner.manifest).resolve(`${owner.name}${known.entry}`)
  return realpathSync(entry) === file ? installedPlugins.find((installed) => installed.name === known.name) : undefined
}

const legacyAdapter = async (file: string, name: string, plugin: unknown): Promise<CompilerPlugin | undefined> => {
  const builtIn = installedPlugins.find((installed) => installed.name === name)
  if (!builtIn) return undefined
  const owner = owningPackageOf(file)
  const known = owner?.name == null ? undefined : legacyPackages.get(owner.name)
  if (owner !== null && known?.name === name) {
    const entry = createRequire(owner.manifest).resolve(`${owner.name}${known.entry}`)
    return realpathSync(entry) === file ? builtIn : undefined
  }
  for (const [packageName, known] of legacyPackages) {
    if (known.name !== name) continue
    let entry: string
    try {
      entry = realpathSync(createRequire(file).resolve(`${packageName}${known.entry}`))
    } catch {
      continue
    }
    const loaded: unknown = await import(pathToFileURL(entry).href)
    if (isRecord(loaded) && loaded['default'] === plugin) return builtIn
  }
  return undefined
}

const optionalCapabilities = new Set([
  'typedArrayDeclarations',
  'commonJsGlobals',
  'commonJsBuiltinModules',
  'commonJsBuiltinModuleSources',
  'nativeTypesByDeclaration',
  'nativeReferenceIdentities',
  'nativeIterableProviders',
  'hostSingletonDeclarations',
  'hostInvocations',
  'hostInstanceTests',
  'hostNamespaceRootDeclarations'
])

/** Check the runtime contract before an invalid instance can enter certification. */
const validateInstance = (value: unknown): PluginInstance => {
  if (!isRecord(value)) throw new Error('instantiate(options) must return a PluginInstance object synchronously')
  for (const hook of ['producers', 'lower']) {
    if (typeof value[hook] !== 'function') throw new Error(`invalid PluginInstance: ${hook} must be a function`)
  }
  for (const hook of ['slotOf', 'lowerElementProp', 'transformSource', 'writeArtifacts']) {
    if (value[hook] !== undefined && typeof value[hook] !== 'function')
      throw new Error(`invalid PluginInstance: ${hook} must be a function`)
  }
  const capabilities = value['capabilities']
  if (!isRecord(capabilities)) throw new Error('invalid PluginInstance: capabilities must be an object')
  const checkShape = (actual: unknown, example: unknown, path: string): void => {
    const valid =
      example instanceof Map
        ? actual instanceof Map
        : example instanceof Set
          ? actual instanceof Set
          : Array.isArray(example)
            ? Array.isArray(actual)
            : example === null
              ? actual === null || typeof actual === 'string'
              : isRecord(actual)
    if (!valid) throw new Error(`invalid PluginInstance: ${path} has an incompatible type`)
    if (isRecord(example) && !(example instanceof Map) && !(example instanceof Set) && !Array.isArray(example)) {
      for (const [key, item] of Object.entries(example)) checkShape((actual as Record<string, unknown>)[key], item, `${path}.${key}`)
    }
  }
  for (const [key, example] of Object.entries(noPluginCapabilities)) {
    if (capabilities[key] === undefined && optionalCapabilities.has(key)) continue
    checkShape(capabilities[key], example, `capabilities.${key}`)
  }
  for (const key of ['hostMethodBindings']) {
    if (capabilities[key] !== undefined) checkShape(capabilities[key], new Map(), `capabilities.${key}`)
  }
  for (const key of [
    'declarationModules',
    'hostArraySnapshotFunctions',
    'hostNativeArrayFunctions',
    'parallelRegionEntries',
    'nativeReferenceIdentities'
  ]) {
    if (capabilities[key] !== undefined) checkShape(capabilities[key], new Set(), `capabilities.${key}`)
  }
  for (const key of ['hostFunctions', 'nativeTypes', 'nativeConstants', 'hostNamespaceRootTypes']) {
    for (const [name, spelling] of capabilities[key] as Map<unknown, unknown>) {
      if (typeof name !== 'string' || typeof spelling !== 'string')
        throw new Error(`invalid PluginInstance: capabilities.${key} must map strings to strings`)
    }
  }
  if (capabilities['nativeIterableProviders'] !== undefined) readNativeIterableProviders(capabilities['nativeIterableProviders'])
  if (capabilities['nativeReferenceIdentities'] !== undefined) {
    for (const native of capabilities['nativeReferenceIdentities'] as Set<unknown>) {
      if (typeof native !== 'string' || native.length === 0)
        throw new Error('invalid PluginInstance: nativeReferenceIdentities must contain nonempty strings')
    }
  }
  for (const [name, lines] of capabilities['hostPreambles'] as Map<unknown, unknown>) {
    if (typeof name !== 'string' || !Array.isArray(lines) || !lines.every((line: unknown) => typeof line === 'string')) {
      throw new Error('invalid PluginInstance: capabilities.hostPreambles must map strings to string arrays')
    }
  }
  return value as unknown as PluginInstance
}

/**
 * The adapter's tables come from the package's own statement, and the
 * statement must be the package this path names -- not the copy the compiler's
 * own `node_modules` happens to hold (`host-package.ts`).
 */
const adoptLegacyPackage = (adapter: CompilerPlugin, file: string): void => {
  if (adapter === webglPlugin) adoptWebglPackage(file)
  else if (adapter === geaPlugin) adoptGeaPackage(file)
  else if (adapter === applePlugin) adoptApplePackage(file)
}

/**
 * Built-ins retain their order; explicit plugins follow in flag order. The
 * compiler API owns capability and hook precedence. Duplicate module paths
 * (including symlinks) load once; distinct definitions of one name fail.
 */
export const loadCliPlugins = async (specifiers: readonly string[]): Promise<readonly CompilerPlugin[]> => {
  const plugins = [...installedPlugins]
  const names = new Map(installedPlugins.map((plugin) => [plugin.name, 'built-in']))
  const loadedPaths = new Set<string>()
  for (const specifier of specifiers) {
    try {
      const file = resolvePlugin(specifier)
      if (loadedPaths.has(file)) continue
      const entryAdapter = legacyEntryAdapter(file)
      if (entryAdapter) {
        adoptLegacyPackage(entryAdapter, file)
        process.stderr.write(`compile: --plugin ${specifier}: using built-in "${entryAdapter.name}" adapter for the legacy package\n`)
        loadedPaths.add(file)
        continue
      }
      const loaded: unknown = await import(pathToFileURL(file).href)
      if (!isRecord(loaded)) throw new Error('expected a plugin module')
      // Named geatscPlugin wins only when there is no default. Never guess
      // among unrelated exported functions (bridge generators, analyzers, etc.).
      const exported: unknown = loaded['default'] ?? loaded['geatscPlugin']
      const plugin: unknown = typeof exported === 'function' ? (exported as () => unknown)() : exported
      if (!isRecord(plugin) || typeof plugin['name'] !== 'string' || plugin['name'].trim().length === 0) {
        throw new Error('expected default or geatscPlugin export: a CompilerPlugin object or synchronous factory returning one')
      }
      const name = plugin['name']
      if (typeof plugin['instantiate'] !== 'function') {
        const adapter = typeof plugin['configure'] === 'function' ? await legacyAdapter(file, name, exported) : undefined
        if (!adapter) throw new Error(`plugin "${name}" is incompatible: expected instantiate(options); legacy hooks are not supported`)
        adoptLegacyPackage(adapter, file)
        process.stderr.write(`compile: --plugin ${specifier}: using built-in "${adapter.name}" adapter for the legacy package\n`)
        loadedPaths.add(file)
        continue
      }
      const definition = plugin as unknown as CompilerPlugin
      // Importing a built-in object explicitly is also an idempotent request.
      if (installedPlugins.some((installed) => installed === definition)) {
        loadedPaths.add(file)
        continue
      }
      const previous = names.get(name)
      if (previous !== undefined) throw new Error(`duplicate plugin name "${name}" conflicts with ${previous}`)
      plugins.push({
        name,
        instantiate: (options) => {
          try {
            return validateInstance(definition.instantiate(options))
          } catch (error: unknown) {
            throw new Error(`--plugin ${specifier} ("${name}"): ${messageOf(error)}`)
          }
        }
      })
      names.set(name, specifier)
      loadedPaths.add(file)
    } catch (error: unknown) {
      throw new Error(`--plugin ${specifier}: ${messageOf(error)}`)
    }
  }
  return plugins
}
