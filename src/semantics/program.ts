import type { PackageSource } from './package-sources.js'
import ts from 'typescript'
import { withStableTypeQueries } from './stable-checker.js'
import { dirname, resolve } from 'node:path'
import { createModuleResolver, isDeclarationPath, mappedTypeScriptSource, moduleExtension, typeOnlyModuleUse } from './module-resolution.js'
import type { CommonJsWrapperDeclaration } from '../plugins/model.js'
import { createCommonJsRequireCensus } from './normalize/commonjs-require.js'
import { withoutBareWrapperRedeclarations } from './commonjs-wrapper.js'
import { resolveHostMethod, type HostMethodBindingTable } from './host-methods.js'
import { diagnosticSourcePreparation, type DiagnosticSourcePreparationAudit } from './diagnostic-source-preparation.js'
import { createFrontendTiming, type FrontendTiming } from './frontend-timing.js'

/**
 * The TypeScript program host.
 *
 * This is the only place the compiler opens a file. Everything downstream reads
 * the sealed semantic graph, so a later layer physically cannot reach back to
 * the AST to answer a question the frontend already answered differently.
 */

export interface ProgramInput {
  /** Package checkouts prepared by the project loader; the compiler discovers their implementation entries. */
  readonly packageSources?: readonly PackageSource[]
  readonly dynamicFallback?: boolean
  /** Module specifiers implemented by an installed native host, including explicit package/* claims. */
  readonly declarationModules?: ReadonlySet<string>
  readonly rootFileNames: readonly string[]
  readonly options: ts.CompilerOptions
  /**
   * File text this program uses in place of what is on disk, by absolute path.
   *
   * A build pipeline does not always hand a compiler the files a user wrote.
   * The gea vite pipeline captures each module at a chosen point in its own
   * transform chain and compiles THOSE, so the text for a path can differ from
   * the file at that path -- and one module (`@gea-virtual/...`) has no file at
   * all. Both are the same fact: the caller, not the filesystem, is the
   * authority on a module's text. The paths stay the real ones because import
   * resolution is done against them.
   */
  readonly sourceOverlay?: ReadonlyMap<string, string>
  /**
   * How an importing file's own specifiers resolve, when the caller knows and
   * ordinary resolution cannot. A bundler's virtual module (`virtual:...`) and
   * an alias it invented have no on-disk meaning; the build that created them
   * is the only authority on where they point.
   */
  readonly moduleResolution?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** Exact host-owned declarations whose static calls are CommonJS loaders. */
  readonly commonJsGlobals?: ReadonlyMap<string, CommonJsWrapperDeclaration>
  /** Host-owned method declarations used to authenticate builtin record lookups. */
  readonly hostMethodBindings?: HostMethodBindingTable
  /** Accepted runtime lookup spellings, mapped to canonical builtin names. */
  readonly commonJsBuiltinModules?: ReadonlyMap<string, string>
  /** Real implementation sources keyed by canonical builtin registry name. */
  readonly commonJsBuiltinModuleSources?: ReadonlyMap<string, string>
  /**
   * The project file whose options and file set define this program, or `null`
   * to compile the root files under `options` alone.
   *
   * A program is not just its entry points. A project's `include` pulls in the
   * ambient declarations that give a wildcard import (`import './App.css'`) a
   * module to resolve to, and its `paths` decide what a specifier means at all.
   * Compiling the entry points under this compiler's own defaults compiles a
   * *different program* than the one the application declares, and every
   * difference surfaces as a phantom defect in the application.
   */
  /**
   * Whether the CALLER has stated the module set (it compiled a module graph),
   * so the project must not add modules of its own.
   *
   * A project's `include` and a module graph answer two different questions. A
   * glob says what a typechecker should be willing to look at; a graph says
   * what this application actually is. On the module-graph path the staged
   * project is written beside the entry and its `include` is a wildcard, so it
   * sweeps up every sibling left in the staging directory -- files the bundler
   * shook out, and untransformed originals whose specifiers only ever meant
   * something to the bundler. Compiled as roots, their unresolved imports are
   * reported as defects of an application that does not contain them.
   *
   * The project still contributes everything it is the authority on: its
   * options, its `paths`, and its ambient DECLARATIONS -- which is what the
   * comment above is about, and what a wildcard import still needs. Only its
   * implementation files are dropped, because the graph already named those.
   */
  readonly statedModuleSet?: boolean
  /**
   * The caller guarantees that this program contains every classic script
   * that can execute in its lexical realm, including any evaluated source.
   * Absent, another script may read or write top-level lexical bindings.
   * This does not close global-object properties, host effects, or objects
   * held by lexical bindings. It is independent of ESM module completeness
   * and C++ symbol isolation, neither of which supplies this guarantee.
   */
  readonly closedScriptScope?: boolean
  readonly projectFileName?: string | null
  /**
   * Rewrites a plugin performs on a file's text before this program parses it
   * (`PluginInstance.transformSource`), applied in installation order.
   *
   * The only place a transform can run and still change what the CHECKER sees,
   * which is the whole reason the hook exists: a library whose meaning the type
   * system cannot express -- AppKit's JSX, whose elements the language types as
   * `JSX.Element` and whose attributes it does not check at all -- has to
   * become ordinary TypeScript before checking, not after. Empty is the normal
   * case and costs nothing.
   */
  readonly sourceTransforms?: readonly ((input: {
    readonly fileName: string
    readonly text: string
    readonly declarationFileName?: string
  }) => string | null)[]
}

