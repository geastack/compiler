import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from './compiler.js'
import type { CompilationResult } from './compiler.js'
import type { Diagnostic, DiagnosticLocation } from './diagnostics/model.js'
import { nodeOfOperation, operationOfResult } from './identity/ids.js'
import type { CompilerPlugin } from './plugins/model.js'
import { capabilityFamilies, familyOf, isCapabilityKey } from './ir/certify.js'
import { obligationKinds } from './preflight/obligations.js'
import type { EvaluatedObligation } from './preflight/run.js'
import { dynamicReasons } from './representation/model.js'
import type { DynamicReason } from './representation/model.js'
import { primitiveFamilies } from './semantics/model/coverage.js'
import { findProjectFile } from './semantics/program.js'

/**
 * `coverage <entry>` -- what of this program compiles natively, what boxes,
 * and what refuses, PER STATEMENT, with a stable code on every row.
 *
 * The compiler already knows all of it. The census, the representation plan,
 * the plan-level preflight rows, the IR certification and the emitter each
 * report their own outcome, and
 * `compile` returns every one of them; `geatsc <file>` prints the diagnostics
 * and `--preflight` writes the complete NDJSON census. What neither answers is
 * the question a person porting a program asks: "which lines of MY file are
 * the problem, and what kind of problem is each one?" A diagnostic message is
 * a representation-key dump written for the compiler's own authors, and a
 * carrier that BOXED is not a diagnostic at all -- the program compiles, runs,
 * and is slower than it says, with nothing printed.
 *
 * So this command joins the layers by source position and names each row by
 * a code that is stable across compiler versions:
 *
 *   G1xxx  the TypeScript checker's own errors (the program does not typecheck)
 *   G2xxx  a census blocker -- a language primitive family this compiler lacks
 *   G3xxx  a representation guard violation
 *   G4xxx  a plan-level preflight obligation that is missing or unsupported (by kind)
 *   G5xxx  an IR lowering blocker (a body with no lowering)
 *   G6xxx  an emission refusal (by the emitter's own category)
 *   G7xxx  a calling-convention (ABI) projection blocker
 *   G8xxx  a BOXED carrier: a value held as `gea::Value` (by reason)
 *   G9xxx  an IR certification refusal: a capability the target lacks (by family)
 *
 * The digits after the first index a fixed table in this file -- never a hash
 * of a message, so a reworded diagnostic keeps its code. A category this file
 * does not know gets the `x999` code of its layer, which is itself a signal
 * that the table needs a row.
 *
 * Boxed rows are the reason the command exists beside the diagnostics. The
 * compiler's rule is that a statically typed value carried as the box is a
 * defect to fix at the source (`CLAUDE.md`, "The Compiler Rule"); a program can
 * certify, compile and run with hundreds of them and no other tool says where.
 */

interface CoverageArguments {
  readonly entry: string | null
  readonly projectFileName: string | null | 'discover'
  readonly plugin: string | null
  readonly pluginOptions: ReadonlyMap<string, string>
  readonly json: boolean
  readonly derived: boolean
  readonly boxed: boolean
}

type RowStatus = 'refused' | 'unsupported' | 'derived' | 'boxed' | 'typecheck'

interface CoverageRow {
  readonly file: string | null
  readonly line: number
  readonly column: number
  readonly code: string
  readonly status: RowStatus
  readonly layer: string
  readonly message: string
  /** Identical rows at one position fold into one; this is how many. */
  readonly count: number
}

interface CoverageSummary {
  readonly operations: number
  readonly carriers: number
  readonly native: number
  readonly boxed: number
  readonly refusedRoots: number
  readonly derived: number
  readonly unsupported: number
  readonly typecheckErrors: number
  readonly loweringBlockers: number
  readonly emissionRefusals: number
  readonly abiBlockers: number
  readonly certifyRefusals: number
  readonly certified: boolean
  readonly emittedLines: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseArguments = (argv: readonly string[]): CoverageArguments => {
  let entry: string | null = null
  let projectFileName: string | null | 'discover' = 'discover'
  let plugin: string | null = null
  const pluginOptions = new Map<string, string>()
  let json = false
  let derived = true
  let boxed = true
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? ''
    if (argument === '--project') {
      projectFileName = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--no-project') {
      projectFileName = null
    } else if (argument === '--plugin') {
      plugin = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--plugin-option') {
      const pair = argv[index + 1] ?? ''
      const split = pair.indexOf('=')
      if (split > 0) pluginOptions.set(pair.slice(0, split), pair.slice(split + 1))
      index += 1
    } else if (argument === '--json') {
      json = true
    } else if (argument === '--no-derived') {
      derived = false
    } else if (argument === '--no-boxed') {
      boxed = false
    } else if (!argument.startsWith('--') && entry === null) {
      entry = argument
    }
  }
  return { entry, projectFileName, plugin, pluginOptions, json, derived, boxed }
}

