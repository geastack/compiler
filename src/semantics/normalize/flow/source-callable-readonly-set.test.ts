import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from '../identities.js'
import { censusParameterBindings } from '../parameter-bindings.js'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { HostMutationTaint } from '../host-mutation-keys.js'
import { indexValueFlow } from './value-flow.js'
import { sourceCallableReadonlySetOf } from './source-callable-readonly-set.js'

const inspect = (source: string) => {
  const entry = resolve('test/fixtures/source-callable-readonly-set.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: false, types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, `export {};\n${source}`, version, true) : read(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const identities = createIdentityTable(program, checker)
  const parameters = censusParameterBindings(checker, [file], wholeProgram, undefined, undefined, flow)
  const taint = new HostMutationTaint()
  const context = {
    checker,
    identities,
    globalHostMutationTaint: taint,
    isStandardLibraryDeclaration: (one: ts.Declaration) => program.isSourceFileDefaultLibrary(one.getSourceFile())
  }
  const accesses = flow.propertyAccesses.filter((one) => one.getText(file) === 'obj[key]')
  assert.equal(accesses.length, 1)
  const access = accesses[0]!
  return {
    context,
    flow,
    file,
    ledger,
    parameters,
    taint,
    proof: () => ledger.capture(() => sourceCallableReadonlySetOf(access, flow, context)).value
  }
}

test('actual closed parameter sources identify the stock readonly key before later deletion', () => {
  const checked = inspect(`
    function attempt(obj, key) { obj[key] = 7 }
    const original = Date.prototype.getTime
    attempt(original, 'name')
    delete original.name
  `)
  const proof = checked.proof()
  assert.ok(proof)
  assert.deepEqual(proof.keys, ['name'])
  assert.deepEqual(
    proof.sources.map((one) => one.member),
    ['getTime']
  )
  assert.equal(proof.entries.length, 1)
})

test('stated key parameters retain their actual source frame without an inferred storage override', () => {
  const checked = inspect(`
    function attempt(obj, key: 'name' | 'length') { obj[key] = 7 }
    attempt(Date.prototype.getTime, 'name')
  `)
  const parameter = checked.file.statements.find(ts.isFunctionDeclaration)!.parameters[1]!
  assert.equal(checked.parameters.argumentsAt?.(parameter), null)
  const proof = checked.proof()
  assert.ok(proof)
  assert.deepEqual(proof.keys, ['name'])
  assert.deepEqual(
    proof.sources.map((one) => one.member),
    ['getTime']
  )
})

test('a source helper entry orders later destructive work after the rejected write', () => {
  const checked = inspect(`
    function attempt(obj, key) { obj[key] = 7 }
    function verify(obj, key) {
      attempt(obj, key)
      Reflect.deleteProperty(obj, key)
      Object.defineProperty(obj, key, { value: 'restored', writable: false })
    }
    verify(Date.prototype.getTime, 'name')
  `)
  assert.equal(checked.proof() !== null, true)
})

test('only complete unentered wrappers are omitted from the stock descriptor execution path', () => {
  const source = `
    function attempt(obj, key: string | symbol) { obj[key] = 7 }
    function unused() { attempt(() => 7, Symbol()) }
    function verify(obj, key) {
      attempt(obj, key)
      Reflect.deleteProperty(obj, key)
    }
    verify(Date.prototype.getTime, 'name')
  `
  const proof = inspect(source).proof()
  assert.ok(proof)
  assert.deepEqual(proof.keys, ['name'])
  assert.deepEqual(
    proof.sources.map((one) => one.member),
    ['getTime']
  )
  assert.deepEqual(
    proof.entries.map((one) => one.getText()),
    ['attempt(obj, key)', "verify(Date.prototype.getTime, 'name')"]
  )
  for (const continuation of [
    'unused()',
    'declare function publish(value: unknown): void; publish(unused)',
    "verify(Date.prototype.getTime, 'name')"
  ])
    assert.equal(inspect(source + continuation).proof(), null, continuation)
})

test('uncaught error construction in repeated assertion helpers cannot precede a normal readonly Set', () => {
  const checked = inspect(`
    class Problem { constructor(message: unknown) {} }
    function fail(message: unknown) { throw new Problem(message) }
    const checks = { ok(condition, message) { if (!condition) fail(message) } }
    function attempt(obj, key) { obj[key] = 7 }
    function verify(obj, key) {
      checks.ok(true, 'first')
      checks.ok(true, 'second')
      attempt(obj, key)
    }
    verify(Date.prototype.getTime, 'name')
  `)
  assert.equal(checked.proof() !== null, true)
})

test('caught and finally-resumed descriptor mutations remain readonly predecessor obligations', () => {
  for (const continuation of ['try { fail() } catch {}', 'function recover() { try { fail() } finally { return } } recover()']) {
    const checked = inspect(`
      const original = Date.prototype.getTime
      function fail() { Object.defineProperty(original, 'name', { value: 9, writable: true }); throw 1 }
      function attempt(obj, key) { obj[key] = 7 }
      ${continuation}
      attempt(original, 'name')
    `)
    assert.equal(checked.proof(), null, continuation)
  }
})

test('an ungrounded recursive wrapper does not become an unentered execution receipt', () => {
  const checked = inspect(`
    function attempt(obj, key) { obj[key] = 7 }
    function cycle() { cycle(); attempt(Date.prototype.getTime, 'name') }
    attempt(Date.prototype.getTime, 'name')
  `)
  assert.equal(checked.proof(), null)
})

test('prior deletion, redefinition and an opaque consumer revoke readonly state', () => {
  for (const before of [
    'delete original.name',
    "Object.defineProperty(original, 'name', { value: 9, writable: true })",
    "Reflect.deleteProperty(original, 'name')",
    'opaque(original)'
  ]) {
    const checked = inspect(`
      declare function opaque(value: unknown): void
      function attempt(obj, key) { obj[key] = 7 }
      const original = Date.prototype.getTime
      ${before}
      attempt(original, 'name')
    `)
    assert.equal(checked.proof(), null, before)
  }
})

test('repeated entries and loops cannot borrow a first-entry descriptor state', () => {
  for (const uses of ["attempt(original, 'name'); attempt(original, 'name')", "for (let i = 0; i < 2; ++i) attempt(original, 'name')"]) {
    const checked = inspect(`
      function attempt(obj, key) { obj[key] = 7 }
      const original = Date.prototype.getTime
      ${uses}
    `)
    assert.equal(checked.proof(), null)
  }
})

test('asserted key types and same-signature source functions cannot impersonate stock facts', () => {
  for (const input of [
    "attempt(Date.prototype.getTime, 'other' as 'name')",
    "attempt(() => 7, 'name')",
    "declare const unknownOwner: typeof Date.prototype.getTime; attempt(unknownOwner, 'name')"
  ]) {
    const checked = inspect(`function attempt(obj, key) { obj[key] = 7 } ${input}`)
    assert.equal(checked.proof(), null)
  }
})

test('a reassigned formal cannot reuse its original source argument', () => {
  const checked = inspect(`
    function attempt(obj, key) {
      obj = () => 7
      obj[key] = 7
    }
    attempt(Date.prototype.getTime, 'name')
  `)
  assert.equal(checked.proof(), null)
})

test('descriptor effects in the RHS happen before the actual Set boundary', () => {
  const checked = inspect(`
    function mutate(value) { Object.defineProperty(value, 'name', { value: 'changed', writable: true }); return 7 }
    function attempt(obj, key) { obj[key] = mutate(obj) }
    attempt(Date.prototype.getTime, 'name')
  `)
  assert.equal(checked.proof(), null)
})

test('a descriptor mutation through an ordinary holder alias remains an obligation', () => {
  const checked = inspect(`
    function attempt(obj, key) { obj[key] = 7 }
    const original = Date.prototype.getTime
    const holder = { method: original }
    Object.defineProperty(holder.method, 'name', { value: 'changed', writable: true })
    attempt(original, 'name')
  `)
  assert.equal(checked.proof(), null)
})

test('final intrinsic identity taint revokes an otherwise closed source entry', () => {
  const checked = inspect(`function attempt(obj, key) { obj[key] = 7 } attempt(Date.prototype.getTime, 'name')`)
  const symbol = checked.context.checker.resolveName('Date', checked.file, ts.SymbolFlags.Value, false)!
  const constructor = checked.context.identities.symbolValueDeclarationId(symbol, checked.file)!
  checked.taint.taintObject(constructor, { kind: 'name', name: 'prototype' })
  assert.equal(checked.proof(), null)
})
