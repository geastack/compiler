import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { packageSourceFor } from './cli-package-source.js'

/**
 * The gea build pipeline's vite module graph, as a source overlay.
 *
 * `build-gea-vite-geatsc.mjs` compiles a real application through
 * `compile-module-graph <gea-module-graph.json>`, not through the files on
 * disk. The graph is vite's own record of the modules the app actually
 * contains, and beside it sit SNAPSHOTS of each module's text taken at two
 * points in vite's transform chain. Which snapshot is compiled is the whole
 * question, and the pipeline states the answer with `--module-graph-stage`.
 *
 * `hybrid`, the default and what the web simulator passes, prefers the
 * `original` snapshot: vite captures it AFTER the gea plugin has compiled JSX
 * but BEFORE vite strips the TypeScript annotations, so it is the typed form of
 * exactly the code the bundle runs. Those annotations are the reason to prefer
 * it -- a stripped `tick(timestampMs)` gives a parameter no type to lower onto,
 * which is how a fully typed application turns into a boxed one. The exception
 * is a module whose `original` still holds raw JSX (one the gea plugin skipped,
 * typically under `node_modules`): there only vite's own lowering produced
 * compilable code, so `transformed` is the fallback.
 *
 * This is a transposition of v1's `createModuleGraphOverlay`
 * (`compiler/packages/geatsc/src/compiler/module-graph.ts`), not a second
 * opinion about it: the same manifest, the same stage rule, the same snapshot
 * files. Reading the staged `gea-embedded-compat-src` tree instead was measured
 * and is wrong -- 5 of 14 modules differ there, precisely the `.tsx` ones,
 * because that tree holds vite's stripped output.
 */

interface GraphImport {
  readonly specifier: string
  readonly resolvedId?: string | null
}

interface GraphModule {
  readonly id?: string
  readonly file?: string | null
  readonly imports?: readonly GraphImport[]
  readonly isEntry?: boolean
  readonly originalSource?: string | null
  readonly transformedSource?: string | null
}

interface GraphManifest {
  readonly root?: string
  readonly modules: readonly GraphModule[]
}

export interface ModuleGraphOverlay {
  /** Every module's text, by absolute path -- including modules with no file on disk. */
  readonly overlay: ReadonlyMap<string, string>
  /**
   * How each module's own import specifiers resolved, by importing file.
   *
   * Vite already resolved every specifier when it built this graph -- that is
   * what a bundler does -- and the answers are recorded per import
   * (`resolvedId`). A bare `"gea-embedded"` or a `virtual:` specifier has no
   * meaning to ordinary node resolution, so re-deriving it here would be a
   * second authority guessing at what the build already decided. This carries
   * the build's own answer instead.
   */
  readonly imports: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** The entry the pipeline named, or the graph's own. */
  readonly entry: string
}

/**
 * Whether a module is one this compiler can read as a program at all.
 *
 * A vite graph contains every module the bundler linked, and a bundler links
 * more than code: `import './styles.css'` is a real edge in it. That import is
 * a SIDE EFFECT -- it binds no names -- and the styles it names are already
 * compiled by the pipeline into the prelude fragment this build passes as
 * `gea.cpp-prelude`. Reading the file as source instead is not a near miss but
 * a category error: measured, one `styles.css` produced 100 checker errors
 * ("';' expected", "Octal literals are not allowed" -- a hex colour), because
 * CSS parsed as TypeScript is not TypeScript.
 */
const isScriptModule = (file: string): boolean => /\.[cm]?[jt]sx?$/i.test(file)

/** Whether a snapshot still carries raw JSX, which only vite's own transform lowers. */
const holdsRawJsx = (file: string, text: string): boolean => {
  if (!/\.[jt]sx$/i.test(file)) return false
  // A JSX element opens with `<` followed by a tag name or a fragment, in a
  // position an operator cannot occupy. Looked for the same way v1 looks for
  // it: this decides which of two already-written snapshots to read, never what
  // a construct means.
  return /<\s*[A-Za-z_$>]/.test(text)
}