export interface CompiledProgram {
  readonly program: ts.Program
  readonly checker: ts.TypeChecker
  /**
   * The program host's runtime-module answer for a literal specifier.
   *
   * CommonJS `require("...")` is not a TypeScript module-specifier node, so
   * its argument has no checker module symbol.  This keeps resolution on the
   * configured program host, including overlays, package-source rewrites, and
   * caller-stated module graphs, instead of letting a producer re-resolve it.
   */
  readonly runtimeModuleTargetOf: (specifier: string, containingFile: string, mode: 'import' | 'require') => string | null
  /** The Program's canonical source-file object for a resolved path. */
  readonly sourceFileOf: (fileName: string) => ts.SourceFile | null
  /** Source files reached only through authenticated static CommonJS require edges. */
  readonly commonJsSourceFiles: readonly ts.SourceFile[]
  /** The files the compiler is responsible for, excluding ambient declarations. */
  readonly sourceFiles: readonly ts.SourceFile[]
  /**
   * The files the caller asked to compile, as this program's own source files.
   *
   * A program is not just its entry points -- `ProgramInput.projectFileName`
   * says why -- but the difference between the two is exactly what
   * `censusReachability` (normalize/reachability.ts) needs, and only this file
   * can state it: a root arrives as whatever path the caller wrote, and
   * turning one into a `ts.SourceFile` is module resolution, which is this
   * file's job and no later layer's. Empty means the roots could not be
   * resolved, and reachability then prunes nothing.
   */
  readonly entryFiles: readonly ts.SourceFile[]
  /** Syntactic and semantic errors TypeScript itself reports. */
  readonly diagnostics: readonly ts.Diagnostic[]
  /** Exact stale package-source directives blanked before the final checker pass. */
  readonly sourcePreparations: readonly DiagnosticSourcePreparationAudit[]
}

export const defaultCompilerOptions: ts.CompilerOptions = Object.freeze({
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowJs: true,
  checkJs: true,
  maxNodeModuleJsDepth: 100,
  noEmit: true,
  skipLibCheck: true,
  // A default for a program compiled without a project file, and nothing more.
  // Leaving the option unset is the one answer that is always wrong: every JSX
  // expression then becomes a checker error typed `any`, which is how a whole
  // application silently turns into a boxed program. `preserve` is the choice
  // that assumes least -- it keeps what the author wrote -- but a project that
  // states its own setting overrides this, and must: whether `<C/>` reaches
  // this compiler as an element or as a `jsx(type, props)` call is the
  // library's decision, expressed where every other TypeScript tool reads it.
  jsx: ts.JsxEmit.Preserve
})

/**
 * The nearest project file at or above a directory, or `null`.
 *
 * This walks the filesystem, which looks like the source-shaped authority the
 * architecture forbids -- it is not. The forbidden thing is deciding a value's
 * *semantics* from a path. Finding the project that declares a program is how
 * every TypeScript toolchain establishes what the program even is, and the
 * answer feeds `ts.parseJsonConfigFileContent`, never a semantic decision.
 */
export const findProjectFile = (fromDirectory: string): string | null =>
  ts.findConfigFile(fromDirectory, ts.sys.fileExists, 'tsconfig.json') ?? null

/**
 * Options this compiler fixes regardless of what a project asks for.
 *
 * Each one changes what the *checker* reports rather than what the program
 * means: emit settings are irrelevant to a compiler that emits C++.
 *
 * `jsx` is the one that deserves suspicion, because overriding a project here
 * silently discards what it asked for -- a project setting `react-jsx` is
 * compiled as `preserve` with nothing said. It is pinned because the element
 * tree is the input a template-compiling plugin reads (see
 * `defaultCompilerOptions`), and it should stop being pinned as soon as a
 * plugin exists that wants the factory form instead.
 */
/**
 * The one option a project may not decide, because it is not about the program.
 *
 * `noEmit` says this compiler is not asking TypeScript to write JavaScript --
 * it reads the checker and emits C++ itself. Everything else, `jsx` included,
 * comes from the project: overriding a project's JSX setting would mean this
 * compiler deciding on the author's behalf whether their elements survive as
 * elements or arrive already rewritten into factory calls, which is exactly the
 * choice a library makes and states in its own tsconfig.
 */
const fixedOptions: ts.CompilerOptions = { noEmit: true }

/**
 * The options that say "JavaScript is part of this program", carried onto a
 * project's own settings rather than replaced by them.
 *
 * A caller that hands in JavaScript sources is stating a fact about the
 * program, not expressing a preference a project may overrule: with `allowJs`
 * off, every resolved `.js` module is reported as "could not find a declaration
 * file ... implicitly has an `any` type" and the module is not compiled at all.
 * That is how a staged project -- which no author wrote, and which therefore
 * says nothing about vendor JavaScript -- silently removed `three`'s 388 real
 * source modules from every application that imports them.
 *
 * Carried, never invented: the values are the caller's own
 * (`frontend.ts` sets them from `javaScriptSources`), so a compilation that
 * states no JavaScript adds nothing here and a project's settings pass through
 * untouched.
 */
