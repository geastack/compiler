import { statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import ts from 'typescript'

/**
 * A process-wide cache of the PARSED declaration files every program re-reads:
 * TypeScript's own `lib.*.d.ts` and every declaration file an installed
 * package ships under `node_modules/` -- `@types/**` and the packages those
 * reach (`@types/node` alone pulls in some seventy files of `undici-types`,
 * which were re-parsed and re-bound by every compile while only `@types` was
 * shared). A symlinked package resolves to its real path outside
 * `node_modules/` and is read per compile like any other source.
 *
 * WHY. A compile reads the same few hundred declaration files every time --
 * `lib.dom.d.ts` alone is over a megabyte -- and a process that compiles more
 * than one program (the emitted-set gate compiles ~1330 per shard, and one
 * compile builds several `ts.Program`s) paid `createSourceFile` and the parent
 * walk for each of them again. Measured on the gate's runtime set: parsing was
 * 41% of CPU, and the binder walking the same files again for each new checker
 * was another 12%.
 *
 * WHAT IS SHARED, AND WHAT IS NOT. Only the `ts.SourceFile` -- the parse tree.
 * Every checker is still created per compile, exactly as before, so no
 * `ts.Type`, no checker answer and no query history is shared: those live in
 * the checker's own tables, keyed by node id. Sharing the tree is the
 * arrangement TypeScript's language service itself uses across programs: the
 * binder's `symbol`/`locals` on a node are checker-independent (a checker that
 * merges a shared symbol clones it first and records the merge in its own
 * array).
 *
 * THE RULE THIS PUTS ON THE REST OF THE COMPILER. A node of a shared file
 * outlives the compile that read it, so module-level state keyed by such a node
 * must hold only facts that are a pure function of the file. A checker answer
 * (`ts.Type`, `ts.Symbol` obtained through a checker) must be keyed by the
 * checker first. `bivariant-slot-parameter.ts` is the one that did not, and now
 * does. Nothing may write to a node of a declaration file.
 *
 * THE KEY. Everything the parse depends on: the exact file name, the language
 * version, the implied module format, and the compiler options that decide the
 * external-module indicator (`moduleDetection`, `module`, `jsx`) -- plus the
 * file's mtime and size, so an edited `.d.ts` is re-read rather than served
 * stale by a long-lived process.
 *
 * NOT SHARED: a declaration file the caller's source transforms, overlay or
 * ambient-module shadowing would rewrite. `transformingHost` consults those
 * before it ever reaches this reader, and applies shadowing to whatever this
 * returns -- it builds a NEW file when it blanks a block and returns the shared
 * one untouched otherwise.
 */
type SourceFileReader = ts.CompilerHost['getSourceFile']

interface SharedDeclaration {
  readonly file: ts.SourceFile
  readonly modifiedMs: number
  readonly size: number
}

const shared = new Map<string, SharedDeclaration>()

const packagesDirectoryMarker = '/node_modules/'

const isDeclarationFileName = (fileName: string): boolean => /\.d\.[cm]?ts$/.test(fileName)

const optionsKeyOf = (options: ts.CompilerOptions): string =>
  [options.moduleDetection, options.module, options.jsx, options.target].map((value) => String(value)).join(',')

export const sharedDeclarationReader = (
  read: SourceFileReader,
  options: ts.CompilerOptions,
  defaultLibFileName: string
): SourceFileReader => {
  const libDirectory = dirname(resolve(defaultLibFileName))
  const optionsKey = optionsKeyOf(options)
  const isShared = (fileName: string): boolean => {
    if (!isDeclarationFileName(fileName)) return false
    const absolute = resolve(fileName)
    if (absolute.split('\\').join('/').includes(packagesDirectoryMarker)) return true
    return dirname(absolute) === libDirectory && basename(absolute).startsWith('lib.')
  }
  return (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (shouldCreateNewSourceFile === true || !isShared(fileName))
      return read(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    let stat
    try {
      stat = statSync(fileName, { throwIfNoEntry: false })
    } catch {
      stat = undefined
    }
    if (stat === undefined) return read(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    const version =
      typeof languageVersionOrOptions === 'number'
        ? String(languageVersionOrOptions)
        : `${languageVersionOrOptions.languageVersion},${languageVersionOrOptions.impliedNodeFormat},${languageVersionOrOptions.jsDocParsingMode}`
    const key = `${fileName}\0${version}\0${optionsKey}`
    const held = shared.get(key)
    if (held !== undefined && held.modifiedMs === stat.mtimeMs && held.size === stat.size) return held.file
    const file = read(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    if (file !== undefined) shared.set(key, { file, modifiedMs: stat.mtimeMs, size: stat.size })
    return file
  }
}
