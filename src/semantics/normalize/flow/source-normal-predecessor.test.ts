import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { indexValueFlow } from './value-flow.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { sourceEffectCannotPrecedeNormalBoundaryOf } from './source-normal-predecessor.js'

const inspect = (source: string, forged = false): boolean => {
  const entry = resolve('test/fixtures/source-normal-predecessor.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const effect = flow.calls.find((site) => site.call.expression.getText() === 'touch')!.call
  const boundary = flow.allWrites.find((write) => write.propertyAccess?.getText() === 'obj.name')!.site
  return ledger.capture(() =>
    sourceEffectCannotPrecedeNormalBoundaryOf(flow, sourceValueSessionOf(checker, flow), forged ? { ...effect } : effect, boundary)
  ).value
}

const setup = `
  declare function touch(): unknown
  function attempt(obj: { name: unknown }) { obj.name = 7 }
`

test('an uncaught throw excludes its effects through every closed repeated synchronous caller', () => {
  assert.equal(
    inspect(`${setup}
      class Problem { constructor(message: unknown) {} }
      function fail(message: unknown) { throw new Problem(touch()) }
      const checks = { ok(condition: boolean, message: unknown) { if (!condition) fail(message) } }
      checks.ok(true, 'first')
      checks.ok(true, 'second')
      attempt(Date.prototype.getTime)
    `),
    true
  )
})

test('a caught effect can mutate state and resume before the normal boundary', () => {
  assert.equal(
    inspect(`${setup}
      function fail() { throw touch() }
      function run() {
        try { fail() } catch {}
        attempt(Date.prototype.getTime)
      }
      run()
    `),
    false
  )
})

test('finally execution cannot borrow an uncaught predecessor exclusion', () => {
  assert.equal(
    inspect(`${setup}
      function fail() { throw touch() }
      function run() { try { fail() } finally { attempt(Date.prototype.getTime) } }
      run()
    `),
    false
  )
})

test('async and generator errors do not abort their callers synchronously', () => {
  for (const declaration of ['async function fail()', 'function* fail()'])
    assert.equal(inspect(`${setup} ${declaration} { throw touch() } fail(); attempt(Date.prototype.getTime)`), false, declaration)
})

test('opaque publication and recursive caller routes retain their effect obligations', () => {
  for (const [declaration, use] of [
    ['function fail() { throw touch() }', 'declare function retain(value: unknown): void; retain(fail); fail()'],
    ['function fail(again: boolean) { if (again) fail(false); throw touch() }', 'fail(true)']
  ])
    assert.equal(
      inspect(`${setup}
        ${declaration}
        ${use}
        attempt(Date.prototype.getTime)
      `),
      false,
      use
    )
})

test('a cloned source expression cannot supply the indexed abrupt effect witness', () => {
  const source = `${setup} function fail() { throw touch() } fail(); attempt(Date.prototype.getTime)`
  assert.equal(inspect(source), true)
  assert.equal(inspect(source, true), false)
})

test('an asserted never signature cannot replace an actual abrupt source completion', () => {
  assert.equal(
    inspect(`${setup}
      declare function stop(): never
      function fail() { stop(); touch() }
      fail()
      attempt(Date.prototype.getTime)
    `),
    false
  )
})