const snapshotFor = (module: GraphModule, stage: string, manifestDir: string): string | null => {
  const read = (relative: string | null | undefined): string | null =>
    relative ? readFileSync(isAbsolute(relative) ? relative : resolve(manifestDir, relative), 'utf8') : null
  if (stage === 'original') return read(module.originalSource)
  if (stage === 'transformed') return read(module.transformedSource)
  const original = read(module.originalSource)
  if (original !== null && module.file && module.transformedSource && holdsRawJsx(module.file, original)) {
    return read(module.transformedSource)
  }
  return original ?? read(module.transformedSource)
}

export const readModuleGraph = (manifestPath: string, stage: string, statedEntry: string | null): ModuleGraphOverlay => {
  const path = resolve(manifestPath)
  const manifestDir = dirname(path)
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as GraphManifest
  const overlay = new Map<string, string>()
  let graphEntry: string | null = null
  for (const module of manifest.modules) {
    if (!module.file) continue
    const file = resolve(module.file)
    if (module.isEntry) graphEntry = file
    // A module that exists on disk is compiled FROM disk, and the snapshot is
    // used only for one that does not (`virtual:gea-compiler-runtime`, which
    // vite synthesizes and no file backs).
    //
    // This is where this compiler and v1 legitimately want different text for
    // the same module, and it is not a disagreement about the program. The
    // `original` snapshot is captured after the gea vite plugin has already
    // COMPILED the JSX away: `<div class="app"><FpsBadge/></div>` arrives here
    // as `document.createElement("template")`, `t.innerHTML = ...`,
    // `cloneNode(true)`, `root.childNodes[1]`, `[GEA_STATIC_TEMPLATE](d)`. v1
    // needs that, because its own path to a UI tree is that DOM-imperative
    // form. This compiler has a native JSX producer (`producers/jsx.ts`, and
    // the source pre-pass that types the elements), and handing it the lowered
    // form both bypasses that producer and asks it to compile the most dynamic
    // possible shape -- measured: 114 `property-access:dynamic` obligations,
    // every one of them a `childNodes[i]`/`innerHTML` step that the JSX it was
    // compiled from never contained.
    //
    // So the disk file is not a different program: it is the SAME module,
    // before a lowering this compiler performs itself.
    // A non-script module still has to RESOLVE -- the import is in the source
    // and an unresolved specifier is a hole in the program -- so it is given an
    // empty module rather than skipped. That is what it contributes: nothing.
    if (!isScriptModule(file)) {
      overlay.set(file, 'export {}\n')
      continue
    }
    if (existsSync(file)) continue
    const text = snapshotFor(module, stage, manifestDir)
    if (text !== null) overlay.set(file, text)
  }
  const byId = new Map<string, string>()
  for (const module of manifest.modules) if (module.file) byId.set(module.id ?? module.file, resolve(module.file))
  const imports = new Map<string, ReadonlyMap<string, string>>()
  for (const module of manifest.modules) {
    if (!module.file) continue
    const resolved = new Map<string, string>()
    for (const one of module.imports ?? []) {
      if (!one.resolvedId) continue
      const linked = byId.get(one.resolvedId) ?? (one.resolvedId.startsWith('/') ? resolve(one.resolvedId) : null)
      if (!linked) continue
      // A dependency the bundler resolved to its BUILD, redirected to the
      // source the package publishes for it -- see `packageSourceFor`. Only
      // when the graph carries no text of its own for that module: a module the
      // build snapshotted is one the build transformed, and replacing it would
      // discard that transform.
      const source = overlay.has(linked) ? null : packageSourceFor(linked)
      const target = source ?? linked
      // An import TARGET can be a non-script too, and it does not have to be a
      // module of the graph to be one: vite compiles CSS on its own side, so
      // `import './styles.css'` is recorded as a resolved edge from a module
      // while the stylesheet itself never appears in `modules`. Giving the
      // target an empty module here is what keeps this resolution -- which is
      // otherwise the build's own correct answer -- from handing the checker a
      // stylesheet to parse as TypeScript.
      if (!isScriptModule(target)) overlay.set(target, 'export {}\n')
      resolved.set(one.specifier, target)
    }
    imports.set(resolve(module.file), resolved)
  }
  const entry = statedEntry ? resolve(statedEntry) : graphEntry
  if (!entry) throw new Error(`module graph ${path} names no entry and none was given with --entry`)
  return { overlay, imports, entry }
}