const javaScriptAdmission = (options: ts.CompilerOptions): ts.CompilerOptions => ({
  ...(options.allowJs === undefined ? {} : { allowJs: options.allowJs }),
  ...(options.checkJs === undefined ? {} : { checkJs: options.checkJs }),
  ...(options.maxNodeModuleJsDepth === undefined ? {} : { maxNodeModuleJsDepth: options.maxNodeModuleJsDepth })
})

/**
 * The script kind a file's extension declares.
 *
 * Asked only when a transform has already changed a file's text and the source
 * file has to be re-created from it. This is not a source-shaped semantic
 * decision -- it is the same extension-to-syntax mapping TypeScript itself
 * performs to decide whether `<` opens a JSX element or a type argument list,
 * and getting it wrong would reparse a rewritten `.tsx` as `.ts`.
 */
const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  // `.json` falls through to here too, and that is deliberate -- see
  // `jsonModuleAsTypeScript`'s own comment for why a `.json` file's rewritten
  // text needs exactly this script kind and not `ts.ScriptKind.JSON`.
  return ts.ScriptKind.TS
}

/**
 * A `.json` module, rewritten as the ordinary TypeScript module
 * `resolveJsonModule` behaves as if it always were.
 *
 * This is a language feature (`tsconfig`'s `resolveJsonModule`, the same one
 * Node's own module loader implements), not a gea idiom, so it lives here
 * rather than behind a plugin's `transformSource` -- every program that turns
 * this option on gets it, with no plugin installed. A JSON document's grammar
 * is already a strict subset of a TypeScript object/array/string/number/
 * boolean/null literal, so wrapping the file's own text in `export default
 * ...;` is the WHOLE of what is needed: every later stage -- census,
 * `derive.ts`'s structural typing, emission's record/array-literal rendering
 * -- already knows how to carry a literal value, because that is exactly what
 * an ordinary `const x = {...}` already asks of them.
 *
 * Without this, the declaration a program's binding resolves to for
 * `import data from './x.json'` is the JSON `SourceFile` itself -- TypeScript's
 * own synthetic shape for a JSON module, with no expression a normal walk
 * recognizes. `isAmbientSymbol` correctly says it is not ambient (it is not a
 * `.d.ts` and carries no `declare`), so it is never treated as a host import
 * either -- it is simply never censused at all: no placement, local or
 * external, and a program that reads it hits `bindingReference`'s "this
 * program never introduces" refusal at every use.
 */
const jsonModuleAsTypeScript = (fileName: string, text: string): string | null =>
  fileName.endsWith('.json') ? `export default ${text};` : null

/** A function-like node's own body, or `undefined` for one that declares none (a signature in a type, an overload). */
const functionBodyOf = (node: ts.SignatureDeclaration): ts.Node | undefined => {
  if (ts.isArrowFunction(node)) return node.body
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body
  }
  return undefined
}

/**
 * Whether a file's TOP LEVEL awaits -- outside every function, method,
 * accessor, constructor, static block and namespace body, which are the
 * scopes an `await` inside them belongs to instead.
 *
 * `await using` counts for the same reason `for await` does: both are the
 * `await` token in a position only a module body may hold. Checked through
 * the flag rather than the keyword because a declaration list carries it as
 * `NodeFlags.AwaitUsing`, with no `AwaitExpression` node anywhere.
 *
 * That flag is a COMPOSITE -- `AwaitUsing` is `Const | Using`, the value 6 --
 * so it has to be tested for every bit, not for any. Tested with `!== 0` it
 * matched every plain `const`, whose own flag is the `Const` bit inside it,
 * and so declared a top-level await in essentially every script file: it
 * appended `export {}` to node-compat's `runtime/node/globals.ts`, turning a
 * deliberate SCRIPT into a module and deleting `Headers`/`Request`/`Response`
 * from the global scope every library file resolves them through. `tsc` on
 * the same project reported nothing, because the project is fine; only this
 * host's transformed copy was broken.
 */
const awaitsAtTopLevel = (file: ts.SourceFile): boolean => {
  const awaits = (node: ts.Node): boolean => {
    if (ts.isAwaitExpression(node)) return true
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) return true
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing) return true
    // A static block and a namespace body are scopes of their own with no
    // outer part to look at.
    if (ts.isClassStaticBlockDeclaration(node) || ts.isModuleDeclaration(node)) return false
    // A function's BODY is its own scope; everything else about it -- a
    // computed method name, a decorator, a parameter default, a type -- is
    // evaluated where the function is DECLARED, so those stay in this walk.
    // Skipping the whole node instead missed `class C { [await key()]() {} }`,
    // whose await really is at the module's top level.
    if (ts.isFunctionLike(node)) {
      const body = functionBodyOf(node)
      return ts.forEachChild(node, (child) => (child === body ? false : awaits(child))) ?? false
    }
    return ts.forEachChild(node, awaits) ?? false
  }
  return ts.forEachChild(file, awaits) ?? false
}

