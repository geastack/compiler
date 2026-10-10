import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements,
  type IntrinsicProtocolRequirement
} from '../deferred-intrinsic-protocols.js'
import { censusGlobalHostMutations } from '../global-host-mutations.js'
import { createIdentityTable } from '../identities.js'
import { wholeProgram } from '../reachability.js'
import { censusUnresolvableNames } from '../unresolvable-names.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { attachClosedScriptScope } from './targets.js'
import { indexValueFlow } from './value-flow.js'
import { localBindingValuesOf, sourceBindingValuesOf } from './value-provenance.js'

const inspect = (source: string, closed = true, attachLedger = true) => {
  const entry = resolve('test/fixtures/source-global-binding.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  if (closed) attachClosedScriptScope(flow, { files: new Set([file]) })
  const ledger = createDeferredIntrinsicProtocolLedger()
  if (attachLedger) attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const declarations: ts.VariableDeclaration[] = []
  const identifiers: ts.Identifier[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'saved') declarations.push(node)
    if (ts.isIdentifier(node) && node.text === 'saved') identifiers.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const declaration = declarations[0]!
  assert.ok(declaration)
  const values = () => ledger.capture(() => sourceBindingValuesOf(checker, flow, declaration))
  const failed = (requirements: readonly IntrinsicProtocolRequirement[]) => {
    const identities = createIdentityTable(program, checker)
    const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow)
    return failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint: taint,
        isStandardLibraryDeclaration: (node) => program.isSourceFileDefaultLibrary(node.getSourceFile())
      },
      requirements
    )
  }
  const target = () => {
    const marker = file.text.indexOf('/* target */')
    assert.notEqual(marker, -1)
    const found = identifiers.find((node) => node.getStart(file) > marker)
    assert.ok(found)
    return found
  }
  return { checker, declaration, failed, file, flow, ledger, target, values }
}

test('a captured Script var retains its exact source initializer and global integrity obligation', () => {
  const checked = inspect('var saved = Date.prototype.getTime; void saved;')
  assert.equal(localBindingValuesOf(checked.flow, checked.declaration), null)
  const proof = checked.values()
  assert.deepEqual(proof.value, [checked.declaration.initializer])
  assert.equal(proof.requirements.length, 1)
  assert.equal(proof.requirements[0]!.sourceGlobalBinding, checked.declaration)
  assert.equal(proof.requirements[0]!.location, checked.declaration)
  assert.deepEqual(checked.failed(proof.requirements), [])
})

test('a Script var cannot borrow an open realm or a missing ledger', () => {
  for (const [closed, attached] of [
    [false, true],
    [true, false]
  ] as const) {
    const checked = inspect('var saved = Date.prototype.getTime; void saved;', closed, attached)
    const proof = checked.values()
    assert.equal(proof.value, null)
    assert.deepEqual(proof.requirements, [])
  }
  const module = inspect('export {}; var saved = Date.prototype.getTime; void saved;', false)
  assert.deepEqual(module.values().value, [module.declaration.initializer])
  assert.deepEqual(module.values().requirements, [])
})

test('reassigned, repeated, ambient and iterative global cells retain no initializer-only permission', () => {
  for (const source of [
    'var saved = Date.prototype.getTime; saved = Date.prototype.getUTCFullYear;',
    'var saved = Date.prototype.getTime; saved ||= Date.prototype.getUTCFullYear;',
    'var saved = Date.prototype.getTime; declare const condition: boolean; if (condition) saved = Date.prototype.getUTCFullYear;',
    'var saved = Date.prototype.getTime; var saved = Date.prototype.getTime;',
    'declare var saved: unknown; void saved;',
    'for (var saved of [Date.prototype.getTime]) {} void saved;',
    'var saved; void saved;'
  ]) {
    const checked = inspect(source)
    const proof = checked.values()
    assert.equal(proof.value, null, source)
    assert.deepEqual(proof.requirements, [], source)
  }
})

test('the final shared census revokes wildcard and aliased global mutation permission', () => {
  for (const effect of [
    'declare const key: string; (globalThis as any)[key] = Date.prototype.getTime;',
    'declare const key: string; const realm = globalThis; (realm as any)[key] = Date.prototype.getTime;',
    'declare function publish(value: unknown): void; publish(globalThis);'
  ]) {
    const checked = inspect(`var saved = Date.prototype.getTime; void saved; ${effect}`)
    const proof = checked.values()
    assert.ok(proof.value, 'the preliminary receipt remains conditional on final mutation authority')
    assert.equal(checked.failed(proof.requirements).length, 1, effect)
  }
  for (const effect of [
    '(globalThis as any).saved = Date.prototype.getUTCFullYear;',
    'const realm = globalThis; (realm as any).saved = Date.prototype.getUTCFullYear;'
  ]) {
    const checked = inspect(`var saved = Date.prototype.getTime; void saved; ${effect}`)
    const proof = checked.values()
    assert.ok(proof.value === null || checked.failed(proof.requirements).length === 1, effect)
  }
})

test('binding integrity keeps source consumer closure separate and complete', () => {
  for (const effect of [
    '',
    'declare function publish(value: unknown): void; publish(saved);',
    'declare function publish(value: unknown): void; const alias = saved; publish(alias);'
  ]) {
    const checked = inspect(`var saved = {value: 1}; ${effect} /* target */ saved.value;`)
    assert.ok(checked.values().value)
    const proof = checked.ledger.capture(() => sourceValueSessionOf(checked.checker, checked.flow).closedValuesOf(checked.target()))
    if (effect === '') {
      assert.ok(proof.value && proof.value.length === 1 && ts.isObjectLiteralExpression(proof.value[0]!))
      assert.ok(proof.requirements.some((one) => one.sourceGlobalBinding === checked.declaration))
    } else assert.equal(proof.value, null, effect)
  }
})

test('a global receipt cannot be moved to a local, ambient or unrelated source location', () => {
  const checked = inspect('var saved = Date.prototype.getTime; void saved;')
  const proof = checked.values()
  assert.ok(proof.requirements[0])
  assert.equal(checked.failed([{ ...proof.requirements[0], location: checked.file }]).length, 1)
  const module = inspect('export {}; var saved = Date.prototype.getTime;')
  assert.equal(module.failed([{ intrinsic: 'Function', sourceGlobalBinding: module.declaration, location: module.declaration }]).length, 1)
  const ambient = inspect('declare var saved: unknown;')
  assert.equal(
    ambient.failed([{ intrinsic: 'Function', sourceGlobalBinding: ambient.declaration, location: ambient.declaration }]).length,
    1
  )
})
