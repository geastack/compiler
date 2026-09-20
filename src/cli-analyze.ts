import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `analyze <entry> --plugin <module> [--plugin-option k=v]...` asks the named
 * plugin which host bindings and host features the program at `entry` reaches,
 * and prints them as the two lines every board build already parses
 * (`bindings=a;b`, `features=x`).
 *
 * The compiler owns none of the answer. Which import name is a host binding,
 * and which binding drags a network stack in, is the plugin package's
 * knowledge, shipped as its `analyzeHostBindings` hook; this command is only
 * the dispatch to it. It exists so a board's CMake and the capability resolver
 * keep one contract instead of each learning to load a plugin module -- the
 * eight esp32 boards, their resident-app loops, and
 * `scripts/esp32-app-capabilities.mjs` all speak this one.
 *
 * This scan runs before a program exists (CMake configure, ahead of the
 * vite/geatsc bundle), so it invokes the package's analysis hook directly.
 * Compilation instead uses CompilerPlugin instances and the built-in native
 * adapters for the legacy Gea and Apple packages.
 */

interface HostBindingAnalysis {
  readonly bindings?: readonly string[]
  readonly features?: readonly string[]
}

interface AnalyzeContext {
  readonly entry: string
  readonly options: Readonly<Record<string, string>>
}

interface AnalyzeArguments {
  readonly entry: string | null
  readonly plugin: string | null
  readonly options: Readonly<Record<string, string>>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseAnalyzeArguments = (argv: readonly string[]): AnalyzeArguments => {
  let entry: string | null = null
  let plugin: string | null = null
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '--plugin') {
      plugin = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--plugin-option') {
      const pair = argv[index + 1] ?? ''
      const split = pair.indexOf('=')
      if (split > 0) options[pair.slice(0, split)] = pair.slice(split + 1)
      index += 1
    } else if (!argument.startsWith('--') && entry === null) {
      entry = argument
    }
  }
  return { entry, plugin, options }
}

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const loadAnalyzer = async (pluginPath: string): Promise<((context: AnalyzeContext) => unknown) | null> => {
  const loaded: unknown = await import(pathToFileURL(resolve(pluginPath)).href)
  if (!isRecord(loaded)) return null
  const factory = loaded['default'] ?? loaded['geatscPlugin']
  if (typeof factory !== 'function') return null
  const plugin: unknown = (factory as () => unknown)()
  if (!isRecord(plugin)) return null
  const hook = plugin['analyzeHostBindings']
  if (typeof hook !== 'function') return null
  return (context) => (hook as (context: AnalyzeContext) => unknown).call(plugin, context)
}

export const runAnalyze = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseAnalyzeArguments(argv)
  if (!parsed.entry || !parsed.plugin) {
    process.stderr.write('usage: geatsc analyze <entry> --plugin <module> [--plugin-option <key>=<value>]...\n')
    return 1
  }
  const analyze = await loadAnalyzer(parsed.plugin)
  if (!analyze) {
    process.stderr.write(`analyze: ${parsed.plugin} does not export a plugin factory with an analyzeHostBindings hook\n`)
    return 1
  }
  const analysis: unknown = analyze({ entry: resolve(parsed.entry), options: parsed.options })
  const result: HostBindingAnalysis = isRecord(analysis)
    ? { bindings: stringList(analysis['bindings']), features: stringList(analysis['features']) }
    : {}
  process.stdout.write(`bindings=${[...new Set(result.bindings ?? [])].sort().join(';')}\n`)
  process.stdout.write(`features=${[...new Set(result.features ?? [])].sort().join(';')}\n`)
  return 0
}
