import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createIdentityTable } from './identities.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'
import { indexValueFlow } from './flow/value-flow.js'
import { attachClosedScriptScope, attachStatedModuleSet } from './flow/targets.js'
import { createDeferredIntrinsicProtocolLedger, failedIntrinsicProtocolRequirements } from './deferred-intrinsic-protocols.js'

const proxyBindingIntact = (source: string): boolean => {
  const entry = resolve('test/fixtures/standard-global-binding-protocol.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry ? ts.createSourceFile(name, source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, program.getSourceFiles(), wholeProgram)
  attachClosedScriptScope(flow, { files: new Set([file]) })
  attachStatedModuleSet(flow, { files: program.getSourceFiles(), entries: [file], reachable: wholeProgram })
  const identities = createIdentityTable(program, checker)
  const taint = censusGlobalHostMutations(checker, identities, [file], censusUnresolvableNames(checker, [file]), new Set(), flow)
  const ledger = createDeferredIntrinsicProtocolLedger()
  const proof = ledger.capture(() => ledger.requireStandardGlobalBinding('Proxy', file))
  assert.equal(proof.value, true)
  assert.equal(proof.requirements.length, 1)
  return failedIntrinsicProtocolRequirements({
    checker, identities, globalHostMutationTaint: taint,
    isStandardLibraryDeclaration: (one) => program.isSourceFileDefaultLibrary(one.getSourceFile())
  }, proof.requirements).length === 0
}

test('Proxy authenticates its standard binding without inventing a prototype', () => {
  assert.equal(Object.hasOwn(Proxy, 'prototype'), false)
  assert.equal(proxyBindingIntact('export {}'), true)
})

test('shadowed and replaced Proxy bindings cannot authenticate construction semantics', () => {
  assert.equal(proxyBindingIntact('export {}; declare const Proxy: any'), false)
  assert.equal(proxyBindingIntact('globalThis.Proxy = function () {} as any'), false)
  assert.equal(proxyBindingIntact('Reflect.set(globalThis, "Proxy", function () {})'), false)
})

test('a reflective receiver that may be the actual global object cannot retain its binding receipt', () => {
  assert.equal(proxyBindingIntact('declare const choose: boolean; const target = choose ? globalThis : {}; Reflect.set(target, "Proxy", function () {})'), false)
})

test('an ambient any target may alias the actual global object', () => {
  assert.equal(proxyBindingIntact('declare const target: any; Reflect.set(target, "Proxy", function () {})'), false)
})

test('an ambient any-return factory may return the actual global object', () => {
  assert.equal(proxyBindingIntact('declare function acquire(): any; Reflect.set(acquire(), "Proxy", function () {})'), false)
})

test('all reflected unknown surface writers preserve the external-alias refusal', () => {
  for (const write of [
    'Reflect.defineProperty(target, "Proxy", {value: function () {}})',
    'Object.defineProperty(target, "Proxy", {value: function () {}})',
    'Reflect.deleteProperty(target, "Proxy")',
    'Object.assign(target, {Proxy: function () {}})',
    'Object.defineProperties(target, {Proxy: {value: function () {}}})',
    'Object.setPrototypeOf(target, {})',
    'Reflect.setPrototypeOf(target, {})'
  ]) assert.equal(proxyBindingIntact(`declare const target: any; ${write}`), false, write)
})

test('reflected writes to a closed ordinary allocation do not replace the global binding', () => {
  assert.equal(proxyBindingIntact('const target = {}; Reflect.set(target, "Proxy", function () {})'), true)
  assert.equal(proxyBindingIntact('const target = {}; Object.defineProperty(target, "Proxy", {value: function () {}})'), true)
  assert.equal(proxyBindingIntact('const target = {}; Object.setPrototypeOf(target, null)'), true)
})

test('a real externally supplied reflective target can replace the global Proxy binding', () => {
  const original = globalThis.Proxy
  const replacement = function () { throw new Error('must not construct') } as unknown as ProxyConstructor
  const hostTarget = (): object => globalThis
  try {
    assert.equal(Reflect.set(hostTarget(), 'Proxy', replacement), true)
    assert.equal(globalThis.Proxy, replacement)
  } finally {
    globalThis.Proxy = original
  }
  assert.equal(globalThis.Proxy, original)
})

test('a source class annotation is not an ordinary protocol proof for a returned Proxy', () => {
  assert.equal(proxyBindingIntact(`
    class Claimed { value = 1 }
    declare function handlerFactory(): ProxyHandler<any>
    function acquire(): Claimed { return new Proxy(globalThis, handlerFactory()) as unknown as Claimed }
    Reflect.set(acquire(), 'Proxy', function () {})
  `), false)
})

test('a borrowed source method cannot authenticate a non-global reflective receiver', () => {
  assert.equal(proxyBindingIntact(`
    class Claimed { mutate() { Reflect.set(this, 'Proxy', function () {}) } }
    Claimed.prototype.mutate.call(globalThis)
  `), false)
})
