import ts from 'typescript'
import { dirname, resolve, basename, extname } from 'node:path'
import { createPackageSourceHost } from './package-sources.js'

export interface NodeProject {
  readonly root: string
  readonly manifest: Record<string, unknown>
  readonly projectFile: string | undefined
  readonly entries: readonly { name: string; file: string }[]
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Parse literal launch commands, never run a project's application or shell code. */
export const startEntry = (script: string, scripts: Record<string, unknown>, seen = new Set<string>()): string | undefined => {
  if (/[;&|`$<>\n]/.test(script)) return undefined
  const words = script.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) ?? []
  while (words[0] && /^[\w]+=[^\s]*$/.test(words[0])) words.shift()
  if (words[0] === 'cross-env') words.shift()
  while (words[0] && /^[\w]+=[^\s]*$/.test(words[0])) words.shift()
  const launcher = words.shift()
  if (['npm', 'pnpm', 'yarn'].includes(launcher ?? '')) {
    if (words[0] === 'run') words.shift()
    const name = words[0]
    if (!name || seen.has(name) || typeof scripts[name] !== 'string') return undefined
    seen.add(name)
    return startEntry(scripts[name], scripts, seen)
  }
  if (!['node', 'tsx', 'ts-node', 'ts-node-esm'].includes(launcher ?? '')) return undefined
  const takesValue = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader', '--conditions', '-C', '--project', '-P'])
  while (words[0]?.startsWith('-')) {
    const flag = words.shift()!
    if (['-e', '--eval', '-p', '--print', '--test'].includes(flag)) return undefined
    if (takesValue.has(flag)) words.shift()
  }
  return words[0]
}

export const discoverNodeProject = (directory: string, host: ts.System = ts.sys): NodeProject => {
  let root = resolve(directory)
  while (!host.fileExists(resolve(root, 'package.json'))) {
    const parent = dirname(root)
    if (parent === root) throw new Error(`No package.json found from ${directory}`)
    root = parent
  }
  const manifest = object(JSON.parse(host.readFile(resolve(root, 'package.json'))!))
  const projectFile = ts.findConfigFile(root, host.fileExists)
  const sources = createPackageSourceHost(host)
  const entryFile = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.includes('*')) return undefined
    const file = sources.sourceOf(resolve(root, value))
    if (host.fileExists(file) && !/\.d\.[cm]?ts$/.test(file)) return file
    if (!extname(file)) {
      const candidates = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((extension) => file + extension).filter(host.fileExists)
      if (candidates.length === 1) return candidates[0]
    }
    return undefined
  }
  const name = typeof manifest.name === 'string' ? manifest.name.split('/').pop()! : basename(root)
  const scripts = object(manifest.scripts)
  const launch = typeof scripts.start === 'string' ? startEntry(scripts.start, scripts) : undefined
  const launched = entryFile(launch)
  if (launched) return { root, manifest, projectFile, entries: [{ name, file: launched }] }
  if (launch) throw new Error(`The start script names ${launch}, but neither it nor its declared source exists.`)
  const bins = typeof manifest.bin === 'string' ? { [name]: manifest.bin } : object(manifest.bin)
  if (Object.keys(bins).length > 0) {
    const entries = Object.entries(bins).map(([name, value]) => {
      const file = entryFile(value)
      if (!file) throw new Error(`Cannot find the source for package bin ${name}: ${String(value)}`)
      return { name, file }
    })
    return { root, manifest, projectFile, entries }
  }
  const publicEntry = (value: unknown): string | undefined => {
    const direct = entryFile(value)
    if (direct) return direct
    const fields = object(value)
    if ('.' in fields) return publicEntry(fields['.'])
    for (const [key, target] of Object.entries(fields)) {
      if (!['node', 'import', 'require', 'default'].includes(key)) continue
      const file = publicEntry(target)
      if (file) return file
    }
    return undefined
  }
  const main = publicEntry(manifest.exports) ?? entryFile(manifest.main) ?? entryFile(manifest.source)
  if (main) return { root, manifest, projectFile, entries: [{ name, file: main }] }
  const conventional = ['src/index', 'src/main', 'src/server', 'index', 'main', 'server']
    .flatMap((stem) => ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((extension) => resolve(root, stem + extension)))
    .filter(host.fileExists)
  if (conventional.length === 1) return { root, manifest, projectFile, entries: [{ name, file: conventional[0]! }] }
  throw new Error(
    conventional.length > 1
      ? `Ambiguous application entry: ${conventional.join(', ')}. Declare scripts.start or bin in package.json.`
      : 'No executable entry was found. Declare scripts.start, bin, or main in package.json.'
  )
}
