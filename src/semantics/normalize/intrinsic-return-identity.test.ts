import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import { intrinsicObjectReturnIdentityOf } from './intrinsic-return-identity.js'
import { attachClosedScriptScope } from './flow/targets.js'

const factsOf = (text: string) => {
  const entry = resolve('test/runtime/intrinsic-return-identity-input.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, strict: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, text, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  assert.equal(program.getSemanticDiagnostics(file).length, 0, 'the source fixture must typecheck')
  const identities = createIdentityTable(program, checker)
  const flow = indexValueFlow(checker, [file], wholeProgram)
  // This fixture is the complete one-file Script realm. Source replacement
  // and integrity-target allocation proofs still owe final binding integrity.
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow)
  const context = {
    checker,
    identities,
    globalHostMutationTaint: taint,
    isStandardLibraryDeclaration: (declaration: ts.Declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  }
  const facts = new Map<string, ReturnType<typeof intrinsicObjectReturnIdentityOf>>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer))
      facts.set(node.name.text, intrinsicObjectReturnIdentityOf(context, node.initializer, node.initializer.expression))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return facts
}

test('intact Object entries publish only their actual normal return identity', () => {
  const facts = factsOf(`
    function target() {}
    const frozen = Object.freeze(target)
    const sealed = Object.seal(target)
    const fixed = Object.preventExtensions(target)
    const assigned = Object.assign(target, {})
    const defined = Object.defineProperty(target, 'value', {value: 1})
    const definitions = Object.defineProperties(target, {value: {value: 1}})
    const boxed = Object.assign(1, {})
    declare const opaqueTarget: any
    const unknownTarget = Object.assign(opaqueTarget, {})
    const asserted = Object.assign(1 as unknown as object, {})
  `)
  for (const [name, kind] of [
    ['frozen', 'freeze'],
    ['sealed', 'seal'],
    ['fixed', 'preventExtensions']
  ] as const)
    assert.deepEqual(facts.get(name), { intrinsicReturnIdentity: 'argument0', intrinsicIntegrity: kind })
  for (const name of ['assigned', 'defined', 'definitions']) assert.deepEqual(facts.get(name), { intrinsicReturnIdentity: 'argument0' })
  for (const name of ['boxed', 'unknownTarget', 'asserted']) assert.equal(facts.get(name), null, name)
})

test('mutated members and shadowed owners cannot borrow standard return-identity facts', () => {
  const facts = factsOf(`
    function target() {}
    Object.freeze = (value: any) => value
    const changed = Object.freeze(target)
    const intact = Object.seal(target)
    {
      const Object = {freeze(value: unknown) {return value}}
      const shadowed = Object.freeze(target)
    }
  `)
  assert.equal(facts.get('changed'), null)
  assert.equal(facts.get('shadowed'), null)
  assert.deepEqual(facts.get('intact'), { intrinsicReturnIdentity: 'argument0', intrinsicIntegrity: 'seal' })
})

test('exact own literal calls keep their source effect after another intrinsic member is replaced', () => {
  for (const member of ['freeze', 'assign']) {
    const facts = factsOf(`
      function target() {}
      Object.${member} = (value: any) => value
      const changed = Object.${member}(target)
      {
        const Object = {freeze(value: unknown) {return value}}
        const shadowed = Object.freeze(target)
      }
      const intact = Object.seal(target)
    `)
    assert.equal(facts.get('changed'), null, member)
    assert.equal(facts.get('shadowed'), null, member)
    assert.deepEqual(facts.get('intact'), { intrinsicReturnIdentity: 'argument0', intrinsicIntegrity: 'seal' }, member)
  }
})

test('an own source method still publishes arguments to its actual opaque consumer', () => {
  const facts = factsOf(`
    declare function opaque(value: unknown): void
    function target() {}
    Object.freeze = (value: any) => value
    const changed = Object.freeze(target)
    const local = {freeze(value: unknown) {opaque(value); return value}}
    const shadowed = local.freeze(target)
    const intact = Object.seal(target)
  `)
  assert.equal(facts.get('changed'), null)
  assert.equal(facts.get('shadowed'), null)
  assert.equal(facts.get('intact'), null)
})

test('unproved replacements and opaque consumers still revoke unrelated intrinsic permission', () => {
  for (const replacement of [
    'declare const replacement: any; Object.freeze = replacement;',
    'declare function publish(value: any): void; Object.freeze = (value: any) => { publish(value); return value; };',
    'declare const condition: boolean; if (condition) Object.freeze = (value: any) => value;',
    "Object.freeze = (value: any) => value; declare const owner: any; owner['freeze'] = (value: any) => value;",
    "Object.freeze = (value: any) => value; (globalThis as any)['Object']['freeze'] = (value: any) => 0;",
    "Object.freeze = (value: any) => value; Reflect.set((globalThis as any)['Object'], 'freeze', (value: any) => 0);"
  ]) {
    const facts = factsOf(`function target() {} ${replacement} const changed = Object.freeze(target); const intact = Object.seal(target);`)
    assert.equal(facts.get('changed'), null, replacement)
    assert.equal(facts.get('intact'), null, replacement)
  }
})