/**
 * A FILE THAT AWAITS AT ITS TOP LEVEL IS A MODULE. THAT IS THE GRAMMAR, NOT A
 * PREFERENCE.
 *
 * ECMA-262 parses a source text under one of two goal symbols, and `await` in
 * an outermost statement is grammatical under exactly one of them: `Module`
 * (16.2.1.6.1 makes such a module `[[HasTLA]]`, and 27.7.5.3's `Await` is
 * defined for its body). A `Script` cannot hold one at all. So a file whose
 * top level awaits has already told the host which goal symbol it wants.
 *
 * TypeScript decides module-ness a different way -- by looking for an import
 * or an export -- and then reports the file's own `await` as an error whose
 * remedy it spells out: "Consider adding an empty 'export {}' to make this
 * file a module." That is TypeScript answering a POSITIONAL question the
 * language answers syntactically, the same shape of mismatch
 * `structural-layout-type.ts`'s `literalTokenType` records for a literal
 * token's type. This compiler is the host; deciding the goal symbol from the
 * grammar is its job, and the remedy the diagnostic names is a one-line
 * appendix to the text.
 *
 * Which is exactly what this returns -- `export {}`, appended, so every later
 * stage sees an ordinary external module and nothing downstream needs to know
 * this happened. `moduleEvaluationOrder` (`frontend.ts`) already orders module
 * bodies and the entry already calls them in that order
 * (`targets/cpp/translation-unit.ts`'s `entryDefinitionOf`), so an importer
 * observes the awaited exports and never a half-evaluated module -- 16.2.1.5.3
 * satisfied by construction rather than by a scheduler this runtime does not
 * have.
 *
 * It cannot change the meaning of a program that already compiled. Appending
 * an export turns script scope into module scope, which really does move
 * top-level names out of the global namespace -- but the only files this fires
 * on are files TypeScript refused outright, so there is no working program
 * whose scoping this can move. A file that is already an external module is
 * left exactly as it is.
 *
 * Not behind a plugin's `transformSource`, for `jsonModuleAsTypeScript`'s own
 * reason one function above: this is the language, so every program gets it
 * with no plugin installed. And not a text transform either -- "does this file
 * await at its top level" is a question about the parse tree, and answering it
 * off the characters is how a comment or a string containing the word would
 * decide it.
 */
const moduleMarkerForTopLevelAwait = (file: ts.SourceFile): string | null =>
  !file.isDeclarationFile && !ts.isExternalModule(file) && awaitsAtTopLevel(file) ? `${file.text}\nexport {}\n` : null

/**
 * The compiler host, with the installed plugins' source transforms -- and the
 * `.json`-module rewrite above, which every compilation gets regardless of
 * which plugins are installed -- in front of every file it opens.
 *
 * Wrapping `getSourceFile` rather than `readFile` because the default host does
 * not route one through the other: it closes over its own reader, so a
 * `readFile` override is simply never consulted for a program's own sources.
 *
 * A declaration file is offered to nothing. `.d.ts` declares and evaluates
 * nothing, so there is no expression in one for a transform to rewrite, and
 * handing the standard library to a plugin would be inviting exactly the kind
 * of reach a plugin should not have.
 *
 * A program with no plugins and no `.json` module parses every file exactly as
 * it always did: `jsonModuleAsTypeScript` answers `null` for anything that is
 * not `.json`, the plugin loop is empty, `text` never changes, and the early
 * `text === file.text` return hands back the original file object untouched.
 */
/**
 * The specifiers a caller states resolve to a real SOURCE module of this program.
 *
 * `.d.ts` targets are excluded: a stated declaration target is a declaration
 * target, and nothing about it is shadowed by another one.
 */
const statedSourceSpecifiers = (stated: ReadonlyMap<string, ReadonlyMap<string, string>>): ReadonlySet<string> => {
  const specifiers = new Set<string>()
  for (const answers of stated.values()) {
    for (const [specifier, target] of answers) if (!isDeclarationPath(target)) specifiers.add(specifier)
  }
  return specifiers
}

/**
 * Exact `paths` entries that resolve to program source rather than a
 * declaration file.
 *
 * `tsconfig`'s `paths` is just as explicit an authority over a specifier as
 * the caller's `moduleResolution` table.  TypeScript nevertheless loads an
 * ambient `declare module "node:events"` before the source module a project
 * maps that spelling to, unless the declaration block is removed below.  That
 * splits the program in two: emission evaluates node-compat's `events.ts`,
 * while the checker gives values the unrelated `@types/node` EventEmitter.
 *
 * Only non-pattern keys participate.  A `*` key describes an open family and
 * cannot prove one particular ambient module is shadowed; an exact key has a
 * resolved source target the project itself selected.  The resolver remains
 * TypeScript's -- this function merely records that already-resolved fact for
 * the declaration-file transform.
 */
