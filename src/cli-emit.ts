import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from './compiler.js'
import { loadCliPlugins } from './plugins/load.js'
import type { CompilerPlugin } from './plugins/model.js'
import { readModuleGraph } from './cli-module-graph.js'
import { findProjectFile } from './semantics/program.js'
import type { CppTranslationUnitLayout } from './targets/cpp/translation-unit.js'

/**
 * The `compile <input> --out-dir <dir>` command the gea build pipeline drives.
 *
 * `core/packages/core/scripts/build-gea-vite-geatsc.mjs` already resolves the
 * compiler it runs through `--geatsc-bin` (line 3973), so this is an adapter on
 * THIS side of that seam and needs no change to the shipping pipeline: the
 * simulator, the esp32 targets and the apple targets all reach a compiler the
 * same way, and pointing that one option at this binary is the whole
 * integration. What the pipeline then expects back is narrow and stated in one
 * place -- the `.cpp` translation unit(s) in `--out-dir`, and a
 * `geatsc-sources.txt` beside them listing each one (and `geatsc-header.txt`
 * naming the shared header when the layout has one), which the calling script
 * reads to build its compile line.
 *
 * ## Options this honors, and the ones it refuses to pretend about
 *
 * The pipeline passes v1's whole option set, and most of it describes v1's own
 * build plumbing rather than a question this compiler answers. Ignoring an
 * option silently is the failure this file is written to avoid: `--cpp-board`
 * and `--allow-any` both CHANGE THE PROGRAM in v1, so a build that quietly
 * dropped them would produce a unit that does not match what the caller asked
 * for and no output would say so. Every option that is not honored is named on
 * stderr, once, by the name the caller passed.
 */

interface EmitRequest {
  readonly dynamicFallback: boolean
  /** Caller asserts this compilation is the complete classic-script realm. */
  readonly closedScriptScope: boolean
  readonly input: string
  readonly outDir: string
  readonly entrySymbol: string | null
  readonly target: string
  readonly entry: string | null
  readonly stage: string
  readonly plugins: readonly string[]
  readonly pluginOptions: ReadonlyMap<string, string>
  /**
   * The project this input compiles under, when the caller named one.
   *
   * `null` means "discover it", which is what this command has always done and
   * still does by default. Naming it was silently impossible before: `--project`
   * matched no case below, so the flag fell through and its VALUE -- not
   * starting with `--` -- was collected as a positional argument. The input was
   * still `positional[0]`, so nothing failed; the program simply compiled under
   * a different project than the caller asked for, which is a different program.
   * `scripts/corpus.mjs` passes a generated project precisely to fix module
   * resolution for the framework and for vendored sources, so a measurement
   * taken through this command was measuring a program with that fix absent.
   */
  readonly projectFileName: string | null
  /** `--isolate-symbols`: this unit is one of several a resident build links -- see `TranslationUnitInput.isolateSymbols`. */
  readonly isolateSymbols: boolean
  /** `--translation-units single|per-file`: how many C++ files the program becomes -- see `CppTranslationUnitLayout`. */
  readonly translationUnits: CppTranslationUnitLayout
  readonly unhonored: readonly string[]
}

/**
 * Options that carry a value this compiler does not model, and options that
 * are v1 build plumbing with no meaning here.
 *
 * `unmodeled` options change the program and must be reported. Explicit
 * plugins are loaded separately; their options belong to the plugin API.
 */
const plumbingWithValue = new Set(['--apple-platform'])
const unmodeledWithValue = new Set(['--cpp-board', '--cxx-standard'])
const unmodeledFlags = new Set(['--allow-any'])