/**
 * The plugin module's factory, the same contract `analyze` reads: the default
 * export, or the one exported function, called with no arguments. A host such
 * as node-compat (`plugin/v2.mjs`) exports `geatscNodePluginV2` this way.
 */
const loadPlugin = async (modulePath: string): Promise<CompilerPlugin | null> => {
  const loaded: unknown = await import(pathToFileURL(resolve(modulePath)).href)
  if (!isRecord(loaded)) return null
  const exported = loaded['default'] ?? Object.values(loaded).find((value) => typeof value === 'function')
  if (typeof exported !== 'function') return null
  const plugin: unknown = (exported as () => unknown)()
  if (!isRecord(plugin) || typeof plugin['instantiate'] !== 'function' || typeof plugin['name'] !== 'string') return null
  return plugin as unknown as CompilerPlugin
}

// ---------------------------------------------------------------------------
// The code tables. Order is the contract: a new entry goes at the END.
// ---------------------------------------------------------------------------

const emissionCategories: readonly string[] = [
  'call',
  'construct',
  'compute',
  'class-property',
  'class-static-property',
  'tagged-union-property',
  'try',
  'value-conversion',
  'test',
  'super-initialize',
  'regexp-property',
  'value-definition',
  'spread-copy',
  'return',
  'receiver',
  'host-method',
  'host-call',
  'element',
  'date-property',
  'data-view-property',
  'array-buffer-property',
  'allocate-callable',
  'allocate-array-object'
]

const dynamicReasonLabels: Partial<Record<DynamicReason, string>> = {
  'opt-in-fallback': 'dynamic fallback requested (--dynamic-fallback)',
  'tostring-of-unknown': 'ToString of a value the program never narrows',
  'thrown-error-carrier': 'a thrown value; JavaScript does not type throws',
  'unasserted-json-parse': 'JSON.parse with no `as T`',
  'declared-any-never-narrowed': 'declared any/unknown and never narrowed'
}

const code = (layer: number, index: number): string => `G${layer}${String(index).padStart(3, '0')}`
const tableCode = (layer: number, table: readonly string[], key: string): string => {
  const index = table.indexOf(key)
  return code(layer, index < 0 ? 999 : index + 1)
}

/** The obligation kind a `preflight/...` diagnostic row came from, by joining on its id. */
const obligationIndex = (result: CompilationResult): ReadonlyMap<string, EvaluatedObligation> =>
  new Map(result.preflight.obligations.map((obligation) => [`preflight/${obligation.id}`, obligation]))

/**
 * The emitter's category, read off the refusal text it wrote
 * (`cpp emission refuses to lower "<kind>": ...`, `emit-context.ts`). The
 * reason is the one place the emitter states its category to a caller, and it
 * is quoted on purpose so this read is a fixed-delimiter slice, not a guess.
 */
const emissionCategoryOf = (reason: string): string => {
  const marker = 'refuses to lower "'
  const start = reason.indexOf(marker)
  if (start < 0) return ''
  const from = start + marker.length
  const end = reason.indexOf('"', from)
  return end < 0 ? '' : reason.slice(from, end)
}

const diagnosticRow = (diagnostic: Diagnostic, obligations: ReadonlyMap<string, EvaluatedObligation>): CoverageRow => {
  const location = diagnostic.location
  const base = { file: location?.file ?? null, line: location?.line ?? 0, column: location?.column ?? 0, count: 1 }
  if (diagnostic.id.startsWith('checker/')) {
    return { ...base, code: code(1, 0), status: 'typecheck', layer: 'typecheck', message: diagnostic.message }
  }
  if (diagnostic.id.startsWith('census/')) {
    const family = diagnostic.missingPrimitive
    const rowCode = family === null ? code(2, 0) : tableCode(2, primitiveFamilies, family)
    return { ...base, code: rowCode, status: statusOf(diagnostic), layer: 'census', message: diagnostic.message }
  }
  if (diagnostic.id.startsWith('representation/')) {
    return { ...base, code: code(3, 1), status: statusOf(diagnostic), layer: 'representation', message: diagnostic.message }
  }
  if (diagnostic.id.startsWith('preflight/')) {
    const obligation = obligations.get(diagnostic.id)
    const rowCode = obligation ? tableCode(4, obligationKinds, obligation.kind) : code(4, 999)
    const layer = obligation ? `preflight/${obligation.kind}` : 'preflight'
    return { ...base, code: rowCode, status: statusOf(diagnostic), layer, message: diagnostic.message }
  }
  return { ...base, code: code(1, 999), status: statusOf(diagnostic), layer: 'frontend', message: diagnostic.message }
}