const pathMappedSourceSpecifiers = (options: ts.CompilerOptions, host: ts.ModuleResolutionHost): ReadonlySet<string> => {
  const paths = options.paths
  if (!paths) return new Set()
  // `pathsBasePath` is preserved by TypeScript's config parser but omitted
  // from its public CompilerOptions declaration.  It is still the authority
  // for relative `paths` targets when present.
  const pathsBasePath = (options as ts.CompilerOptions & { readonly pathsBasePath?: string }).pathsBasePath
  const base = pathsBasePath ?? options.baseUrl ?? host.getCurrentDirectory?.() ?? ts.sys.getCurrentDirectory()
  const containingFile = resolve(base, '__gea_explicit_paths__.ts')
  const result = new Set<string>()
  for (const specifier of Object.keys(paths)) {
    if (specifier.includes('*')) continue
    const resolved = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule
    if (resolved && !isDeclarationPath(resolved.resolvedFileName)) result.add(specifier)
  }
  return result
}

/**
 * A declaration file with its ambient `declare module '<spec>'` blocks removed,
 * for every `<spec>` the CALLER states resolves to a real source module.
 *
 * TypeScript resolves a non-relative specifier against ambient module
 * declarations BEFORE it resolves files, so a single
 * `declare module 'troika-three-text' { ... }` anywhere in the program decides
 * what the CHECKER thinks that import is -- while the emitter compiles the
 * module the caller's own resolution named. Two authorities for one specifier,
 * and the checker's loses every fact the real module states.
 *
 * Measured on the three.js app: its `src/troika-shims.d.ts` declares
 * `export class Text extends Object3D` for the web build (where the npm package
 * ships no types), while the native module graph resolves the same specifier to
 * `native-webgl-angle/src/troika-three-text.ts` -- a real class the program
 * compiles. Two things went wrong at once, both invisible: the ambient `Text`
 * re-introduced the very name the real shim renames itself to avoid (gea maps
 * the DOM `Text` onto `NodeHandle`, so the HUD's text objects were carried as
 * DOM nodes), and the ambient class's `extends Object3D` resolved -- from a
 * `.d.ts`, whose own imports the caller states nothing about -- to
 * `@types/three`, binding `Vector3`/`Euler`/`Quaternion` as carrier-less host
 * protocols. `native-boundary:Vector3@1`, 26 rows, all of them
 * `<text>.position.set(...)`.
 *
 * The caller's stated resolution wins, because it is the module the program
 * actually compiles and emits. The block is blanked rather than cut so every
 * other position in the file is unchanged: a declaration file holds unrelated
 * declarations (`declare module '*.woff'`), and shifting them would move
 * diagnostics and identities that have nothing to do with this.
 *
 * AMBIENT, never an AUGMENTATION. The hazard above is one a `declare module`
 * block can only pose from a GLOBAL declaration file: only there does the
 * block introduce a module identity of its own, ahead of file resolution, for
 * the checker to prefer. The same syntax inside a file that is itself a module
 * is an augmentation -- TypeScript requires the specifier to resolve to an
 * existing module and MERGES the block into it (it reports "Invalid module
 * name in augmentation" when it does not), so it cannot shadow anything and
 * there is nothing here to protect the program from. Blanking one deletes a
 * declaration the application made about the very module this compilation
 * resolved, and a path-mapped framework is exactly where an app states one:
 * `notes-jsx`'s `env.d.ts` augments `@geastack/core` with the macOS shell's
 * own JSX tags, and with the block blanked every `<glass-pane>` in the app was
 * reported as not existing on `JSX.IntrinsicElements` -- an error about a
 * declaration this function had removed.
 */
const withoutShadowedAmbientModules = (
  file: ts.SourceFile,
  shadowed: ReadonlySet<string>,
  version: ts.ScriptTarget | ts.CreateSourceFileOptions
): ts.SourceFile => {
  if (shadowed.size === 0 || file.hasNoDefaultLib || ts.isExternalModule(file)) return file
  const spans: { readonly at: number; readonly end: number }[] = []
  for (const statement of file.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue
    if (!shadowed.has(statement.name.text)) continue
    spans.push({ at: statement.getStart(file), end: statement.getEnd() })
  }
  if (spans.length === 0) return file
  let text = file.text
  for (const span of [...spans].sort((a, b) => b.at - a.at)) {
    const blanked = text.slice(span.at, span.end).replace(/[^\n]/g, ' ')
    text = text.slice(0, span.at) + blanked + text.slice(span.end)
  }
  return ts.createSourceFile(file.fileName, text, version, true, scriptKindOf(file.fileName))
}

