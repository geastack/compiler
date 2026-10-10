import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, readdirSync, rmSync } from 'node:fs'
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
  /** Subdirectory names of a directory; absent, a checkout is never searched. */
  readonly directories?: (directory: string) => readonly string[]
}
const disk: SourceFileSystem = {
  exists: existsSync,
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, text) => {
    // The negative marker is the first thing written into a package's cache
    // directory when nothing was checked out there.
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  },
  realpath: realpathSync,
  directories: (directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
}
const manifestAt = (root: string, files: SourceFileSystem = disk): Manifest => object(JSON.parse(files.read(join(root, 'package.json'))))
/**
 * The running compiler's own package name, read off its manifest rather than
 * spelled here, so a rename or a fork still recognises itself.
 *
 * The dependency walk below stops at this package. A program never imports
 * its compiler, so nothing reachable only through the compiler's manifest can
 * be program input -- but a host package states the compiler as a peer, and the
 * compiler in turn states TypeScript as a dependency and the Apple package
 * (hence the whole gea toolchain) as peers. Walking through it acquired the
 * TypeScript repository twice, Babel four times, Vite, Rolldown and Postcss
 * for a minimal HTTP server whose only import is `node:http`: 2.1 GB of
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

export interface PreparationOptions {
  readonly files?: SourceFileSystem
  readonly log?: (message: string) => void
  readonly metadata?: (name: string, version: string, root: string) => Promise<Manifest>
  readonly attestations?: (url: string, root: string) => Promise<Manifest>
  readonly checkout?: (identity: SourceIdentity, destination: string) => void
  /** Unpack the published tarball of `spec` (`name@range`) so its `package.json` sits at `destination`. */
  readonly fetchPackage?: (spec: string, destination: string) => void
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

