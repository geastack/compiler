#!/usr/bin/env node
import { isNodeProjectArguments, runNodeProject } from './cli-project.js'
import { compile } from './compiler.js'
import { runEmit } from './cli-emit.js'
import { runAnalyze } from './cli-analyze.js'
import { runCoverage } from './cli-coverage.js'
import { findProjectFile } from './semantics/program.js'
import type { Diagnostic } from './diagnostics/model.js'
import { preflightReportLines } from './preflight/report.js'
import { structuralShapeKey } from './semantics/model/structural-types.js'
import { closeSync, openSync, writeSync } from 'node:fs'

/**
 * The command line.
 *
 * It prints the complete diagnostic set, never a top-N. A truncated report
 * trains a reader to believe the compiler found what it printed, and the whole
 * reason the sweep collects every independently provable failure is so one run
 * shows the real size of the gap.
 */

interface ParsedArguments {
  readonly rootFileNames: readonly string[]
  readonly preflight: boolean
  readonly emit: boolean
  readonly projectFileName: string | null
}

/**
 * `--project <tsconfig.json>` names the project explicitly; `--no-project`
 * compiles the roots under this compiler's own defaults. With neither, the
 * project nearest the first root file is used -- because a file's meaning is
 * the meaning its own project gives it, and silently compiling it under
 * different options reports defects the application does not have.
 */
const parseArguments = (argv: readonly string[]): ParsedArguments => {
  const positional = argv.filter((argument) => !argument.startsWith('--'))
  const flagIndex = argv.indexOf('--project')
  const named = flagIndex >= 0 ? (argv[flagIndex + 1] ?? null) : null
  const rootFileNames = named ? positional.filter((argument) => argument !== named) : positional
  const first = rootFileNames[0]
  const discovered = first ? findProjectFile(first.slice(0, Math.max(0, first.lastIndexOf('/'))) || '.') : null
  return {
    rootFileNames,
    preflight: argv.includes('--preflight'),
    emit: argv.includes('--emit'),
    projectFileName: argv.includes('--no-project') ? null : (named ?? discovered)
  }
}

const formatDiagnostic = (diagnostic: Diagnostic): string => {
  const where = diagnostic.location
    ? `${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}`
    : diagnostic.component
  const primitive = diagnostic.missingPrimitive ? ` [${diagnostic.missingPrimitive}]` : ''
  // A bounded projection, not a truncation: a derived row in a large component
  // cites every root in it, and printing all of them on every row buries the
  // roots themselves. `--preflight` writes the complete census.
  const causes =
    diagnostic.causedBy.length === 0
      ? ''
      : diagnostic.causedBy.length <= 3
        ? `\n      caused by: ${diagnostic.causedBy.join(', ')}`
        : `\n      caused by: ${diagnostic.causedBy.length} root row(s) in this component; see --preflight`
  return `  ${diagnostic.severity.padEnd(11)} ${where}${primitive}\n      ${diagnostic.message}${causes}`
}

const usage =
  'usage: geatsc [--dynamic-fallback] [--debug] [--emit-only] [--verbose] [--translation-units single|per-file|balanced] (build the current Node project)\n' +
  'usage: geatsc <file.ts...> [--project <tsconfig.json>] [--no-project] [--preflight] [--emit] [--dynamic-fallback]\n' +
  '       geatsc compile <input> --out-dir <dir> [--project <tsconfig.json>] [--target cpp] [--entry-symbol <symbol>] [--translation-units single|per-file|balanced] [--dynamic-fallback] [--closed-script-scope]\n' +
  '       geatsc compile-module-graph <manifest> --entry <file> --out-dir <dir> [compile options, including --closed-script-scope]\n' +
  '       --closed-script-scope asserts this compile is the complete classic-script lexical realm; it does not close globalThis or object mutation\n' +
  '       compile options include [--plugin <module>]... [--plugin-option <key>=<value>]...\n' +
  '       geatsc analyze <entry> --plugin <module>\n' +
  '       geatsc coverage <entry> [--project <tsconfig.json>] [--no-project] [--plugin <module>] [--json] [--no-derived] [--no-boxed]'

