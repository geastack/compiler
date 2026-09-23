import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createPackageSourceHost, type PackageSource } from './semantics/package-sources.js'

export type Manifest = Record<string, unknown>
const object = (value: unknown): Manifest =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Manifest) : {}
export interface SourceFileSystem {
  readonly exists: (file: string) => boolean
  readonly read: (file: string) => string
  readonly write: (file: string, text: string) => void
  readonly realpath: (file: string) => string
}
const disk: SourceFileSystem = {
  exists: existsSync,
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, text) => {
    writeFileSync(file, text)
  },
  realpath: realpathSync
}
const manifestAt = (root: string, files: SourceFileSystem = disk): Manifest => object(JSON.parse(files.read(join(root, 'package.json'))))
/**
 * The running compiler's own package name, read off its manifest rather than
 * spelled here, so a rename or a fork still recognises itself.
 *
 * The dependency walk below stops at this package. A program never imports
 * its compiler, so nothing reachable only through the compiler's manifest can
 * be program input -- but node-compat states the compiler as a peer, and the
 * compiler in turn states TypeScript as a dependency and the Apple package
 * (hence the whole gea toolchain) as peers. Walking through it acquired the
 * TypeScript repository twice, Babel four times, Vite, Rolldown and Postcss
 * for `raw-http-hello`, a program whose only import is `node:http`: 2.1 GB of
 * checkouts and a serial registry round trip per package, on every cold cache.
 */
const ownPackageName = (): string | undefined => {
  try {
    const name = manifestAt(resolve(dirname(fileURLToPath(import.meta.url)), '..')).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}
const run = (command: string, args: readonly string[], cwd: string): string => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
  return result.stdout.trim()
}
export const installedPackage = (name: string, from: string, files: SourceFileSystem = disk): string | undefined => {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return undefined
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, 'node_modules', name)
    if (files.exists(join(candidate, 'package.json'))) return files.realpath(candidate)
    const parent = dirname(directory)
    if (directory === parent) return undefined
    directory = parent
  }
}

export const dependencyInstallCommand = (
  manifest: Manifest,
  locks: ReadonlySet<string>
): { command: string; args: string[]; env: Record<string, string> } => {
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager : ''
  const manager = declared.split('@')[0] || (locks.has('pnpm-lock.yaml') ? 'pnpm' : locks.has('yarn.lock') ? 'yarn' : 'npm')
  if (manager === 'npm')
    return {
      command: manager,
      args: [
        locks.has('package-lock.json') || locks.has('npm-shrinkwrap.json') ? 'ci' : 'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund'
      ],
      env: {}
    }
  if (manager === 'pnpm')
    return {
      command: manager,
      args: ['install', '--ignore-scripts', ...(locks.has('pnpm-lock.yaml') ? ['--frozen-lockfile'] : [])],
      env: {}
    }
  if (manager === 'yarn') {
    const modern = /^yarn@(?:[2-9]|[1-9][0-9])\./.test(declared)
    return {
      command: manager,
      args: [
        'install',
        ...(modern
          ? locks.has('yarn.lock')
            ? ['--immutable']
            : []
          : ['--ignore-scripts', ...(locks.has('yarn.lock') ? ['--frozen-lockfile'] : [])])
      ],
      env: modern ? { YARN_ENABLE_SCRIPTS: 'false' } : {}
    }
  }
  throw new Error(`Unsupported package manager: ${manager}`)
}

/** Install through the project's chosen package manager, without lifecycle execution. */
export const ensureDependencies = (directory: string, log: (message: string) => void = console.error): void => {
  const manifest = manifestAt(directory)
  const required = Object.keys({ ...object(manifest.dependencies), ...object(manifest.devDependencies) })
  if (required.every((name) => installedPackage(name, directory))) return
  let root = directory
  const lockNames = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json']
  for (let parent = directory; ; parent = dirname(parent)) {
    if (lockNames.some((name) => existsSync(join(parent, name)))) {
      root = parent
      break
    }
    if (dirname(parent) === parent) break
  }
  const owner = existsSync(join(root, 'package.json')) ? manifestAt(root) : manifest
  const plan = dependencyInstallCommand(owner, new Set(lockNames.filter((name) => existsSync(join(root, name)))))
  log(`[geatsc] Installing dependencies with ${plan.command}`)
  const result = spawnSync(plan.command, plan.args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...plan.env } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${plan.command} dependency installation failed (${result.status ?? result.signal})`)
}

export interface SourceIdentity {
  readonly url: string
  readonly commit: string
  readonly directory: string
}
const repositoryIdentity = (metadata: Manifest): { url: string; directory: string } | undefined => {
  const repository = typeof metadata.repository === 'string' ? { url: metadata.repository } : object(metadata.repository)
  if (typeof repository.url !== 'string') return undefined
  let url = repository.url.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/')
  if (url.startsWith('github:')) url = `https://github.com/${url.slice(7)}`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) return undefined
  const directory = typeof repository.directory === 'string' ? repository.directory : '.'
  if (isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) return undefined
  return { url, directory }
}
export const sourceIdentity = (metadata: Manifest): SourceIdentity | undefined => {
  if (typeof metadata.gitHead !== 'string' || !/^[a-f0-9]{40}$/i.test(metadata.gitHead)) return undefined
  const repository = repositoryIdentity(metadata)
  return repository ? { ...repository, commit: metadata.gitHead.toLowerCase() } : undefined
}