const transformingHost = (
  input: ProgramInput,
  options: ts.CompilerOptions,
  resolutionDiagnostics: { readonly literal: ts.StringLiteralLike; readonly diagnostic: ts.Diagnostic }[],
  preparedSourceText: ReadonlyMap<string, string>,
  timing: FrontendTiming
): ts.CompilerHost => {
  const transforms = input.sourceTransforms ?? []
  const overlay = input.sourceOverlay
  const host = ts.createCompilerHost(options, true)
  const read = host.getSourceFile.bind(host)
  // An overlaid path must answer every question the filesystem would, not just
  // the one that reads it: module resolution asks `fileExists` first and never
  // reaches `getSourceFile` for a path it believes is absent, which is exactly
  // how a virtual module disappears from a program that imports it.
  if (overlay) {
    const exists = host.fileExists.bind(host)
    const readFile = host.readFile.bind(host)
    const directoryExists = host.directoryExists?.bind(host)
    const overlayDirectories = new Set<string>()
    for (const file of overlay.keys()) {
      for (let directory = dirname(file); !overlayDirectories.has(directory); directory = dirname(directory)) {
        overlayDirectories.add(directory)
        if (dirname(directory) === directory) break
      }
    }
    host.directoryExists = (directory) => overlayDirectories.has(resolve(directory)) || (directoryExists?.(directory) ?? false)
    host.fileExists = (fileName) => overlay.has(resolve(fileName)) || exists(fileName)
    host.readFile = (fileName) => overlay.get(resolve(fileName)) ?? readFile(fileName)
  }
  const stated = input.moduleResolution
  const shadowedSpecifiers = new Set([...(stated ? statedSourceSpecifiers(stated) : []), ...pathMappedSourceSpecifiers(options, host)])
  const resolver = createModuleResolver(host, options, input.declarationModules, input.packageSources)
  const declarations = new Map<string, string>()
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, compilerOptions, containingSource) => {
    const answers = stated?.get(resolve(containingFile))
    return literals.map((literal) => {
      const mode = ts.getModeForUsageLocation(containingSource, literal, compilerOptions)
      const result = resolver.resolve(literal.text, containingFile, mode, answers?.get(literal.text))
      if (typeOnlyModuleUse(literal) && result.declaration && !answers?.has(literal.text)) return { resolvedModule: result.declaration }
      let implementation = result.implementation
      if (implementation && !answers?.has(literal.text)) {
        const source = mappedTypeScriptSource(implementation.resolvedFileName, host)
        if (source) implementation = { ...implementation, resolvedFileName: source, extension: moduleExtension(source) }
      }
      if (implementation && result.declaration && !isDeclarationPath(implementation.resolvedFileName)) {
        declarations.set(resolve(implementation.resolvedFileName), result.declaration.resolvedFileName)
      }
      if (!implementation && result.declaration && !result.native && !isDeclarationPath(containingFile) && !typeOnlyModuleUse(literal)) {
        resolutionDiagnostics.push({
          literal,
          diagnostic: {
            category: ts.DiagnosticCategory.Error,
            code: 95001,
            file: containingSource,
            start: literal.getStart(containingSource),
            length: literal.getWidth(containingSource),
            messageText: `Module '${literal.text}' has declarations but no resolvable implementation or registered native binding.`
          }
        })
      }
      return { resolvedModule: implementation ?? result.declaration }
    })
  }
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const prepared = preparedSourceText.get(resolve(fileName))
    if (prepared !== undefined) return ts.createSourceFile(fileName, prepared, languageVersionOrOptions, true, scriptKindOf(fileName))
    const overlaid = overlay?.get(resolve(fileName))
    const file =
      overlaid === undefined
        ? read(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, overlaid, languageVersionOrOptions, true, scriptKindOf(fileName))
    if (!file) return file
    if (file.isDeclarationFile) return withoutShadowedAmbientModules(file, shadowedSpecifiers, languageVersionOrOptions)
    let text = jsonModuleAsTypeScript(fileName, file.text) ?? file.text
    const declarationFileName = declarations.get(resolve(fileName))
    for (const [index, transform] of transforms.entries()) {
      text = timing.measure(
        `transform:${index}:${transform.name}`,
        () => transform({ fileName, text, ...(declarationFileName ? { declarationFileName } : {}) }) ?? text
      )
    }
    const transformed =
      text === file.text ? file : ts.createSourceFile(fileName, text, languageVersionOrOptions, true, scriptKindOf(fileName))
    // Asked of the TRANSFORMED file, not the one on disk: a plugin (or the
    // `.json` rewrite above) can add the import or export that already makes
    // the file a module, and can equally introduce the top-level `await` that
    // asks for one. Either way the question is about the text this program
    // actually compiles.
    const marked = moduleMarkerForTopLevelAwait(transformed)
    if (marked === null) return transformed
    return ts.createSourceFile(fileName, marked, languageVersionOrOptions, true, scriptKindOf(fileName))
  }
  return host
}

interface ConfiguredProgram {
  readonly program: ts.Program
  readonly runtimeModuleTargetOf: CompiledProgram['runtimeModuleTargetOf']
  readonly commonJsTargetPaths: readonly string[]
}

/**
 * A literal CommonJS require is a runtime module edge even though TypeScript
 * does not treat its string argument as a module-specifier node.  Admit only
 * calls whose resolved callee is an EXACT declaration the installed host owns;
 * a local function, caller ambient, or a merged declaration coincidentally
 * called `require` remains ordinary source and cannot pull a second module
 * graph into this program.
 */