const parseEmitArguments = (argv: readonly string[]): EmitRequest | string => {
  const positional: string[] = []
  const unhonored: string[] = []
  let outDir: string | null = null
  let entrySymbol: string | null = null
  let target = 'cpp'
  let entry: string | null = null
  let stage = 'hybrid'
  let projectFileName: string | null = null
  let dynamicFallback = false
  let closedScriptScope = false
  let isolateSymbols = false
  let translationUnits: CppTranslationUnitLayout = 'single'
  // Carried, never interpreted: an option here belongs to whichever library
  // its prefix names, and this command's job is to deliver it rather than to
  // have an opinion about it. `--plugin-option` used to be classified as build
  // plumbing and dropped, which silently discarded `gea.cpp-prelude` -- the
  // compiled stylesheet -- from every app this pipeline built.
  const plugins: string[] = []
  const pluginOptions = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (argument === '--out-dir') {
      outDir = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--entry-symbol') {
      entrySymbol = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--target') {
      target = argv[index + 1] ?? target
      index += 1
    } else if (argument === '--entry') {
      entry = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--module-graph-stage') {
      stage = argv[index + 1] ?? stage
      index += 1
    } else if (argument === '--dynamic-fallback') {
      dynamicFallback = true
    } else if (argument === '--closed-script-scope') {
      closedScriptScope = true
    } else if (argument === '--isolate-symbols') {
      isolateSymbols = true
    } else if (argument === '--translation-units') {
      const value = argv[index + 1] ?? ''
      if (value !== 'single' && value !== 'per-file' && value !== 'balanced')
        return `compile: --translation-units takes "single", "per-file", or "balanced", not "${value}"`
      translationUnits = value
      index += 1
    } else if (argument === '--project') {
      projectFileName = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--plugin') {
      const specifier = argv[index + 1]
      if (!specifier || specifier.startsWith('--')) return 'compile: --plugin requires a module path or specifier'
      plugins.push(specifier)
      index += 1
    } else if (argument === '--plugin-option') {
      const pair = argv[index + 1] ?? ''
      const split = pair.indexOf('=')
      if (split <= 0 || pair.startsWith('--')) return 'compile: --plugin-option requires key=value'
      pluginOptions.set(pair.slice(0, split), pair.slice(split + 1))
      index += 1
    } else if (plumbingWithValue.has(argument)) {
      index += 1
    } else if (unmodeledWithValue.has(argument)) {
      unhonored.push(`${argument} ${argv[index + 1] ?? ''}`.trim())
      index += 1
    } else if (unmodeledFlags.has(argument)) {
      unhonored.push(argument)
    } else if (!argument.startsWith('--')) {
      positional.push(argument)
    }
  }
  const input = positional[0]
  if (input === undefined) return 'compile: no input file'
  if (outDir === null) return 'compile: --out-dir is required'
  return {
    dynamicFallback,
    closedScriptScope,
    input,
    outDir,
    entrySymbol,
    target,
    entry,
    stage,
    plugins,
    pluginOptions,
    projectFileName,
    isolateSymbols,
    translationUnits,
    unhonored
  }
}

/**
 * The stem the emitted files are named from.
 *
 * Named after the input rather than after the entry symbol: the caller already
 * knows the bundle it handed over, and a build that produced `gea-app.cpp` for
 * every app would collide the moment two of them share an `--out-dir`, which
 * is exactly what a resident multi-app build does. Under `single` the one unit
 * is `<stem>.cpp`; under `per-file` the same stem prefixes the header, the
 * program unit and every module unit, so one app's files sort together.
 */
const unitStemOf = (input: string): string => {
  const stem = basename(input).replace(/\.[cm]?[jt]sx?$/, '')
  return stem.length > 0 ? stem : 'unit'
}

/**
 * Runs the pipeline and writes what it produced.
 *
 * The certificate gate is not re-litigated here: `compile` refuses to lower
 * anything without one, so `source === null` is already the complete answer
 * that this program is not yet compilable, and this command's job is to report
 * that with the same detail the diagnostic CLI would rather than to write a
 * partial unit the caller would try to build.
 */