const decodedPayload = (entry: unknown): Manifest | undefined => {
  const envelope = object(object(entry).bundle).dsseEnvelope
  const payload = object(envelope).payload
  if (typeof payload !== 'string') return undefined
  try {
    return object(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')))
  } catch {
    return undefined
  }
}

/** Recover the exact source commit from npm's signed publication provenance when legacy gitHead metadata is absent. */
export const provenanceSourceIdentity = (metadata: Manifest, response: Manifest): SourceIdentity | undefined => {
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') return undefined
  const repository = repositoryIdentity(metadata)
  if (!repository) return undefined
  const dist = object(metadata.dist)
  const integrity = typeof dist.integrity === 'string' ? dist.integrity.match(/^sha512-(.+)$/)?.[1] : undefined
  if (!integrity) return undefined
  const expectedDigest = Buffer.from(integrity, 'base64').toString('hex')
  const encodedName = encodeURIComponent(metadata.name).replace(/%2F/gi, '/')
  const expectedSubject = `pkg:npm/${encodedName}@${metadata.version}`
  const expectedRepository = repository.url.replace(/\.git$/, '').replace(/\/$/, '')
  const entries = Array.isArray(response.attestations) ? response.attestations : []
  for (const entry of entries) {
    if (object(entry).predicateType !== 'https://slsa.dev/provenance/v1') continue
    const payload = decodedPayload(entry)
    if (!payload || payload.predicateType !== 'https://slsa.dev/provenance/v1') continue
    const subjects = Array.isArray(payload.subject) ? payload.subject : []
    const subject = subjects.find((candidate) => object(candidate).name === expectedSubject)
    if (object(object(subject).digest).sha512 !== expectedDigest) continue
    const definition = object(object(payload.predicate).buildDefinition)
    const dependencies = Array.isArray(definition.resolvedDependencies) ? definition.resolvedDependencies : []
    for (const dependency of dependencies) {
      const record = object(dependency)
      const commit = object(record.digest).gitCommit
      if (typeof record.uri !== 'string' || typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) continue
      const separator = record.uri.lastIndexOf('@')
      if (separator < 0) continue
      const source = record.uri
        .slice(0, separator)
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
        .replace(/\/$/, '')
      if (source !== expectedRepository) continue
      return { ...repository, commit: commit.toLowerCase() }
    }
  }
  return undefined
}

/** Every runtime target a manifest's root entry names: `exports["."]` without `types`, else `main`. */
const rootEntryTargets = (manifest: Manifest): readonly string[] => {
  const targets = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(targets)
    return Object.entries(object(value)).flatMap(([condition, entry]) => (condition === 'types' ? [] : targets(entry)))
  }
  const exports = manifest.exports
  if (exports !== undefined) {
    const subpaths = Object.keys(object(exports)).some((key) => key.startsWith('.'))
    return targets(subpaths ? object(exports)['.'] : exports)
  }
  return [typeof manifest.main === 'string' ? manifest.main : 'index.js']
}

/**
 * Whether a checkout can stand in for the installed package: every runtime
 * target of its root entry resolves in the checkout, directly or through a
 * build input the source host maps. A package built from JavaScript keeps
 * pointing into a `dist/` the checkout never built, and replacing the
 * installed package with it leaves every importer resolving nothing.
 */
const checkoutServesRootEntry = (packageRoot: string, files: SourceFileSystem): boolean => {
  const sources = createPackageSourceHost(
    { fileExists: files.exists, readFile: (file) => (files.exists(file) ? files.read(file) : undefined) },
    [{ root: packageRoot }]
  )
  const targets = rootEntryTargets(manifestAt(packageRoot, files))
  return (
    targets.length > 0 && targets.every((target) => !target.includes('*') && files.exists(sources.sourceOf(resolve(packageRoot, target))))
  )
}

