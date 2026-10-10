import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../../compiler.js'
import { createIdentityTable } from './identities.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { censusProgram } from './census.js'
import { wholeProgram } from './reachability.js'
import { emptySpecializationCensus } from './specialization.js'
import { emptyNamespacePathCensus } from './namespace-paths.js'
import { installedGlobalPropertiesOf } from './installed-global-properties.js'

const declarations = 'class Native { value = 1 }\ndeclare var Installed: typeof Native;\n'

const proofOf = (source: string, closed = true, mutationClosed = true, provided: ReadonlySet<string> = new Set()) => {
  const entry = resolve('test/fixtures/installed-global-properties.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, target, onError, create) =>
    file === entry ? ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true) : getSourceFile(file, target, onError, create)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)
  assert.ok(file)
  const checker = program.getTypeChecker()
  const identities = createIdentityTable(program, checker)
  const names = censusUnresolvableNames(checker, [file], provided)
  const census = censusProgram([file], identities, wholeProgram, emptySpecializationCensus, emptyNamespacePathCensus)
  return installedGlobalPropertiesOf(checker, identities, [file], names, closed, mutationClosed, census.candidates)
}

test('one dominating native constructor installation owns one native global cell', () => {
  const proof = proofOf(`${declarations}globalThis.Installed = Native; const selected = globalThis.Installed; const same = Installed;`)
  assert.equal(proof.declarations.size, 1)
  assert.equal(proof.accesses.size, 2)
  assert.ok([...proof.accesses.values()].every((declaration) => proof.declarations.has(declaration)))
})

test('global escape, computed or descriptor observers and non-dominating installations keep the open surface', () => {
  for (const body of [
    'globalThis.Installed = Native; const root = globalThis; const selected = root.Installed;',
    'globalThis.Installed = Native; const selected = globalThis["Installed"];',
    'globalThis.Installed = Native; Object.getOwnPropertyDescriptor(globalThis, "Installed");',
    'if (Math.random()) globalThis.Installed = Native; const selected = globalThis.Installed;',
    'const selected = globalThis.Installed; globalThis.Installed = Native;',
    'const selected = Installed; globalThis.Installed = Native;',
    'globalThis.Installed = Native; function read() { return globalThis.Installed }',
    'globalThis.Installed = Native; globalThis.Installed = Native; const selected = globalThis.Installed;',
    'globalThis.Installed = Native; observe(); const selected = globalThis.Installed;',
    'globalThis.Installed = Native; Object.defineProperty(globalThis, "Installed", { value: Native });',
    'globalThis.Installed = Native; Installed++; const selected = globalThis.Installed;',
    'globalThis.Installed = Native; for (globalThis.Installed of [Native]) {} const selected = globalThis.Installed;',
    'globalThis.Installed = Native; [globalThis.Installed] = [Native]; const selected = globalThis.Installed;',
    'globalThis.Installed = Native; ({ value: globalThis.Installed } = { value: Native }); const selected = globalThis.Installed;'
  ]) {
    assert.equal(proofOf(`${declarations}${body}`).declarations.size, 0, body)
  }
})

test('host ownership and an open realm cannot acquire a program-owned native cell', () => {
  const source = `${declarations}globalThis.Installed = Native; const selected = globalThis.Installed;`
  assert.equal(proofOf(source, false).declarations.size, 0)
  assert.equal(proofOf(source, true, false).declarations.size, 0)
  assert.equal(proofOf(source, true, true, new Set(['Installed'])).declarations.size, 0)
  assert.equal(proofOf(`export {}; ${source}`).declarations.size, 0)
})

test('the installed nominal constructor is stored and read natively before dead nullish-arm lowering', () => {
  const entry = resolve('test/runtime/merge-arm-nullish-fallback-is-dead.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true
  })
  assert.equal(result.emissionRefusals.length, 0, JSON.stringify(result.emissionRefusals))
  assert.ok(result.source)
  assert.equal(result.source.includes('gea::Value::box'), false)
  assert.equal(result.source.includes('globalThis()->'), false)
})
