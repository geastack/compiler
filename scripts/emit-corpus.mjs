// Emit the C++ for every fixture into one directory, one file per
// program, so two builds can be compared byte-for-byte after SSA renumbering
// (`scripts/normalize-emitted.mjs --diff`). Programs that do not certify write
// nothing and are listed in `uncertified.txt`. A certified program that
// lowered but did not emit (a lowering blocker or an emission refusal) is
// listed there with its first reason, and every slot lowering could not fill
// from the conversion census is written to `drift.txt`, one row per
// (program, operation, role, pair) with the census's reason.
//   GEA_DIST=$PWD/dist node scripts/emit-corpus.mjs <out-dir>
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
const D = process.env.GEA_DIST ?? `${process.cwd()}/dist`
// GEA_DIST is an absolute path, and on Windows that makes `C:` look like a
// URL scheme to the ESM loader, so the specifier has to be a file URL.
const { compile } = await import(pathToFileURL(join(D, 'compiler.js')).href)
const out = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!out) throw new Error('usage: emit-corpus.mjs [--runtime] <out-dir>')
// `--runtime` emits the test/runtime programs instead of the fixtures:
// the same instrument over the suite whose slices pin each 1.4 category.
const runtime = process.argv.includes('--runtime')
// `--only=<substr>` restricts the run to programs whose name contains it.
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null
mkdirSync(out, { recursive: true })
// The runtime set's `.runtime.js` programs are compiled in JS mode by the
// suite; leaving them out kept 60 programs outside the byte-identity gate (the
// Phase 2.3 symbol regression was only visible in the suite).
const isProgram = (f) => (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js')) && !f.endsWith('.d.ts')
const targets = []
if (runtime) {
  for (const f of readdirSync('test/runtime'))
    if (isProgram(f) && !f.startsWith('_')) {
      // Match the runtime runner: per-program checking options are part of
      // the program. Ignoring them can silently leave a tested case outside
      // this gate as "uncertified" (notably open JavaScript computed reads).
      const perProgramProject = join('test/runtime', f.replace(/\.(?:tsx?|(?:runtime\.)?js)$/, '.tsconfig.json'))
      targets.push({
        name: basename(f),
        files: [join('test/runtime', f)],
        project: existsSync(perProgramProject) ? perProgramProject : join('test/runtime', 'tsconfig.json')
      })
    }
} else {
  const cfg = process.env.GEA_EXTERNAL_APP_TSCONFIG ?? `${process.cwd()}/projects/external-app.tsconfig.json`
  const raw = ts.readConfigFile(cfg, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, cfg.replace(/\/[^/]+$/, ''))
  targets.push({ name: 'taurus-display', files: parsed.fileNames, project: cfg })
  for (const f of readdirSync('test/fixtures'))
    if (isProgram(f)) targets.push({ name: basename(f), files: [join('test/fixtures', f)], project: null })
  for (const sub of ['jsx', 'jsx-factory']) {
    for (const f of readdirSync(join('test/fixtures', sub)))
      if (isProgram(f))
        targets.push({
          name: `${sub}-${basename(f)}`,
          files: [join('test/fixtures', sub, f)],
          project: join('test/fixtures', sub, 'tsconfig.json')
        })
  }
}
const uncertified = []
const drift = []
const printerDrift = []
let emitted = 0
const started = performance.now()
const cpuBefore = process.cpuUsage()
const timings = []
for (const t of targets) {
  if (only !== null && !t.name.includes(only)) continue
  let r
  const compileStarted = performance.now()
  try {
    // Every target is emitted as its own executable program; its complete
    // classic-script scope is closed for that run, while object/globalThis
    // mutation remains governed by the ordinary flow proofs.
    r = compile({ rootFileNames: t.files, projectFileName: t.project, closedScriptScope: true })
  } catch (e) {
    uncertified.push(`${t.name}\tthrew ${String(e.message ?? e).split('\n')[0]}`)
    continue
  } finally {
    if (process.env.GEA_GATE_TIMING === '1') timings.push({ name: t.name, milliseconds: performance.now() - compileStarted })
  }
  // Since Phase 2.1 an uncertified program lowers too, so its drift is real
  // and is written -- tagged, so the certified rows the gate compares stay
  // separable from rows on programs that never reach the printer.
  const certifiedTag = r.certificate ? 'certified' : 'uncertified'
  for (const row of r.slotDrift ?? [])
    drift.push(`${t.name}\t${certifiedTag}\t${row.operation}\t${row.role}#${row.ordinal}\t${row.source}\t${row.slot}\t${row.reason}`)
  for (const row of r.printerDrift ?? [])
    printerDrift.push(`${t.name}\t${row.site}\t${row.kind ?? 'refused'}\t${row.owner}\t${row.source}\t${row.target}\t${row.reason ?? ''}`)
  if (r.source === null) {
    const why = !r.certificate
      ? 'uncertified'
      : r.loweringBlockers.length > 0
        ? `lowering blocked: ${r.loweringBlockers[0].reason.split('\n')[0]}`
        : r.emissionRefusals.length > 0
          ? `emission refused: ${String(r.emissionRefusals[0].reason ?? r.emissionRefusals[0].message ?? JSON.stringify(r.emissionRefusals[0])).split('\n')[0]}`
          : 'certified, no source'
    uncertified.push(`${t.name}\t${why}`)
    continue
  }
  writeFileSync(join(out, `${t.name}.cpp`), r.source)
  emitted++
}
writeFileSync(join(out, 'uncertified.txt'), uncertified.join('\n') + '\n')
writeFileSync(join(out, 'drift.txt'), drift.join('\n') + (drift.length ? '\n' : ''))
writeFileSync(join(out, 'printer-drift.txt'), printerDrift.join('\n') + (printerDrift.length ? '\n' : ''))
console.log(
  `emitted ${emitted} programs, ${uncertified.length} without source, ${drift.filter((row) => row.split('\t')[1] === 'certified').length} drift rows on certified programs (${drift.filter((row) => row.split('\t')[1] === 'uncertified').length} on uncertified), ${printerDrift.filter((row) => row.split('\t')[2] === 'refused').length} printer refusals / ${printerDrift.length} printer conversions, into ${out}`
)

if (process.env.GEA_GATE_TIMING === '1') {
  const cpu = process.cpuUsage(cpuBefore)
  console.log(
    `[emit timing] ${JSON.stringify({ programs: timings.length, wallMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000, slowest: timings.sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 12) })}`
  )
}
