import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope } from './flow/targets.js'
import { createDeferredIntrinsicProtocolLedger, failedIntrinsicProtocolRequirements } from './deferred-intrinsic-protocols.js'

const intact = (source: string, intrinsic: 'Object' | 'Function', prototypeMember: string, key: string): boolean => {
  const entry = resolve('test/fixtures/intrinsic-callable-own-protocol.js')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, allowJs: true, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  const identities = createIdentityTable(program, checker)
  const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow)
  const ledger = createDeferredIntrinsicProtocolLedger()
  const proof = ledger.capture(() =>
    ledger.include([{ intrinsic, callableOwnKeys: { prototypeMember, keys: { names: [key] } }, location: file }])
  )
  return (
    failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint: taint,
        isStandardLibraryDeclaration: (one) => program.isSourceFileDefaultLibrary(one.getSourceFile())
      },
      proof.requirements
    ).length === 0
  )
}

test('primordial Function own forwarding slots are separate from inherited call and bind', () => {
  assert.equal(intact('', 'Object', 'hasOwnProperty', 'call'), true)
  assert.equal(intact('', 'Function', 'call', 'bind'), true)
  assert.equal(intact('Object.prototype.hasOwnProperty.call = () => false', 'Object', 'hasOwnProperty', 'call'), false)
  assert.equal(intact('Function.prototype.call.bind = () => () => false', 'Function', 'call', 'bind'), false)
})

test('aliased and reflected primordial own writes retain their exact Function identity', () => {
  for (const effect of [
    'const method = Object.prototype.hasOwnProperty; method.call = () => false',
    'const method = Object.prototype.hasOwnProperty; Reflect.defineProperty(method, "call", {value: () => false})',
    'const method = Function.prototype.call; method.bind = () => () => false'
  ])
    assert.equal(
      intact(
        effect,
        effect.includes('Function.prototype') ? 'Function' : 'Object',
        effect.includes('Function.prototype') ? 'call' : 'hasOwnProperty',
        effect.includes('Function.prototype') ? 'bind' : 'call'
      ),
      false,
      effect
    )
})

test('an unrelated Function own key does not replace its forwarding lookup', () => {
  assert.equal(intact('Object.prototype.hasOwnProperty.label = 1', 'Object', 'hasOwnProperty', 'call'), true)
  assert.equal(intact('const method = Function.prototype.call; method.label = 1', 'Function', 'call', 'bind'), true)
})

test('opaque publication cannot retain a primordial own-slot receipt', () => {
  assert.equal(
    intact('const method = Object.prototype.hasOwnProperty; globalThis.publish(method)', 'Object', 'hasOwnProperty', 'call'),
    false
  )
})
