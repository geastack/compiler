import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * `numericNamesAbsentFrom`'s `GEA_INDEXED_ABSENCE_DEBUG` is read from
 * `process.env` at MODULE load time (`derived-expression-type.ts`'s
 * `numericAbsenceDebug` top-level `const`), and `flow/value-flow.ts` --
 * everything's entry point into this module -- imports it statically. So
 * setting `process.env.GEA_INDEXED_ABSENCE_DEBUG` from inside a `test()`
 * body, or even at the top of this file before its own imports, is too late:
 * ESM hoists every dependency's evaluation ahead of the importing module's
 * own top-level code, env-var assignment included. A CHILD process, given
 * the variable through `spawnSync`'s `env`, sees it before any module of its
 * own loads -- which is also the only way a real invocation of this switch
 * (`GEA_INDEXED_ABSENCE_DEBUG='*' node ...`) is ever exercised. Capturing
 * `result.stderr` from that child is this test's `process.stderr.write` spy.
 */
const distDir = fileURLToPath(new URL('.', import.meta.url))
// Resolved from THIS (parent) module's own `import.meta.url`, which is a real
// `file://` URL under `dist/semantics/normalize/`. The child below is fed as
// `--input-type=module` source over stdin, whose OWN `import.meta.url` is a
// synthetic (non-file) URL that cannot resolve a relative specifier against
// this directory -- so the absolute hrefs are computed here and spliced into
// the child's source text as string literals, not re-derived inside it.
const valueFlowUrl = new URL('flow/value-flow.js', import.meta.url).href
const reachabilityUrl = new URL('reachability.js', import.meta.url).href
const derivedExpressionTypeUrl = new URL('derived-expression-type.js', import.meta.url).href
const deferredIntrinsicProtocolsUrl = new URL('deferred-intrinsic-protocols.js', import.meta.url).href

/**
 * A class plus two offending keyed writes, reduced from
 * `indexed-absence.test.ts`'s `Context`/`poke` idiom (`function poke( target:
 * any, i: number ) { target[ i ] = 1; } poke( context, 0 );`, which that
 * suite's `'an actual context caller still blocks numeric class absence'`
 * already proves refuses numeric absence for one site) to TWO sites so the
 * enumeration has two `keyed-write` refusals to list in one run instead of
 * one.
 */
const childScript = `
import ts from 'typescript'
import { indexValueFlow } from ${JSON.stringify(valueFlowUrl)}
import { wholeProgram } from ${JSON.stringify(reachabilityUrl)}
import { numericIndexAbsenceProven } from ${JSON.stringify(derivedExpressionTypeUrl)}
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger
} from ${JSON.stringify(deferredIntrinsicProtocolsUrl)}

const source = \`
  class Widget { m(): void {} }
  declare const w: Widget;
  function poke( target: any, i: number ) { target[ i ] = 1; }
  function jab( target: any, i: number ) { target[ i ] = 2; }
  poke( w, 0 );
  jab( w, 1 );
\`
const entry = '/virtual/indexed-absence-enumeration-fixture.ts'
const options = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
const host = ts.createCompilerHost(options)
const original = host.getSourceFile.bind(host)
host.getSourceFile = (name, version, ...rest) =>
  name === entry ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS) : original(name, version, ...rest)
const program = ts.createProgram([entry], options, host)
const checker = program.getTypeChecker()
const file = program.getSourceFile(entry)
const flow = indexValueFlow(checker, [file], wholeProgram)
const ledger = createDeferredIntrinsicProtocolLedger()
attachDeferredIntrinsicProtocolLedger(flow, ledger)

let wInPoke = null
let numberParameter = null
const walk = (node) => {
  if (
    wInPoke === null &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'poke'
  )
    wInPoke = node.arguments[0]
  if (
    numberParameter === null &&
    ts.isFunctionDeclaration(node) &&
    node.name?.text === 'poke'
  )
    numberParameter = node.parameters[1].name
  ts.forEachChild(node, walk)
}
walk(file)

const receiver = checker.getTypeAtLocation(wInPoke)
const key = checker.getTypeAtLocation(numberParameter)
const accepted = ledger.capture(() => numericIndexAbsenceProven(checker, flow, receiver, key, null))
process.stdout.write(JSON.stringify({ accepted: accepted.value }))
`

test('GEA_INDEXED_ABSENCE_DEBUG enumerates every refusing write instead of stopping at the first', () => {
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: childScript,
    encoding: 'utf8',
    env: { ...process.env, GEA_INDEXED_ABSENCE_DEBUG: '*' },
    cwd: distDir
  })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stderr.trim().split('\n')
  const perSite = lines.filter((line) => line.startsWith('[INDEXED-ABSENCE] ') && line.includes('keyed-write'))
  // Before this change the function returned (and stopped printing) at the
  // FIRST refusing write -- exactly the "took four runs to learn two keyed
  // writes" defect this instrument fixes. Both sites must be listed in ONE run.
  assert.equal(perSite.length, 2, `expected two per-site lines, got:\n${result.stderr}`)
  // `poke`'s write is `target[ i ] = 1;` and `jab`'s is `target[ i ] = 2;` --
  // the printed site text does not carry the enclosing function's name, but
  // the two sites are on different source lines and each keeps its own value.
  assert.ok(perSite.some((line) => line.includes('= 1')))
  assert.ok(perSite.some((line) => line.includes('= 2')))
  assert.notEqual(
    perSite[0]?.match(/fixture\.ts:(\d+)/)?.[1],
    perSite[1]?.match(/fixture\.ts:(\d+)/)?.[1],
    'the two refusals must be attributed to two distinct sites'
  )
  const summary = lines.find((line) => line.startsWith('[INDEXED-ABSENCE-SUMMARY]'))
  assert.ok(summary, `expected a summary line, got:\n${result.stderr}`)
  assert.match(summary, /refused=2\b/)
  assert.match(summary, /clauses=keyed-write:2\b/)
  // Enumerating is observation only: the proof still refuses (the debug
  // output cannot be requested by changing the answer -- unlike
  // `GEA_INDEXED_ABSENCE_FORCE`, which does and is unsound by design).
  const stdout = JSON.parse(result.stdout)
  assert.equal(stdout.accepted, false)
})