export const main = async (argv: readonly string[]): Promise<number> => {
  // `compile` is the build pipeline's own spelling (`build-gea-vite-geatsc.mjs`
  // invokes `<bin> compile <input> --out-dir ...`), so it is dispatched before
  // anything else parses argv: that command writes files and reports on stderr,
  // where this one reports a census on stdout, and folding the two would make
  // the diagnostic output part of a build's stdout contract.
  if (argv[0] === 'compile') return runEmit(argv.slice(1))
  if (argv[0] === 'compile-module-graph') return runEmit(argv.slice(1), true)
  const parsed = parseArguments(argv)
  if (parsed.rootFileNames.length === 0) {
    process.stdout.write(`${usage}\n`)
    return 1
  }

  const result = compile({
    rootFileNames: parsed.rootFileNames,
    projectFileName: parsed.projectFileName,
    dynamicFallback: argv.includes('--dynamic-fallback')
  })

  const lines: string[] = []
  lines.push(
    `semantics: ${result.graph.operations.size} operation(s), ${result.graph.structuralTypes.size} structural type(s), ` +
      `${result.graph.edges.length} edge(s)`
  )
  if (result.uninstalledFamilies.length > 0) {
    lines.push(`uninstalled families: ${[...result.uninstalledFamilies].sort().join(', ')}`)
  }
  lines.push(
    `representations: ${result.representations.plan.selected.size} selected, ${result.representations.committed.length} component(s) ` +
      `committed, ${result.representations.blocked.length} blocked, ${result.representations.violations.length} guard violation(s)`
  )
  lines.push(
    `preflight: ${result.preflight.totals.mandatory.satisfied} satisfied, ${result.preflight.totals.mandatory.missing} missing, ` +
      `${result.preflight.totals.mandatory.unsupported} unsupported, ${result.preflight.totals.mandatory.blockedByUpstream} blocked`
  )
  // The certificate gates emission, not lowering: an uncertified program still
  // lowers whatever its plan verified, and the IR certification's refusals
  // print below like any other's (certification covers the lowered IR).
  lines.push(result.certificate ? `certificate: ${result.certificate.id}` : 'certificate: not minted; nothing is emitted')
  if (result.certificate) {
    lines.push(
      result.source
        ? `emitted: ${result.source.split('\n').length} line(s) of C++`
        : `emitted: nothing; ${result.loweringBlockers.length} body/bodies have no IR lowering yet`
    )
  }
  // One list, every stage. A refused body is the answer, not an omission, so
  // each row says which owner it is and what it lacked; a refused calling
  // convention is a cause, not a consequence, and prints beside the bodies it
  // stopped rather than being computed and shown to nobody.
  //
  // The `census` stage is SUMMARISED rather than enumerated, because it answers
  // a different question from the rest of the list. An abi/lower/certify/print
  // row says why a body produced no C++, and there are as many of those as
  // there are refused bodies. A census row says why one CELL went untyped --
  // the program still emits, just dynamically -- and a large program has
  // thousands. Printing them beside the emission refusals would bury the
  // answer this summary exists to give under the boxing report, so the counts
  // per root go here and `CompileResult.refusals` keeps every row for the
  // caller that wants them.
  const censusRefusals = result.refusals.filter((refusal) => refusal.stage === 'census')
  for (const refusal of result.refusals) {
    if (refusal.stage === 'census') continue
    lines.push(`  ${refusal.stage.padEnd(11)} ${refusal.owner}\n      ${refusal.reason}`)
  }
  if (censusRefusals.length > 0) {
    const byRoot = new Map<string, number>()
    for (const refusal of censusRefusals) byRoot.set(refusal.key, (byRoot.get(refusal.key) ?? 0) + 1)
    lines.push(`census: ${censusRefusals.length} cell(s) untyped`)
    for (const [key, count] of [...byRoot].sort((left, right) => right[1] - left[1])) lines.push(`  ${String(count).padStart(6)} ${key}`)
  }

  if (result.diagnostics.diagnostics.length > 0) {
    lines.push(`diagnostics (${result.diagnostics.diagnostics.length}):`)
    for (const diagnostic of result.diagnostics.diagnostics) lines.push(formatDiagnostic(diagnostic))
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  // Written in bounded chunks, never as one string: see `preflightReportLines`.
  if (parsed.preflight) {
    let chunk = ''
    for (const line of preflightReportLines(result.preflight)) {
      chunk += line
      if (chunk.length >= 1 << 16) {
        process.stdout.write(chunk)
        chunk = ''
      }
    }
    if (chunk.length > 0) process.stdout.write(chunk)
  }
  // The structural type table beside the census, one `id<TAB>key` line per
  // type, so a `type|N` a report row cites can be read back to the declared
  // name (and, through `decl|fN|ordinal`, to its source) without re-running
  // the frontend. An instrument like `GEA_STAGE_TIMING`, not a flag.
  const dumpTypes = process.env['GEA_DUMP_STRUCTURAL_TYPES']
  if (dumpTypes) {
    const out = openSync(dumpTypes, 'w')
    let chunk = ''
    for (const [id, type] of result.graph.structuralTypes) {
      chunk += `${id}\t${structuralShapeKey(type.shape)}\n`
      if (chunk.length >= 1 << 16) {
        writeSync(out, chunk)
        chunk = ''
      }
    }
    if (chunk.length > 0) writeSync(out, chunk)
    closeSync(out)
  }
  if (parsed.emit && result.source) process.stdout.write(`${result.source}\n`)
  return result.certificate ? 0 : 1
}

const argv = process.argv.slice(2)
// Compilation commands and host analysis load plugin modules asynchronously.
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage}\n`)
} else if (isNodeProjectArguments(argv)) {
  void runNodeProject(argv)
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(`[geatsc] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
} else if (argv[0] === 'analyze') {
  void runAnalyze(argv.slice(1)).then((code) => {
    process.exitCode = code
  })
} else if (argv[0] === 'coverage') {
  // `coverage` may load a plugin module too, so it shares the asynchronous path.
  void runCoverage(argv.slice(1)).then((code) => {
    process.exitCode = code
  })
} else {
  void main(argv)
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(`[geatsc] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