const staticCommonJsTargetsOf = (
  program: ts.Program,
  globals: ReadonlyMap<string, CommonJsWrapperDeclaration>,
  targetOf: CompiledProgram['runtimeModuleTargetOf']
): readonly string[] => {
  if (globals.size === 0) return []
  const checker = program.getTypeChecker()
  const requireCensus = createCommonJsRequireCensus(checker, program.getSourceFiles(), globals)
  const targets = new Set<string>()
  const visit = (node: ts.Node, sourceFile: ts.SourceFile): void => {
    const argument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined
    if (ts.isCallExpression(node) && argument && ts.isStringLiteralLike(argument) && requireCensus.statusOf(node.expression) === 'static') {
      const target = targetOf(argument.text, sourceFile.fileName, 'require')
      if (target !== null) targets.add(target)
    }
    ts.forEachChild(node, (child) => visit(child, sourceFile))
  }
  for (const sourceFile of program.getSourceFiles()) if (!sourceFile.isDeclarationFile) visit(sourceFile, sourceFile)
  return [...targets]
}

/**
 * `getBuiltinModule` is a native, dynamic lookup, not a source import.  A
 * literal call is nevertheless enough evidence to retain the host's stated
 * implementation source and register its ModuleRecord before the call runs.
 * The method binding, loader spelling map, and source map are all host data;
 * this program layer does not recognize a Process spelling on its own.
 */
const staticBuiltinModuleTargetsOf = (
  program: ts.Program,
  bindings: HostMethodBindingTable,
  names: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, string>
): readonly string[] => {
  if (bindings.size === 0 || names.size === 0 || sources.size === 0) return []
  const checker = program.getTypeChecker()
  const targets = new Set<string>()
  const visit = (node: ts.Node): void => {
    const argument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node) &&
      argument &&
      ts.isStringLiteralLike(argument) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    ) {
      const method = resolveHostMethod(checker, bindings, node.expression)
      const name = method?.builtinModuleLookup ? names.get(argument.text) : undefined
      const source = name === undefined ? undefined : sources.get(name)
      if (source !== undefined) targets.add(resolve(source))
    }
    ts.forEachChild(node, visit)
  }
  for (const sourceFile of program.getSourceFiles()) if (!sourceFile.isDeclarationFile) visit(sourceFile)
  return [...targets]
}

const configuredProgram = (
  input: ProgramInput,
  resolutionDiagnostics: { readonly literal: ts.StringLiteralLike; readonly diagnostic: ts.Diagnostic }[],
  preparedSourceText: ReadonlyMap<string, string>,
  timing: FrontendTiming
): ConfiguredProgram => {
  const runtimeModuleTargetOf = (host: ts.CompilerHost, options: ts.CompilerOptions): CompiledProgram['runtimeModuleTargetOf'] => {
    const resolver = createModuleResolver(host, options, input.declarationModules, input.packageSources)
    return (specifier, containingFile, mode) => {
      const statedTarget = input.moduleResolution?.get(resolve(containingFile))?.get(specifier)
      const result = resolver.resolve(specifier, containingFile, mode === 'require' ? ts.ModuleKind.CommonJS : undefined, statedTarget)
      let implementation = result.implementation
      if (implementation && !statedTarget) {
        const source = mappedTypeScriptSource(implementation.resolvedFileName, host)
        if (source) implementation = { ...implementation, resolvedFileName: source, extension: moduleExtension(source) }
      }
      return implementation ? resolve(implementation.resolvedFileName) : null
    }
  }
  const projectFileName = input.projectFileName
  const buildProgram = (rootNames: readonly string[], options: ts.CompilerOptions, host: ts.CompilerHost): ConfiguredProgram => {
    const targetOf = runtimeModuleTargetOf(host, options)
    const roots = new Set(rootNames)
    const commonJsTargetPaths = new Set<string>()
    let program = timing.measure('create-program', () => ts.createProgram({ rootNames: [...roots], options, host }))
    for (;;) {
      const targets = [
        ...staticCommonJsTargetsOf(program, input.commonJsGlobals ?? new Map(), targetOf),
        ...staticBuiltinModuleTargetsOf(
          program,
          input.hostMethodBindings ?? new Map(),
          input.commonJsBuiltinModules ?? new Map(),
          input.commonJsBuiltinModuleSources ?? new Map()
        )
      ]
      for (const target of targets) commonJsTargetPaths.add(target)
      const added = targets.filter((target) => !roots.has(target) && program.getSourceFile(target) === undefined)
      if (added.length === 0) break
      for (const target of added) {
        roots.add(target)
      }
      program = timing.measure('rebuild-program', () => ts.createProgram({ rootNames: [...roots], options, host }))
    }
    return { program, runtimeModuleTargetOf: targetOf, commonJsTargetPaths: [...commonJsTargetPaths] }
  }
  if (!projectFileName) {
    const options = { ...input.options, ...(input.dynamicFallback ? { noImplicitAny: false, checkJs: false } : {}) }
    const host = transformingHost(input, options, resolutionDiagnostics, preparedSourceText, timing)
    const rootNames = [
      ...new Set([
        ...input.rootFileNames,
        ...(input.commonJsGlobals ? [...input.commonJsGlobals.values()].map((entry) => entry.declarationFileName) : [])
      ])
    ]
    // `host` is omitted rather than passed as `undefined`: under
    // `exactOptionalPropertyTypes` the two are different, and the option is
    // "the caller supplies a host" -- not "the caller supplies no host".
    return buildProgram(rootNames, options, host ?? ts.createCompilerHost(options, true))
  }

  const read = ts.readConfigFile(projectFileName, ts.sys.readFile)
  if (read.error) {
    throw new Error(`project file ${projectFileName} could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`)
  }
  // The base directory must be absolute. `parseJsonConfigFileContent` resolves
  // `include` globs against it by asking the filesystem, and a relative base
  // silently matches nothing -- which reads as a project that declares no files
  // rather than as an error, so every ambient declaration disappears and every
  // wildcard import in the program becomes an unresolved specifier.
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolve(dirname(projectFileName)))
  // The roots the caller named are added to the project's own file set rather
  // than replacing it: a caller compiling one file of a project still needs the
  // project's ambient declarations, and the project still needs to be told which
  // file the caller cares about in case `include` does not cover it.
  // Declarations only when the caller stated the module set: see
  // `ProgramInput.statedModuleSet` for why a staged project's wildcard
  // `include` is not this application's module list.
  const projectFiles = input.statedModuleSet ? parsed.fileNames.filter(isDeclarationPath) : parsed.fileNames
  const rootNames = [
    ...new Set([
      ...projectFiles,
      ...input.rootFileNames,
      ...(input.commonJsGlobals ? [...input.commonJsGlobals.values()].map((entry) => entry.declarationFileName) : [])
    ])
  ]
  const options = {
    ...parsed.options,
    ...javaScriptAdmission(input.options),
    ...fixedOptions,
    ...(input.dynamicFallback ? { noImplicitAny: false, checkJs: false } : {})
  }
  const host = transformingHost(input, options, resolutionDiagnostics, preparedSourceText, timing)
  return buildProgram(rootNames, options, host ?? ts.createCompilerHost(options, true))
}