export const runEmit = async (argv: readonly string[], moduleGraph = false): Promise<number> => {
  const parsed = parseEmitArguments(argv)
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n`)
    return 1
  }
  if (parsed.target !== 'cpp') {
    process.stderr.write(`compile: --target ${parsed.target} is not a target this compiler emits; only "cpp" is built\n`)
    return 1
  }
  for (const option of parsed.unhonored) {
    process.stderr.write(`compile: option not honored by this compiler: ${option}\n`)
  }

  const plugins = await loadCliPlugins(parsed.plugins)
  if (moduleGraph) return runModuleGraph(parsed, plugins)
  const input = resolve(parsed.input)
  // A generated bundle is not a member of any project.
  //
  // It is written INTO a build directory that usually sits inside one, so
  // walking up for a `tsconfig.json` finds the app's -- and then applies that
  // project's `include`, `paths` and `lib` to a file the app never declared,
  // which is a different program than the one the caller asked to compile. A
  // bundle carries everything it needs (its own `/// <reference>` to the
  // generated type hints), so the honest reading is that it has no project,
  // and its types come from JSDoc.
  const bundled = /\.[cm]?js$/.test(input)
  // A named project wins over discovery, and over the bundle rule above: a
  // caller that states which project an input belongs to has answered the
  // question this command would otherwise guess at.
  const projectFileName =
    parsed.projectFileName ?? (bundled ? null : findProjectFile(input.slice(0, Math.max(0, input.lastIndexOf('/'))) || '.'))
  const result = compile({
    rootFileNames: [input],
    projectFileName,
    javaScriptSources: bundled,
    dynamicFallback: parsed.dynamicFallback,
    ...(parsed.closedScriptScope ? { closedScriptScope: true } : {}),
    plugins,
    pluginOptions: parsed.pluginOptions,
    isolateSymbols: parsed.isolateSymbols,
    translationUnits: parsed.translationUnits,
    unitBaseName: unitStemOf(parsed.input),
    ...(parsed.entrySymbol === null ? {} : { entrySymbol: parsed.entrySymbol })
  })

  return report(result, parsed.outDir)
}

/**
 * `compile-module-graph`: the path every real application build takes.
 *
 * The manifest names the modules and carries their text; the entry the pipeline
 * states is the root. The project is the one nearest that entry -- the staged
 * `tsconfig.json` the pipeline writes beside it, which is what gives the
 * program its `jsx` setting and its lib. JSDoc typing is forced on for the same
 * reason v1 forces it here and states in capitals: this path has no
 * tsc-baseline to match, and a module whose types live in JSDoc silently
 * becomes an untyped, boxed one if `checkJs` is off.
 */
const runModuleGraph = (parsed: EmitRequest, plugins: readonly CompilerPlugin[]): number => {
  const graph = readModuleGraph(parsed.input, parsed.stage, parsed.entry)
  const result = compile({
    rootFileNames: [graph.entry],
    projectFileName: parsed.projectFileName ?? findProjectFile(dirname(graph.entry)),
    javaScriptSources: true,
    dynamicFallback: parsed.dynamicFallback,
    plugins,
    pluginOptions: parsed.pluginOptions,
    sourceOverlay: graph.overlay,
    moduleResolution: graph.imports,
    // The graph is the module set; the staged project beside the entry is not.
    statedModuleSet: true,
    ...(parsed.closedScriptScope ? { closedScriptScope: true } : {}),
    isolateSymbols: parsed.isolateSymbols,
    translationUnits: parsed.translationUnits,
    unitBaseName: unitStemOf(graph.entry),
    ...(parsed.entrySymbol === null ? {} : { entrySymbol: parsed.entrySymbol })
  })
  return report(result, parsed.outDir)
}

type CompileResult = ReturnType<typeof compile>

/** This compiler's own installation, from the module doing the asking rather than the caller's cwd. */
const compilerRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Write a file only when its content changes.
 *
 * The C++ build decides what to recompile by mtime -- its own objects against
 * the units, and through depfiles against every header a unit includes. An
 * emit that rewrote every file made every generation a full rebuild: 20
 * unchanged units and both precompiled headers were rebuilt after one source
 * was touched, because the header and `gea_runtime.h` were newer than every
 * object. The emitted text is deterministic, so identical content is the same
 * fact and leaves the file, and its mtime, alone.
 */
const writeIfChanged = (path: string, content: string): void => {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  writeFileSync(path, content)
}

/**
 * `generated_support.hpp` — the second artifact the calling pipeline reads back.
 *
 * The contract is not only `geatsc-sources.txt`. A target derives an app's
 * Apple-native ownership from the *transformed compiler output* rather than
 * from the metadata it fed in, and the file it reads to do that is this one:
 * `finalize-apple-native-output.mjs` fails closed when it is missing or empty,
 * so a build driving this compiler stopped at "generation did not produce a
 * non-empty generated_support.hpp" no matter how good the emitted unit was.
 *
 * v1 writes a header full of shared declarations because it splits a program
 * across many translation units that each need the others' signatures. This
 * compiler's `single` layout emits ONE unit, so there is nothing for a second
 * unit to share, and its `per-file` layout writes the declarations its units
 * share into ITS OWN header (`<stem>.hpp`, `translation-unit.ts`) that every
 * unit includes by name. Either way the honest content here is the same
 * statement of what a generated unit is compiled against that the unit itself
 * makes, and nothing more. It is a declaration of ownership, not a substitute
 * for the unit's own preamble.
 *
 * Which host headers belong in it is not this file's question and it no longer
 * answers it. `gea_runtime.h` is stated unconditionally because every emitted
 * unit is compiled against it; everything else comes from
 * `result.generatedSupportIncludes`, which each plugin states for its own host
 * on its own activation condition. This function used to hold one host's
 * include spelling and decide the question by substring-searching the rendered
 * C++ for it -- a source-shaped authority over generated text, and a host name
 * in a core code path.
 */
