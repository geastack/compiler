// Walk every runtime operand of every operation in a set of programs and
// report, per consumer (family, discriminator, role), how the slot census
// classifies it. Operands, not `graph.edges`: the property producer publishes
// no value edges for its receiver/key/value operands at all, so the edge
// index under-reports consumers -- the operand list is the ground truth.
//
// Until `src/projection/slots.ts` exists this prints the raw inventory; with
// it, every edge must be `slot` or `raw` -- an `unclassified` edge fails the
// gate (exit 1). Usage:
//   GEA_DIST=$PWD/dist node scripts/slot-census.mjs [--project=<tsconfig>] <files...>
//   GEA_DIST=$PWD/dist node scripts/slot-census.mjs --fixtures
//
// `--conversions` adds the conversion census's answer for every `slot`
// operand whose carrier differs from its slot: one row per capability kind
// (and per `never` reason), plus the pairs by program for the `never`s in
// certified programs. A certified program with a `never` pair is a pair the
// printer's chain answers today and the census does not -- the drift 1.3
// removes before the printer stops running the chain.
import ts from 'typescript'
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
const D = process.env.GEA_DIST ?? `${process.cwd()}/dist`
const { compile } = await import(D + '/compiler.js')
let slotsModule = null
try {
  slotsModule = await import(D + '/projection/slots.js')
} catch {}

const args = process.argv.slice(2)
const projectArg = args.find((a) => a.startsWith('--project='))
const project = projectArg ? projectArg.slice('--project='.length) : null
const files = args.filter((a) => !a.startsWith('--'))
const targets = []
if (args.includes('--fixtures')) {
  const isProgram = (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.d.ts')
  for (const f of readdirSync('test/fixtures')) if (isProgram(f)) targets.push({ file: join('test/fixtures', f), project: null })
  for (const sub of ['jsx', 'jsx-factory']) {
    for (const f of readdirSync(join('test/fixtures', sub)))
      if (isProgram(f)) targets.push({ file: join('test/fixtures', sub, f), project: join('test/fixtures', sub, 'tsconfig.json') })
  }
}
if (project && files.length === 0) {
  const raw = ts.readConfigFile(project, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, project.replace(/\/[^/]+$/, ''))
  targets.push({ file: parsed.fileNames, project })
} else for (const f of files) targets.push({ file: f, project })

const discriminatorOf = (op) => op.form ?? op.action ?? op.internalMethod ?? op.step ?? op.event ?? ''
const counts = new Map()
const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1)
let unclassified = 0
const conversions = args.includes('--conversions')
const conversionCounts = new Map()
const neverPairs = new Map()
const representationKey = slotsModule ? (await import(D + '/representation/model.js')).representationKey : null
let unclassifiedUncertified = 0
const uncertified = []
const where = new Map()
for (const t of targets) {
  let r
  try {
    r = compile({ rootFileNames: Array.isArray(t.file) ? t.file : [t.file], projectFileName: t.project })
  } catch (e) {
    console.error(`${Array.isArray(t.file) ? t.project : t.file}: threw ${String(e.message ?? e).split('\n')[0]}`)
    continue
  }
  const certified = r.certificate !== null
  if (!certified) uncertified.push(Array.isArray(t.file) ? t.project : t.file)
  const census = slotsModule
    ? slotsModule.createSlotCensus({
        graph: r.graph,
        plan: r.representations.plan,
        deriver: r.representations.deriver,
        ...r.projection
      })
    : null
  for (const op of r.graph.operations.values()) {
    const disc = op.family === 'protocol' ? `${op.protocol}/${op.step}` : discriminatorOf(op)
    for (const operand of op.operands) {
      const key = `${op.family}\t${disc}\t${operand.role}\t${operand.source.kind}\t${operand.evaluation.kind}`
      if (!census) {
        bump(key)
        continue
      }
      const answer = census.slotOf(op, operand)
      bump(`${key}\t${answer.kind}${answer.kind === 'unclassified' ? `\t${answer.reason}` : ''}`)
      if (conversions && (answer.kind === 'slot' || answer.kind === 'coerce')) {
        const carrier = census.enteringCarrierOf(op, operand)
        if (carrier && representationKey(carrier) !== representationKey(answer.representation)) {
          const node =
            answer.kind === 'coerce'
              ? r.conversionCensus.coercionFor(carrier, answer.operation)
              : r.conversionCensus.nodeFor(carrier, answer.representation)
          const cap = node.capability
          const label =
            cap.kind === 'never'
              ? `never\t${cap.reason.replace(/[^ ]*->[^ ]*/g, '<pair>')}`
              : cap.kind === 'atom' || cap.kind === 'static' || cap.kind === 'coercion'
                ? `${cap.kind}\t${cap.materializer.id}`
                : cap.kind
          const ck = `${certified ? 'certified' : 'uncertified'}\t${label}`
          conversionCounts.set(ck, (conversionCounts.get(ck) ?? 0) + 1)
          if (cap.kind === 'never' && certified) {
            const name = Array.isArray(t.file) ? t.project : t.file
            const pk = `${name}\t${op.family}/${disc}/${operand.role}\t${node.id}`
            neverPairs.set(pk, (neverPairs.get(pk) ?? 0) + 1)
          }
        }
      }
      if (answer.kind === 'unclassified') {
        if (certified) unclassified++
        else unclassifiedUncertified++
        const name = Array.isArray(t.file) ? t.project : t.file
        const k = `${answer.reason}\t${name}${certified ? '' : ' (uncertified)'}\t${op.id}`
        if (!where.has(k)) where.set(k, 0)
        where.set(k, where.get(k) + 1)
      }
    }
  }
}
for (const [k, v] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${String(v).padStart(7)}\t${k}`)
if (slotsModule) {
  if (where.size > 0) {
    console.log('--- unclassified, by program and operation')
    for (const [k, v] of [...where].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${String(v).padStart(7)}\t${k}`)
  }
  if (conversions) {
    console.log('--- conversion census over differing slot operands')
    for (const [k, v] of [...conversionCounts].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${String(v).padStart(7)}\t${k}`)
    if (neverPairs.size > 0) {
      console.log('--- never pairs in certified programs')
      for (const [k, v] of [...neverPairs].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${String(v).padStart(7)}\t${k}`)
    }
  }
  console.log(`uncertified programs: ${uncertified.length}${uncertified.length ? ' (' + uncertified.join(', ') + ')' : ''}`)
  console.log(`unclassified operands in uncertified programs: ${unclassifiedUncertified}`)
  console.log(`unclassified operands in certified programs: ${unclassified}`)
  if (unclassified > 0) process.exit(1)
}
