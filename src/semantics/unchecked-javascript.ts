import type ts from 'typescript'
import { dirname, relative, resolve } from 'node:path'

/**
 * JavaScript files a build states are unchecked: `@ts-nocheck` without the text.
 *
 * A package such as three.js ships JSDoc that is good enough to infer types
 * from and far too loose to typecheck -- thousands of checker errors, none of
 * them a defect in the program being compiled. Prefixing `// @ts-nocheck` to
 * each file answers that, and it is what the native-webgl-angle package did,
 * but it edits the source every later stage reads, shifts every node offset in
 * the file, and puts a text rewrite between this compiler and a library it
 * should read as published.
 *
 * TypeScript records the directive as the parsed file's `checkJsDirective`,
 * and that record is all the directive does: the program then reports no bind,
 * check or JSDoc diagnostics for the file (`canIncludeBindAndCheckDiagnostics`),
 * while the checker still binds it, reads its JSDoc and infers from it exactly
 * as before. Setting the record on the parsed file is therefore the directive
 * itself, with the text left as written.
 *
 * A pattern is a package name followed by a glob over paths inside that
 * package: `three/src/**`, `@scope/name/lib/*.js`, or a bare `three` for the
 * whole package. A file belongs to the package whose nearest `package.json`
 * with a `name` contains it. Which diagnostics a build reports is the build's
 * policy, not a decision about what the program means, so a package path is
 * the right key here; nothing downstream reads it.
 */
export type UncheckedJavaScriptPolicy = (fileName: string) => boolean

interface PackagePattern {
  readonly packageName: string
  readonly path: RegExp
}

const segmentPattern = (segment: string): string =>
  segment
    .split('')
    .map((character) => (character === '*' ? '[^/]*' : character === '?' ? '[^/]' : character.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')

/** `**` spans any number of whole segments, including none; `*` and `?` stay inside one. */
const globPattern = (glob: string): RegExp => {
  const segments = glob.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return /^.*$/
  let pattern = ''
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (segment === '**') pattern += last ? '.*' : '(?:[^/]+/)*'
    else pattern += segmentPattern(segment) + (last ? '' : '/')
  }
  return new RegExp(`^${pattern}$`)
}

const parsePattern = (pattern: string, stating: string): PackagePattern => {
  const segments = pattern.split('/')
  const nameSegments = segments.slice(0, pattern.startsWith('@') ? 2 : 1)
  if (
    nameSegments.length < (pattern.startsWith('@') ? 2 : 1) ||
    nameSegments.some((segment) => segment.length === 0 || /[*?]/.test(segment))
  ) {
    throw new Error(`${stating} pattern '${pattern}' does not start with a package name`)
  }
  return { packageName: nameSegments.join('/'), path: globPattern(segments.slice(nameSegments.length).join('/')) }
}

const isJavaScriptPath = (fileName: string): boolean => /\.(?:[cm]?js|jsx)$/i.test(fileName)

/**
 * Whether a JavaScript file is inside one of `patterns`, in the package-glob
 * grammar above. `stating` names the capability in the error for a pattern
 * with no package name. A scoped `ambientTypeRealizations` row takes its scope
 * in the same grammar (`scoped-type-realizations.ts`).
 */
export const createPackageJavaScriptPolicy = (
  patterns: ReadonlySet<string>,
  host: Pick<ts.ModuleResolutionHost, 'fileExists' | 'readFile'>,
  stating: string
): UncheckedJavaScriptPolicy => {
  if (patterns.size === 0) return () => false
  const parsed = [...patterns].map((pattern) => parsePattern(pattern, stating))
  const packageAt = new Map<string, { readonly root: string; readonly name: string } | null>()
  const packageOf = (directory: string): { readonly root: string; readonly name: string } | null => {
    const cached = packageAt.get(directory)
    if (cached !== undefined) return cached
    let found: { readonly root: string; readonly name: string } | null = null
    const manifest = `${directory}/package.json`
    if (host.fileExists(manifest)) {
      try {
        const name: unknown = (JSON.parse(host.readFile(manifest) ?? '{}') as { name?: unknown }).name
        if (typeof name === 'string' && name.length > 0) found = { root: directory, name }
      } catch {
        // A manifest that does not parse names no package; the walk goes on to the one above.
      }
    }
    if (found === null) {
      const parent = dirname(directory)
      found = parent === directory ? null : packageOf(parent)
    }
    packageAt.set(directory, found)
    return found
  }
  return (fileName) => {
    if (!isJavaScriptPath(fileName)) return false
    const file = resolve(fileName)
    const owner = packageOf(dirname(file))
    if (owner === null) return false
    const inside = relative(owner.root, file).replace(/\\/g, '/')
    return parsed.some((pattern) => pattern.packageName === owner.name && pattern.path.test(inside))
  }
}

export const createUncheckedJavaScriptPolicy = (
  patterns: ReadonlySet<string>,
  host: Pick<ts.ModuleResolutionHost, 'fileExists' | 'readFile'>
): UncheckedJavaScriptPolicy => createPackageJavaScriptPolicy(patterns, host, 'unchecked JavaScript')

/** What `// @ts-nocheck` leaves on a parsed file -- see this module's comment. */
export const markUnchecked = (file: ts.SourceFile): ts.SourceFile => {
  ;(file as ts.SourceFile & { checkJsDirective?: { enabled: boolean; pos: number; end: number } }).checkJsDirective = {
    enabled: false,
    pos: 0,
    end: 0
  }
  return file
}