const writeGeneratedSupport = (outDir: string, hostHeaders: readonly string[]): void => {
  const lines = [
    '// @geastack/compiler: what a generated translation unit is compiled against.',
    '// This states ownership, not declarations shared between units: a per-file',
    '// layout carries those in its own <stem>.hpp, which each unit includes.',
    '#pragma once',
    '#include "gea_runtime.h"',
    ...hostHeaders.map((header) => `#include "${header}"`)
  ]
  writeIfChanged(join(outDir, 'generated_support.hpp'), `${lines.join('\n')}\n`)
}

const report = (result: CompileResult, outDirName: string): number => {
  // Which file each `fN` identity segment names. A refusal cites raw ids
  // (`decl|f9|179`), and on the module-graph path -- the one every real
  // application build takes -- there is no other way to read one back to a
  // source file, so tracking a refusal down means guessing at an alphabetical
  // sort of the whole program including its lib files. An instrument like
  // `GEA_STAGE_TIMING` and `GEA_DUMP_STRUCTURAL_TYPES`, not a flag.
  if (process.env['GEA_DUMP_FILE_IDS']) {
    for (const [identity, fileName] of result.sourceFileNames) process.stderr.write(`[FILE] ${identity}\t${fileName}\n`)
  }
  if (result.units.length === 0) {
    const certifyRefusals = result.refusals.filter((refusal) => refusal.stage === 'certify')
    process.stderr.write(
      result.certificate === null
        ? `compile: no certificate; ${certifyRefusals.length} capability refusal(s), ${result.diagnostics.diagnostics.length} diagnostic(s)\n`
        : `compile: certified but nothing emitted; ${result.loweringBlockers.length} lowering blocker(s), ` +
            `${result.emissionRefusals.length} emission refusal(s)\n`
    )
    for (const blocker of result.loweringBlockers) process.stderr.write(`  lowering  ${blocker.owner}: ${blocker.reason}\n`)
    for (const refusal of certifyRefusals.slice(0, 40))
      process.stderr.write(`  certify   ${refusal.owner}: ${refusal.key}: ${refusal.reason}\n`)
    if (certifyRefusals.length > 40) process.stderr.write(`  ... and ${certifyRefusals.length - 40} more capability refusal(s)\n`)
    for (const refusal of result.emissionRefusals) process.stderr.write(`  emission  ${refusal.owner}: ${refusal.reason}\n`)
    // The location, when there is one. A build's log is where someone finds
    // out WHICH file did not compile, and a component id alone cannot answer
    // that -- it names a component of the graph, not a place in the program.
    const where = (diagnostic: (typeof result.diagnostics.diagnostics)[number]): string =>
      diagnostic.location ? `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}` : diagnostic.component
    const roots = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
    for (const diagnostic of roots) process.stderr.write(`  ${where(diagnostic)}: ${diagnostic.message}\n`)
    // A root diagnostic is the one worth reading, so it is the only one printed
    // WHEN THERE IS ONE. When there is not, printing nothing reported nothing:
    // `certificate` is withheld whenever `diagnostics` is non-empty at all, so
    // a program blocked solely by derived or unsupported diagnostics failed
    // with an empty log, and "no certificate; 0 capability refusal(s)" was the
    // whole message -- which names neither a cause nor a file. Four apps sat
    // behind that message with nothing to act on.
    if (roots.length === 0) {
      const rest = result.diagnostics.diagnostics
      for (const diagnostic of rest.slice(0, 20)) {
        process.stderr.write(`  ${diagnostic.severity}  ${where(diagnostic)}: ${diagnostic.message}\n`)
      }
      if (rest.length > 20) process.stderr.write(`  ... and ${rest.length - 20} more diagnostic(s)\n`)
      if (rest.length === 0 && certifyRefusals.length === 0) {
        process.stderr.write('  (no diagnostics recorded -- the certificate was withheld for another reason)\n')
      }
    }
    return 1
  }

  if (result.dynamicFallback.enabled) {
    process.stderr.write(`geatsc: C++ dynamic fallback selected for ${result.dynamicFallback.valueCount} value positions\n`)
  }
  const outDir = resolve(outDirName)
  mkdirSync(outDir, { recursive: true })
  // The emitted unit `#include`s this compiler's own runtime, so the runtime
  // has to arrive with it. The caller compiles what is in `--out-dir` and knows
  // nothing about where this compiler keeps its header -- and should not: which
  // runtime a unit needs is the compiler's fact, stated by putting it there.
  // Same placement `scripts/corpus.mjs` already uses to compile emitted units.
  writeIfChanged(join(outDir, 'gea_runtime.h'), readFileSync(join(compilerRoot, 'src/targets/cpp/runtime/gea_runtime.h'), 'utf8'))
  writeIfChanged(
    join(outDir, 'gea_dynamic_proxy.h'),
    readFileSync(join(compilerRoot, 'src/targets/cpp/runtime/gea_dynamic_proxy.h'), 'utf8')
  )
  writeIfChanged(join(outDir, 'gea_eval.h'), readFileSync(join(compilerRoot, 'src/targets/cpp/runtime/gea_eval.h'), 'utf8'))
  writeIfChanged(
    join(outDir, 'gea_native_class_prototype.h'),
    readFileSync(join(compilerRoot, 'src/targets/cpp/runtime/gea_native_class_prototype.h'), 'utf8')
  )
  writeIfChanged(
    join(outDir, 'gea_runtime_builtins.cpp'),
    readFileSync(join(compilerRoot, 'src/targets/cpp/runtime/gea_runtime_builtins.cpp'), 'utf8')
  )
  const written = result.units.map((unit) => ({ unit, path: join(outDir, unit.fileName) }))
  for (const { unit, path } of written) writeIfChanged(path, `${unit.source}\n`)
  writeGeneratedSupport(outDir, result.generatedSupportIncludes)
  // Whatever the installed hosts require beside the unit -- Apple's
  // `gea/apple/native_bridge.{h,mm}` is the case. After the units, and only on
  // the path that wrote them: an artifact sitting next to a build that emitted
  // nothing is a stale file the next build reads as fresh, which is precisely
  // the failure this hook was added to end.
  for (const writeArtifacts of result.artifacts) writeArtifacts(outDir)
  // The list the calling script reads back: every unit to COMPILE, so the
  // per-file layout's header is not on it -- a header is included, not built,
  // and a build handed one as a source would compile it as a unit of its own.
  // The `single` layout lists its one unit; the contract has always been a
  // LIST for exactly this reason, so every caller that reads it keeps working
  // when the layout changes.
  const compiled = written.filter(({ unit }) => unit.role !== 'header' && unit.role !== 'runtime-header')
  writeIfChanged(join(outDir, 'geatsc-sources.txt'), `${compiled.map(({ path }) => path).join('\n')}\n`)
  // The headers every listed unit includes, when the layout has them, so a
  // build can precompile each once -- the runtime layer first, the program's
  // header chained on it -- and hand `-include-pch` to every unit instead of
  // letting each re-parse both. Stated as a file of its own rather than
  // inferred from the sources list, and removed when the layout has no header,
  // because a stale one from an earlier per-file build would name headers the
  // single unit never includes.
  const header = written.find(({ unit }) => unit.role === 'header')
  const runtimeHeader = written.find(({ unit }) => unit.role === 'runtime-header')
  if (header && runtimeHeader) writeIfChanged(join(outDir, 'geatsc-header.txt'), `program=${header.path}\nruntime=${runtimeHeader.path}\n`)
  else rmSync(join(outDir, 'geatsc-header.txt'), { force: true })
  const lines = (text: string): number => text.split('\n').length
  const total = written.reduce((sum, { unit }) => sum + lines(unit.source), 0)
  const single = written.length === 1 ? written[0] : undefined
  process.stdout.write(
    single
      ? `compile: ${single.path} (${lines(single.unit.source)} lines)\n`
      : `compile: ${compiled.length} unit(s) and two shared headers in ${outDir} (${total} lines)\n`
  )
  return 0
}
