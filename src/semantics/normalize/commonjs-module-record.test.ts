import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { censusCommonJsModuleRecords } from './commonjs-module-record.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from './deferred-intrinsic-protocols.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { sourceValueSessionOf } from './flow/source-value-session.js'
import { sourceBindingValuesOf } from './flow/value-provenance.js'

const entry = (name: string) => resolve('test/fixtures/commonjs-module-record', name)
const inspect = (consumer: string, exported: string, extra: Record<string, string> = {}) => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const sources = new Map(
    Object.entries({
      'source-wrapper.d.ts': `export {}; declare global {
        var require: (name: string) => any; var module: { exports: any }; var exports: any;
      }`,
      'source-entry.ts': consumer,
      'source-lib.ts': `export {}; ${exported}`,
      ...extra
    }).map(([name, text]) => [entry(name), text])
  )
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, language, ...rest) => {
    const text = sources.get(resolve(name))
    return text === undefined ? read(name, language, ...rest) : ts.createSourceFile(name, text, language, true)
  }
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  const files = [...sources.keys()].map((name) => program.getSourceFile(name)!)
  const flow = indexValueFlow(checker, files, wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const globals = new Map(
    (['require', 'module', 'exports'] as const).map((global) => [
      global,
      { global, declarationName: global, declarationFileName: entry('source-wrapper.d.ts') }
    ])
  )
  const records = censusCommonJsModuleRecords(
    checker,
    program.getSourceFiles(),
    globals,
    (specifier, containing) => resolve(containing, '..', `${specifier}.ts`),
    (name) => program.getSourceFile(name) ?? null,
    flow
  )
  const file = program.getSourceFile(entry('source-lib.ts'))!
  return { checker, file, flow, ledger, program, records }
}

test('one fixed CommonJS record preserves its actual class and Function fields through the shared source closure', () => {
  const checked = inspect(
    `const lib = require('./source-lib'); lib.load(); lib.loader.get();`,
    `function load() { return 1 } class Loader { get() { return 1 } }
     module.exports = { load, loader: new Loader() };`
  )
  const exported = checked.records.exportExpressionOf(checked.file)
  assert.ok(exported && ts.isObjectLiteralExpression(exported))
  const source = checked.program.getSourceFile(entry('source-entry.ts'))!
  const call = source.statements[0]!
  assert.ok(ts.isVariableStatement(call))
  const binding = call.declarationList.declarations[0]!
  assert.equal(checked.ledger.capture(() => sourceBindingValuesOf(checked.checker, checked.flow, binding)).value?.length, 1)
  const roots = checked.ledger.capture(() => sourceValueSessionOf(checked.checker, checked.flow).closedValuesOf(binding.initializer!)).value
  assert.equal(roots?.length, 1)
  assert.equal(roots?.[0] === exported, true)
})

test('opaque owner or field publication cannot borrow fixed native CommonJS record admission', () => {
  for (const consumer of [
    `declare function publish(value: unknown): void; const lib = require('./source-lib'); publish(lib);`,
    `declare function publish(value: unknown): void; const lib = require('./source-lib'); publish(lib.loader);`
  ]) {
    const checked = inspect(consumer, `class Loader { get() { return 1 } } module.exports = { loader: new Loader() };`)
    assert.equal(checked.records.exportExpressionOf(checked.file), null)
  }
})

test('alternate writers, descriptor literals and early cycles retain the existing CommonJS refusal', () => {
  for (const exported of [
    `module.exports = { value: 1 }; module.exports = { value: 2 };`,
    `module.exports = { value: 1 }; module.exports.value = 2;`,
    `module.exports = { get value() { return 1 } };`,
    `declare const incoming: any; module.exports = { value: incoming };`,
    `const before = module.exports; module.exports = { value: 1 };`
  ]) {
    const checked = inspect(`const lib = require('./source-lib'); void lib.value;`, exported)
    assert.equal(checked.records.exportExpressionOf(checked.file), null, exported)
  }
  const cycle = inspect(
    `const lib = require('./source-lib'); void lib.value;`,
    `require('./source-cycle'); module.exports = { value: 1 };`,
    { 'source-cycle.ts': `export {}; require('./source-lib');` }
  )
  assert.equal(cycle.records.exportExpressionOf(cycle.file), null)
})

test('an unproved Script realm receives no CommonJS lexical binding permission', () => {
  for (const annotation of ['', 'type WrapperType = typeof require;']) {
    const checked = inspect(`${annotation} var saved = { value: 1 }; void saved.value;`, `module.exports = { value: 1 };`)
    const file = checked.program.getSourceFile(entry('source-entry.ts'))!
    const statement = file.statements.find(ts.isVariableStatement)!
    const declaration = statement.declarationList.declarations[0]!
    assert.equal(checked.ledger.capture(() => sourceBindingValuesOf(checked.checker, checked.flow, declaration)).value, null)
  }
})