const statusOf = (diagnostic: Diagnostic): RowStatus =>
  diagnostic.severity === 'derived' ? 'derived' : diagnostic.severity === 'unsupported' ? 'unsupported' : 'refused'

const componentRow = (rowCode: string, layer: string, owner: string, reason: string): CoverageRow => ({
  file: null,
  line: 0,
  column: 0,
  code: rowCode,
  status: 'refused',
  layer,
  message: `${owner}: ${reason}`,
  count: 1
})

/**
 * Every selected carrier that is the box, placed at the operation that
 * produced it. Several results of one operation (a call's value and its
 * completion, say) box for one reason at one place; those fold into one row
 * with a count so a hundred rows do not stand for one line.
 */
const boxedRows = (result: CompilationResult): readonly CoverageRow[] => {
  const folded = new Map<string, CoverageRow>()
  for (const [resultId, carrier] of result.representations.plan.selected) {
    if (carrier.kind !== 'dynamic') continue
    let location: DiagnosticLocation | null = null
    try {
      location = result.locationOfNode(nodeOfOperation(operationOfResult(resultId)))
    } catch {
      location = null
    }
    const rowCode = tableCode(8, dynamicReasons, carrier.reason)
    const key = `${location?.file ?? ''}|${location?.line ?? 0}|${location?.column ?? 0}|${rowCode}`
    const existing = folded.get(key)
    if (existing) {
      folded.set(key, { ...existing, count: existing.count + 1 })
      continue
    }
    folded.set(key, {
      file: location?.file ?? null,
      line: location?.line ?? 0,
      column: location?.column ?? 0,
      code: rowCode,
      status: 'boxed',
      layer: 'carrier',
      message: `boxed as gea::Value: ${dynamicReasonLabels[carrier.reason] ?? carrier.reason}`,
      count: 1
    })
  }
  return [...folded.values()]
}

const collectRows = (result: CompilationResult, options: CoverageArguments): readonly CoverageRow[] => {
  const obligations = obligationIndex(result)
  const rows: CoverageRow[] = []
  for (const diagnostic of result.diagnostics.diagnostics) {
    if (!options.derived && diagnostic.severity === 'derived') continue
    rows.push(diagnosticRow(diagnostic, obligations))
  }
  for (const blocker of result.loweringBlockers) rows.push(componentRow(code(5, 1), 'lowering', blocker.owner, blocker.reason))
  for (const refusal of result.emissionRefusals) {
    rows.push(componentRow(tableCode(6, emissionCategories, emissionCategoryOf(refusal.reason)), 'emission', refusal.owner, refusal.reason))
  }
  for (const blocker of result.abiBlockers) rows.push(componentRow(code(7, 1), 'abi', blocker.functionId, blocker.reason))
  // The certification's refusals are `CompileResult.refusals` at stage
  // `certify`, never diagnostics: they are read off the lowered IR, after the
  // sweep that gates lowering has already run (the certifier has already passed). Keyed by capability family so the same missing recipe demanded from
  // many bodies is one code.
  for (const refusal of result.refusals) {
    // A certify-stage refusal always carries a capability key; the other
    // stages' sentinel keys (`abi:blocked`, ...) are excluded by the stage test.
    if (refusal.stage !== 'certify' || !isCapabilityKey(refusal.key)) continue
    rows.push(
      componentRow(
        tableCode(9, capabilityFamilies, familyOf(refusal.key)),
        `certify/${familyOf(refusal.key)}`,
        refusal.owner,
        `${refusal.key}: ${refusal.reason}`
      )
    )
  }
  if (options.boxed) rows.push(...boxedRows(result))
  return rows
}