/**
 * The caller's root file names, resolved to this program's own source files.
 *
 * `getSourceFile` is asked before `resolve` so a caller that already handed in
 * an absolute path is answered without touching the filesystem; the second
 * attempt is what makes a relative root work. A name that resolves to nothing
 * contributes nothing rather than throwing -- the program still contains every
 * file the project declared, and the honest consequence of an unresolvable
 * root is that this compilation has no entry point to prune from.
 */
const entryFilesOf = (program: ts.Program, rootFileNames: readonly string[]): readonly ts.SourceFile[] => {
  const found: ts.SourceFile[] = []
  for (const name of rootFileNames) {
    const file = program.getSourceFile(name) ?? program.getSourceFile(resolve(name))
    if (file && !file.isDeclarationFile) found.push(file)
  }
  return found
}

export const createProgram = (input: ProgramInput): CompiledProgram => {
  const timing = createFrontendTiming('program')
  const resolutionDiagnostics: { readonly literal: ts.StringLiteralLike; readonly diagnostic: ts.Diagnostic }[] = []
  let configured = configuredProgram(input, resolutionDiagnostics, new Map(), timing)
  const preparation = timing.measure('diagnostic-source-preparation', () =>
    diagnosticSourcePreparation(ts, configured.program, input.packageSources ?? [])
  )
  // A bare `var require` in a CommonJS module redeclares the wrapper's own
  // parameter; blanked here so the checker types the name from the host's
  // declaration instead of from an uninitialized local (`commonjs-wrapper.ts`).
  const redeclarations = withoutBareWrapperRedeclarations(
    configured.program,
    new Set(input.commonJsGlobals?.keys() ?? []),
    preparation.sourceText
  )
  if (preparation.audit.length > 0 || redeclarations.size > 0) {
    resolutionDiagnostics.length = 0
    configured = configuredProgram(input, resolutionDiagnostics, new Map([...preparation.sourceText, ...redeclarations]), timing)
  }
  const program = configured.program
  const checker = withStableTypeQueries(program.getTypeChecker())
  const sourceFiles = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  const diagnostics = [
    ...timing.measure('syntactic-diagnostics', () => program.getSyntacticDiagnostics()),
    ...timing.measure('semantic-diagnostics', () => program.getSemanticDiagnostics()),
    ...resolutionDiagnostics
      .filter(({ literal }) => !typeOnlyModuleUse(literal, checker, program.getCompilerOptions().verbatimModuleSyntax))
      .map(({ diagnostic }) => diagnostic)
  ]
  timing.report()
  return {
    program,
    checker,
    runtimeModuleTargetOf: configured.runtimeModuleTargetOf,
    sourceFileOf: (fileName) => program.getSourceFile(fileName) ?? null,
    commonJsSourceFiles: configured.commonJsTargetPaths.flatMap((fileName) => {
      const sourceFile = program.getSourceFile(fileName)
      return sourceFile ? [sourceFile] : []
    }),
    sourceFiles,
    entryFiles: entryFilesOf(program, input.rootFileNames),
    sourcePreparations: preparation.audit,
    // A program that does not typecheck has no well-defined semantics to port.
    // Collecting these here means the compiler can refuse before normalizing,
    // rather than normalizing a program the checker never validated.
    diagnostics
  }
}
