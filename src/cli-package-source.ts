import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * A package's own TypeScript, where the build resolved to its bundle.
 *
 * A bundler resolves a dependency to what it can execute: `@geajs/core` becomes
 * `dist/compiler-runtime.mjs`, which is MINIFIED -- one-letter identifiers, no
 * annotations, no JSDoc. Compiling that is not a slightly worse input, it is a
 * categorically different program: a value whose type nothing states is a value
 * this compiler must carry dynamically, so an entire typed reactive runtime
 * arrives as `gea::Value` and the No Boxing rule is lost before a single
 * defect has been fixed.
 *
 * The package already says where its real source is. Node's own conditional
 * exports carry a `source` condition for exactly this -- a consumer that
 * compiles rather than executes -- and `@geajs/core` publishes one for every
 * entry it ships (`"./compiler-runtime": { "source": "./src/compiler-runtime.ts",
 * ... }`). So this is not an override of the build's answer and not a guess: it
 * asks the same package the build asked, for the entry the build already chose,
 * and takes the answer the package gives for this use.
 *
 * Nothing is hardcoded about which package this is. A dependency that publishes
 * no `source` is left exactly where the build put it.
 */

/** The `package.json` governing this file, or `null` at the filesystem root. */
const packageOf = (file: string): { readonly dir: string; readonly manifest: PackageManifest } | null => {
  let dir = dirname(resolve(file))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        return { dir, manifest: JSON.parse(readFileSync(candidate, 'utf8')) as PackageManifest }
      } catch {
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

interface PackageManifest {
  readonly source?: unknown
  readonly main?: unknown
  readonly module?: unknown
  readonly exports?: unknown
}

/** Whether this exports entry is a condition object rather than a bare target string. */
const isConditions = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The `source` beside whichever condition the build followed to `target`.
 *
 * An exports entry is a set of conditions over ONE subpath, so the entry that
 * names `target` under any of its conditions is the entry that also names the
 * source for it. Matching by resolved path rather than by condition name is
 * what makes this agnostic to which condition the bundler actually used --
 * `import`, `require`, `browser` and `default` all lead to the same entry.
 */
const sourceBesideTarget = (packageDir: string, entry: unknown, target: string): string | null => {
  if (!isConditions(entry)) return null
  const source = entry['source']
  let names = false
  for (const [condition, value] of Object.entries(entry)) {
    if (condition === 'source' || condition === 'types') continue
    if (typeof value === 'string' && resolve(packageDir, value) === target) names = true
    else if (isConditions(value) && sourceBesideTarget(packageDir, value, target) !== null) names = true
    else if (isConditions(value)) {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string' && resolve(packageDir, nested) === target) names = true
      }
    }
  }
  if (!names) return null
  if (typeof source !== 'string') return null
  const file = resolve(packageDir, source)
  return existsSync(file) ? file : null
}

/**
 * The source file a package publishes for the built file the build resolved to,
 * or `null` when it publishes none.
 */
export const packageSourceFor = (target: string): string | null => {
  if (!isAbsolute(target)) return null
  const owner = packageOf(target)
  if (!owner) return null
  const { dir, manifest } = owner
  const exports = manifest.exports
  if (isConditions(exports)) {
    // A subpath map (`{"./x": {...}}`) and a bare condition set (`{"import": ...}`)
    // are both objects; trying each entry as a condition set covers the first,
    // and the whole object as one covers the second.
    for (const entry of Object.values(exports)) {
      const found = sourceBesideTarget(dir, entry, target)
      if (found !== null) return found
    }
    const direct = sourceBesideTarget(dir, exports, target)
    if (direct !== null) return direct
  }
  // The older convention, still what several bundlers read: one top-level
  // `source` beside `main`/`module`.
  const source = manifest.source
  if (typeof source !== 'string') return null
  const built = [manifest.main, manifest.module].filter((value): value is string => typeof value === 'string')
  if (!built.some((value) => resolve(dir, value) === target)) return null
  const file = resolve(dir, source)
  return existsSync(file) ? file : null
}