const summarize = (result: CompilationResult): CoverageSummary => {
  const carriers = result.representations.plan.selected.size
  const boxed = [...result.representations.plan.selected.values()].filter((carrier) => carrier.kind === 'dynamic').length
  const diagnostics = result.diagnostics.diagnostics
  const typecheckErrors = diagnostics.filter((row) => row.id.startsWith('checker/')).length
  return {
    operations: result.graph.operations.size,
    carriers,
    native: carriers - boxed,
    boxed,
    refusedRoots: diagnostics.filter((row) => row.severity === 'root' && !row.id.startsWith('checker/')).length,
    derived: diagnostics.filter((row) => row.severity === 'derived').length,
    unsupported: diagnostics.filter((row) => row.severity === 'unsupported').length,
    typecheckErrors,
    loweringBlockers: result.loweringBlockers.length,
    emissionRefusals: result.emissionRefusals.length,
    abiBlockers: result.abiBlockers.length,
    certifyRefusals: result.refusals.filter((refusal) => refusal.stage === 'certify').length,
    certified: result.certificate !== null,
    emittedLines: result.source === null ? 0 : result.source.split('\n').length
  }
}

const compareRows = (left: CoverageRow, right: CoverageRow): number => {
  const leftFile = left.file ?? '~'
  const rightFile = right.file ?? '~'
  if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1
  if (left.line !== right.line) return left.line - right.line
  if (left.column !== right.column) return left.column - right.column
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0
}

const renderText = (entry: string, project: string | null, rows: readonly CoverageRow[], summary: CoverageSummary): string => {
  const cwd = process.cwd()
  const lines: string[] = []
  lines.push(`coverage  ${relative(cwd, entry)}  (project: ${project ? relative(cwd, project) : 'none'})`)
  let currentFile: string | null | undefined = undefined
  for (const row of rows) {
    if (row.file !== currentFile) {
      currentFile = row.file
      lines.push('')
      lines.push(row.file === null ? '(no source position)' : relative(cwd, row.file))
    }
    const where = row.file === null ? '' : `${row.line}:${row.column}`
    const times = row.count > 1 ? ` (x${row.count})` : ''
    lines.push(`  ${where.padEnd(9)} ${row.code}  ${row.status.padEnd(11)} ${row.message}${times}`)
  }
  lines.push('')
  lines.push(
    `summary: ${summary.operations} operations, ${summary.carriers} carriers (${summary.native} native, ${summary.boxed} boxed); ` +
      `${summary.refusedRoots} refused root(s), ${summary.derived} derived, ${summary.unsupported} unsupported, ${summary.typecheckErrors} typecheck error(s); ` +
      `${summary.loweringBlockers} lowering blocker(s), ${summary.certifyRefusals} capability refusal(s), ` +
      `${summary.emissionRefusals} emission refusal(s), ${summary.abiBlockers} abi blocker(s)`
  )
  lines.push(
    summary.certified
      ? `certificate: minted; emitted ${summary.emittedLines} line(s) of C++`
      : 'certificate: not minted; nothing is emitted'
  )
  const byCode = new Map<string, { layer: string; count: number }>()
  for (const row of rows) {
    const bucket = byCode.get(row.code) ?? { layer: row.layer, count: 0 }
    bucket.count += row.count
    byCode.set(row.code, bucket)
  }
  if (byCode.size > 0) {
    lines.push('by code:')
    for (const [rowCode, bucket] of [...byCode.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      lines.push(`  ${rowCode}  ${bucket.layer.padEnd(30)} x${bucket.count}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export const runCoverage = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseArguments(argv)
  if (parsed.entry === null) {
    process.stderr.write(
      'usage: geatsc coverage <entry> [--project <tsconfig.json>] [--no-project] [--plugin <module>] [--plugin-option k=v]... [--json] [--no-derived] [--no-boxed]\n'
    )
    return 1
  }
  const entry = resolve(parsed.entry)
  const plugin = parsed.plugin === null ? null : await loadPlugin(parsed.plugin)
  if (parsed.plugin !== null && plugin === null) {
    process.stderr.write(`coverage: ${parsed.plugin} does not export a compiler plugin factory\n`)
    return 1
  }
  const projectFileName =
    parsed.projectFileName === 'discover'
      ? findProjectFile(entry.slice(0, Math.max(0, entry.lastIndexOf('/'))) || '.')
      : parsed.projectFileName
  const result = compile({
    rootFileNames: [entry],
    projectFileName,
    ...(plugin ? { plugins: [plugin] } : {}),
    pluginOptions: new Map(parsed.pluginOptions)
  })
  const rows = [...collectRows(result, parsed)].sort(compareRows)
  const summary = summarize(result)
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ entry, project: projectFileName, summary, rows }, null, 2)}\n`)
  } else {
    process.stdout.write(renderText(entry, projectFileName, rows, summary))
  }
  return summary.certified && summary.loweringBlockers === 0 && summary.emissionRefusals === 0 ? 0 : 1
}
