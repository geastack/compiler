import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createCensusComputedKeysOf } from './host-mutation-computed-keys.js'
import { closedCallableAuthorityOf } from './flow/callable-reach.js'
import { indexValueFlow } from './flow/value-flow.js'
import { wholeProgram } from './reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'

const keys = (source: string): readonly string[] | null => {
  const entry = resolve('test/fixtures/host-mutation-executing-keys.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, `export {}; ${source}`, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachDeferredIntrinsicProtocolLedger(flow, createDeferredIntrinsicProtocolLedger())
  const query = createCensusComputedKeysOf(
    checker,
    flow,
    closedCallableAuthorityOf(
      checker,
      flow,
      (value) => checker.getTypeAtLocation(value),
      () => undefined
    )
  )
  const access = flow.propertyAccesses.find((one) => ts.isElementAccessExpression(one) && one.argumentExpression.getText() === 'key')
  assert.ok(access && ts.isElementAccessExpression(access))
  const result = query(access.argumentExpression)
  return result === null ? null : [...result.keys].sort()
}

const store = 'const owner = {}; function store(key: string | symbol) { owner[key] = 1 }'

test('stated public keys retain the exact complete executing sources', () => {
  assert.deepEqual(keys(`${store}; store('kept')`), ['kept'])
  const wrapper = `${store}; function unused() { store('absent') }; store('kept')`
  assert.deepEqual(keys(wrapper), ['kept'])
  assert.deepEqual(keys(wrapper + '; unused()'), ['absent', 'kept'])
  assert.deepEqual(keys(`${store}; store('first'); store('second')`), ['first', 'second'])
})

test('open, exported and rebound key sources cannot borrow an observed literal', () => {
  for (const effect of [
    'declare var unknown: any; store(unknown)',
    'store(Symbol())',
    'export function exposed(key: string) { store(key) }',
    'declare var unknown: any; function wrapper(key: string) { key = unknown; store(key) }; wrapper("kept")',
    'declare var unknown: string[]; for (const key of unknown) store(key)'
  ])
    assert.equal(keys(`${store}; store('kept'); ${effect}`), null, effect)
})