export interface PreparationOptions {
  readonly files?: SourceFileSystem
  readonly log?: (message: string) => void
  readonly metadata?: (name: string, version: string, root: string) => Promise<Manifest>
  readonly attestations?: (url: string, root: string) => Promise<Manifest>
  readonly checkout?: (identity: SourceIdentity, destination: string) => void
}
const fetchAttestations = async (url: string): Promise<Manifest> => {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Invalid provenance URL')
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Provenance request failed (${response.status})`)
  return object(await response.json())
}
const checkout = (identity: SourceIdentity, destination: string): void => {
  mkdirSync(destination, { recursive: true })
  run('git', ['init', '--quiet', destination], destination)
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never']
  run('git', [...args, 'fetch', '--quiet', '--depth=1', '--no-tags', identity.url, identity.commit], destination)
  // This is a newly created compiler-owned cache, never a user checkout.
  run('git', [...args, 'checkout', '--quiet', '--detach', identity.commit], destination)
  if (run('git', ['rev-parse', 'HEAD'], destination) !== identity.commit)
    throw new Error('Source checkout did not match the published commit')
}

/** Acquire missing typed sources at the installed version; plain JS remains usable. */
export const preparePackageSources = async (root: string, options: PreparationOptions = {}): Promise<readonly PackageSource[]> => {
  const files = options.files ?? disk
  const log = options.log ?? console.error
  const metadata =
    options.metadata ?? (async (name, version, cwd) => object(JSON.parse(run('npm', ['view', `${name}@${version}`, '--json'], cwd))))
  const attestations = options.attestations ?? (async (url) => fetchAttestations(url))
  const sources: PackageSource[] = []
  const visited = new Set<string>()
  const compiler = ownPackageName()
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const directory = pending.shift()!
    if (visited.has(directory) || !files.exists(join(directory, 'package.json'))) continue
    visited.add(directory)
    const manifest = manifestAt(directory, files)
    if (compiler !== undefined && manifest.name === compiler) continue
    for (const name of Object.keys({
      ...object(manifest.dependencies),
      ...object(manifest.optionalDependencies),
      ...object(manifest.peerDependencies)
    })) {
      const installed = installedPackage(name, directory, files)
      if (installed) pending.push(installed)
    }
    if (directory === resolve(root) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    // Authored JavaScript already is source. Only generated packages with type
    // metadata benefit from acquiring the missing TypeScript build inputs.
    const serialized = JSON.stringify({ main: manifest.main, exports: manifest.exports })
    if (!/(?:dist|lib|build)\//.test(serialized) || !/\.d\.[cm]?ts|"types"|"typings"/.test(JSON.stringify(manifest))) continue
    if (files.exists(join(directory, 'src')) || files.exists(join(directory, 'tsconfig.json'))) continue
    // Keyed by the published identity alone. A version is published once, so
    // every installed copy of it -- hoisted, or nested under a dependency that
    // pinned it -- names the same commit, and the checkout is one checkout.
    // Keying on the install directory as well fetched TypeScript's repository
    // once per `node_modules` it appeared in.
    const cache = join(
      root,
      'node_modules',
      '.cache',
      'geatsc',
      'sources',
      createHash('sha256').update(`${manifest.name}@${manifest.version}`).digest('hex').slice(0, 24)
    )
    const record = join(cache, 'source.json')
    try {
      if (files.exists(record)) {
        const saved = object(JSON.parse(files.read(record)))
        if (
          saved.name === manifest.name &&
          saved.version === manifest.version &&
          typeof saved.root === 'string' &&
          files.exists(join(saved.root, 'package.json'))
        ) {
          if (checkoutServesRootEntry(saved.root, files)) sources.push({ root: saved.root, origin: directory })
          else log(`[geatsc] ${manifest.name}@${manifest.version}: checkout does not resolve the package entry; using installed JavaScript`)
          continue
        }
      }
      const published = await metadata(manifest.name, manifest.version, directory)
      if (published.name !== manifest.name || published.version !== manifest.version)
        throw new Error('Registry returned a different package version')
      let identity = sourceIdentity(published)
      const provenanceUrl = object(object(published.dist).attestations).url
      if (!identity && typeof provenanceUrl === 'string')
        identity = provenanceSourceIdentity(published, await attestations(provenanceUrl, directory))
      if (!identity) {
        log(`[geatsc] ${manifest.name}@${manifest.version}: no pinned source metadata; using installed JavaScript`)
        continue
      }
      const destination = join(cache, identity.commit)
      log(`[geatsc] Fetching ${manifest.name}@${manifest.version} source (${identity.commit.slice(0, 12)})`)
      ;(options.checkout ?? checkout)(identity, destination)
      const packageRoot = resolve(destination, identity.directory)
      const found = manifestAt(packageRoot, files)
      if (found.name !== manifest.name || found.version !== manifest.version)
        throw new Error('Checkout package identity does not match the installed package')
      files.write(
        record,
        `${JSON.stringify({ name: manifest.name, version: manifest.version, ...identity, root: packageRoot }, null, 2)}\n`
      )
      if (checkoutServesRootEntry(packageRoot, files)) sources.push({ root: packageRoot, origin: directory })
      else log(`[geatsc] ${manifest.name}@${manifest.version}: checkout does not resolve the package entry; using installed JavaScript`)
    } catch (error) {
      log(
        `[geatsc] ${manifest.name}@${manifest.version}: source unavailable (${error instanceof Error ? error.message : String(error)}); using installed JavaScript`
      )
    }
  }
  return sources
}