const fetchPackage = (spec: string, destination: string): void => {
  mkdirSync(destination, { recursive: true })
  const tarball = run('npm', ['pack', spec, '--silent', '--ignore-scripts', '--pack-destination', destination], destination)
    .split('\n')
    .pop()
  if (!tarball) throw new Error(`npm pack ${spec} produced no tarball`)
  run('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination], destination)
  rmSync(join(destination, tarball))
}

/** Whether an installed package states its own declarations, so a DefinitelyTyped package adds nothing. */
const shipsDeclarations = (directory: string, manifest: Manifest, files: SourceFileSystem): boolean =>
  typeof manifest.types === 'string' ||
  typeof manifest.typings === 'string' ||
  /"types"\s*:/.test(JSON.stringify(manifest.exports ?? null)) ||
  files.exists(join(directory, 'index.d.ts'))

/** The DefinitelyTyped package that describes `name`. */
const typesPackageOf = (name: string): string => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`

/** The runtime package a DefinitelyTyped package describes. */
const describedPackageOf = (typesName: string): string => {
  const bare = typesName.slice('@types/'.length)
  return bare.includes('__') ? `@${bare.replace('__', '/')}` : bare
}

/**
 * The DefinitelyTyped declarations a source checkout compiles against.
 *
 * A package whose runtime dependency is untyped JavaScript names that
 * dependency's `@types/*` package as a DEVELOPMENT dependency: its own build
 * needs it, its published declarations do not. The installed tree therefore
 * has the JavaScript and not its declarations -- a package imports an untyped
 * dependency and names one of its types, which only that dependency's
 * `@types/*` package declares. Compiling the checkout without them turns
 * every such name into a checker error.
 *
 * Only the `@types/*` counterpart of a runtime package that is installed and
 * ships no declarations of its own is fetched, at the range the checkout
 * states, and a fetched declaration package's own `@types/*` dependencies
 * under the same rule (an `@types/*` package may import another untyped
 * package's types). `@types/node` never qualifies: no installed package is named `node`.
 *
 * It goes into the `node_modules` holding the package it describes -- where
 * `npm install -D` would have put it. That is where the declaration overlay
 * pairs a JavaScript module with its DefinitelyTyped mirror
 * (`declaration-overlay-transform.ts`), and where module resolution from both
 * the checkout and the package finds it.
 */
const provideDevelopmentTypes = (
  packageRoot: string,
  origin: string,
  files: SourceFileSystem,
  fetch: (spec: string, destination: string) => void
): void => {
  const manifest = manifestAt(packageRoot, files)
  const development = object(manifest.devDependencies)
  const wanted: [string, string][] = Object.keys({ ...object(manifest.dependencies), ...object(manifest.optionalDependencies) }).flatMap(
    (name) => {
      const range = development[typesPackageOf(name)]
      return typeof range === 'string' ? [[typesPackageOf(name), range] as [string, string]] : []
    }
  )
  const seen = new Set<string>()
  while (wanted.length > 0) {
    const [typesName, range] = wanted.shift()!
    if (seen.has(typesName)) continue
    seen.add(typesName)
    const described = describedPackageOf(typesName)
    const installed = installedPackage(described, origin, files)
    if (!installed || !installed.endsWith(`/node_modules/${described}`)) continue
    if (shipsDeclarations(installed, manifestAt(installed, files), files)) continue
    let destination = installedPackage(typesName, installed, files)
    if (!destination) {
      destination = join(installed.slice(0, installed.length - described.length), typesName)
      fetch(`${typesName}@${range}`, destination)
    }
    for (const [dependency, dependencyRange] of Object.entries(object(manifestAt(destination, files).dependencies)))
      if (dependency.startsWith('@types/') && typeof dependencyRange === 'string') wanted.push([dependency, dependencyRange])
  }
}

/** Every runtime file the manifest publishes: `main`, `module`, and each non-type `exports` target. */
const runtimeOutputs = (manifest: Manifest): string[] => {
  const outputs: string[] = []
  for (const field of ['main', 'module']) if (typeof manifest[field] === 'string') outputs.push(manifest[field])
  const visit = (value: unknown, condition?: string): void => {
    if (typeof value === 'string') {
      if (condition !== 'types' && !/\.d\.[cm]?ts$/.test(value)) outputs.push(value)
    } else if (Array.isArray(value)) value.forEach((entry) => visit(entry, condition))
    else for (const [key, entry] of Object.entries(object(value))) visit(entry, key)
  }
  visit(manifest.exports)
  return outputs
}

/**
 * Whether the installed package already proves which typed file one of its
 * runtime outputs was built from, through the same metadata the resolver reads
 * (a tsconfig outDir/rootDir pair, a `source` condition, a static Rollup
 * input). Shipping a `src/` directory is not that proof: a package may
 * publish `src/` beside a Rollup bundle but no build config, so nothing maps
 * the bundle back to `src/index.ts` and the compiled bundle would be silently
 * used instead -- the checkout carries the `rollup.config.mjs` that does.
 */
const installedSourceMapped = (directory: string, manifest: Manifest, files: SourceFileSystem): boolean => {
  const { sourceOf } = createPackageSourceHost({
    fileExists: files.exists,
    readFile: (file) => (files.exists(file) ? files.read(file) : undefined)
  })
  return runtimeOutputs(manifest).some((output) => {
    const file = resolve(directory, output)
    const source = sourceOf(file)
    return source !== file && /\.(?:ts|tsx|mts|cts)$/.test(source) && !/\.d\.[cm]?ts$/.test(source)
  })
}

/**
 * The directory inside a checkout that IS the installed package: its manifest
 * must name the installed package at the installed version. The repository's
 * stated `directory` is authoritative when it names one. When it does not and
 * the checkout root is some other package -- a monorepo whose published
 * manifest omits `repository.directory` -- the checkout at the exact published
 * commit is searched for the one manifest with that name and version. Zero or
 * several matches refuse, exactly as a mismatched root does.
 */
const checkoutPackageRoot = (destination: string, directory: string, manifest: Manifest, files: SourceFileSystem): string => {
  const matches = (root: string): boolean => {
    if (!files.exists(join(root, 'package.json'))) return false
    const found = manifestAt(root, files)
    return found.name === manifest.name && found.version === manifest.version
  }
  const stated = resolve(destination, directory)
  if (matches(stated)) return stated
  if (directory === '.' && files.directories) {
    const found: string[] = []
    const search = (root: string, depth: number): void => {
      for (const name of files.directories!(root)) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const child = join(root, name)
        if (matches(child)) found.push(child)
        else if (depth < 3) search(child, depth + 1)
      }
    }
    search(destination, 0)
    if (found.length === 1) return found[0]!
  }
  throw new Error('Checkout package identity does not match the installed package')
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
    if (installedSourceMapped(directory, manifest, files)) continue
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
    // A registry that names no pinned source for a published version names none
    // later either (a version is published once), but asking costs a serial
    // `npm view` per package on every build. Recorded beside the positive
    // record; only this definite answer is cached, never a failed request.
    const unpinned = join(cache, 'no-source.json')
    try {
      if (files.exists(unpinned)) {
        const saved = object(JSON.parse(files.read(unpinned)))
        if (saved.name === manifest.name && saved.version === manifest.version && saved.unpinned === true) {
          log(`[geatsc] ${manifest.name}@${manifest.version}: no pinned source metadata (cached); using installed JavaScript`)
          continue
        }
      }
      if (files.exists(record)) {
        const saved = object(JSON.parse(files.read(record)))
        if (
          saved.name === manifest.name &&
          saved.version === manifest.version &&
          typeof saved.root === 'string' &&
          files.exists(join(saved.root, 'package.json'))
        ) {
          provideDevelopmentTypes(saved.root, directory, files, options.fetchPackage ?? fetchPackage)
          sources.push({ root: saved.root, origin: directory })
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
        // Best effort: a cache that cannot be written only costs the next build its lookup.
        try {
          files.write(unpinned, `${JSON.stringify({ name: manifest.name, version: manifest.version, unpinned: true })}\n`)
        } catch {}
        continue
      }
      const destination = join(cache, identity.commit)
      log(`[geatsc] Fetching ${manifest.name}@${manifest.version} source (${identity.commit.slice(0, 12)})`)
      ;(options.checkout ?? checkout)(identity, destination)
      const packageRoot = checkoutPackageRoot(destination, identity.directory, manifest, files)
      provideDevelopmentTypes(packageRoot, directory, files, options.fetchPackage ?? fetchPackage)
      files.write(
        record,
        `${JSON.stringify({ name: manifest.name, version: manifest.version, ...identity, root: packageRoot }, null, 2)}\n`
      )
      sources.push({ root: packageRoot, origin: directory })
    } catch (error) {
      log(
        `[geatsc] ${manifest.name}@${manifest.version}: source unavailable (${error instanceof Error ? error.message : String(error)}); using installed JavaScript`
      )
    }
  }
  return sources
}
