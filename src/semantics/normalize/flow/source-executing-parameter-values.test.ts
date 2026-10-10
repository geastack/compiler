import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { sourceExecutingParameterValuesOf } from './source-executing-parameter-values.js'
import { sourceBindingValuesOf, valueLeavesOf } from './value-provenance.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-executing-parameter-values.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
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
  const body = file.statements.find((one): one is ts.FunctionDeclaration => ts.isFunctionDeclaration(one) && one.name?.text === 'sink')!
  const parameter = body.parameters[0]!
  const expression = (body.body!.statements[0] as ts.ReturnStatement).expression!
  return {
    raw: () => ledger.capture(() => sourceExecutingParameterValuesOf(checker, flow, parameter)).value,
    leaves: () =>
      ledger.capture(() =>
        valueLeavesOf(flow, expression, {
          parameterValuesOf: (one) => sourceExecutingParameterValuesOf(checker, flow, one),
          bindingValuesOf: (one) => sourceBindingValuesOf(checker, flow, one)
        })
      ).value
  }
}

test('only a completely unentered wrapper is absent from actual parameter inputs', () => {
  const source = `function sink(value) { return value }
    function unused() { sink('unentered') }
    sink(1)`
  assert.deepEqual(
    inspect(source)
      .leaves()
      ?.map((one) => one.getText()),
    ['1']
  )
  assert.deepEqual(
    new Set(
      inspect(source + '; unused()')
        .leaves()
        ?.map((one) => one.getText())
    ),
    new Set(['1', "'unentered'"])
  )
})

test('repeated executing forwarding callers retain every actual argument', () => {
  const checked = inspect(`function sink(value) { return value }
    function forward(value) { sink(value) }
    forward(1); forward(2)`)
  assert.deepEqual(new Set(checked.leaves()?.map((one) => one.getText())), new Set(['1', '2']))
})

test('opaque and exported wrapper callers cannot prove a missing execution path', () => {
  for (const exposure of ['export { unused }', 'declare function expose(value: unknown): void; expose(unused)']) {
    const checked = inspect(`function sink(value) { return value }
      function unused() { sink('possible') }
      sink(1); ${exposure}`)
    assert.equal(checked.raw(), null, exposure)
  }
})

test('recursive wrapper execution is not an unentered witness', () => {
  const checked = inspect(`function sink(value) { return value }
    function recursive(value) { sink(value); recursive(value) }`)
  assert.equal(checked.raw(), null)
})

test('parameter writes and omitted actual arguments keep their unsupported frames open', () => {
  for (const source of [
    'function sink(value) { return value } sink()',
    'function sink(value) { return value; value = 2 } sink(1)',
    'function sink(value = 2) { return value } sink(1)'
  ])
    assert.equal(inspect(source).raw(), null, source)
})
