import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createDeferredIntrinsicProtocolLedger, failedIntrinsicProtocolRequirements } from './deferred-intrinsic-protocols.js'
import { createIdentityTable } from './identities.js'
import { indexValueFlow } from './flow/value-flow.js'
import { censusGlobalHostMutations } from './global-host-mutations.js'
import { censusUnresolvableNames } from './unresolvable-names.js'
import { wholeProgram } from './reachability.js'

const intact = (source: string, intrinsic: 'Array' | 'Object' | 'Map' | 'WeakMap' | 'Reflect', member?: string): boolean => {
  const entry = resolve('test/fixtures/deferred-intrinsic-protocols.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry)
      ? // The census reads an unplaced value as possibly the global object only
        // where the program put a global object into its data. Several sources
        // below reach a prototype through a receiver typed `any`
        // (`Object.getPrototypeOf([])`), which without that premise cannot be
        // one -- and then the mutation these cases exist to reject is not one.
        ts.createSourceFile(
          name,
          `export {};\nconst globalHolder: { escaped: unknown } = { escaped: null }; globalHolder.escaped = globalThis;\n${source}`,
          version,
          true
        )
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const identities = createIdentityTable(program, checker)
  const globalHostMutationTaint = censusGlobalHostMutations(
    checker,
    identities,
    [file],
    censusUnresolvableNames(checker, [file]),
    new Set(),
    indexValueFlow(checker, [file], wholeProgram)
  )
  return (
    failedIntrinsicProtocolRequirements(
      {
        checker,
        identities,
        globalHostMutationTaint,
        isStandardLibraryDeclaration: (declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
      },
      [{ intrinsic, ...(member === undefined ? {} : { member }), location: file }]
    ).length === 0
  )
}

test('only accepted inference captures retain protocol obligations and later scopes replace earlier rounds', () => {
  const ledger = createDeferredIntrinsicProtocolLedger()
  const location = ts.createSourceFile('input.ts', '0', ts.ScriptTarget.ES2022, true)
  assert.equal(ledger.require('Array', location), false)
  assert.equal(
    ledger.guard(() => ledger.require('Array', location), Boolean),
    false
  )
  const attempt = ledger.capture(() => {
    ledger.guard(() => {
      ledger.require('Map', location)
      return false
    }, Boolean)
    ledger.guard(() => ledger.require('Array', location), Boolean)
    ledger.require('Array', location)
    return true
  })
  assert.deepEqual(
    attempt.requirements.map((item) => item.intrinsic),
    ['Array']
  )
  assert.deepEqual(ledger.requirements(), [])
  ledger.replace('parameters', attempt.requirements)
  assert.equal(ledger.requirements().length, 1)
  ledger.replace('parameters', [])
  assert.deepEqual(ledger.requirements(), [])
  assert.throws(() =>
    ledger.capture(() => {
      ledger.require('Object', location)
      throw new Error('failed candidate')
    })
  )
  assert.equal(ledger.require('Array', location), false)
})

test('final mutation census preserves closed intrinsic operations but rejects direct and indirect prototype mutations', () => {
  assert.equal(intact('const a = []; a.push(1); const b = a.slice(0); b[0] = 2;', 'Array'), true)
  assert.equal(intact('const value = {}; value.target = 1; delete value.target;', 'Object'), true)
  assert.equal(
    intact('declare function external(value: unknown): void; function forward(value) { external(value) }; forward(1);', 'Array'),
    true
  )
  for (const source of [
    'Array.prototype.slice = function () { return [] };',
    'Array = function () { return [] } as any;',
    'globalThis.Array = function () { return [] } as any;',
    'const sibling = []; const Constructor = sibling.constructor; Object.defineProperty(Constructor, Symbol.species, {value: function(){return []}});',
    'const sibling = []; const Constructor = sibling.constructor; Object.defineProperty(Constructor.prototype, "slice", {value: function(){return []}});',
    'declare function external(value: unknown): void; function expose(Array: unknown) { external([]) }; expose(null);',
    'const prototype = Array.prototype; prototype.slice = function () { return [] };',
    'Object.defineProperty(Object.getPrototypeOf([]), "slice", {value: () => []});',
    'Reflect.defineProperty(Reflect.getPrototypeOf([]), "slice", {value: () => []});',
    'Object.defineProperty(Array, Symbol.species, {value: function(){return []}});',
    'const Constructor = Array; Object.defineProperty(Constructor, Symbol.species, {value: function(){return []}});',
    'const {Array: Constructor} = globalThis; Object.defineProperty(Constructor, Symbol.species, {value: function(){return []}});',
    'declare function external(value: unknown): void; external(Array);',
    'declare function external(value: unknown): void; external(Object.getPrototypeOf([]));'
  ])
    assert.equal(intact(source, 'Array'), false, source)
  for (const source of [
    'Object.defineProperty(Object.getPrototypeOf({}), "target", {set(value) {}});',
    'Reflect.defineProperty(Reflect.getPrototypeOf({}), "target", {set(value) {}});',
    'declare function external(value: unknown): void; external(Reflect.getPrototypeOf({}));'
  ])
    assert.equal(intact(source, 'Object'), false, source)
})

test('authenticated prototype receivers retain identity despite open library prototype types', () => {
  for (const source of [
    'Object.prototype.toString.call([]);',
    'Object.prototype.toString.call(/x/);',
    'const Constructor = Object; Constructor.prototype.toString.call([]);',
    'const prototype: Object = Object.prototype; prototype.toString.call([]);',
    'Date.prototype.getTime.call(new Date());'
  ])
    assert.equal(intact(source, 'Object'), true, source)
  for (const source of [
    'declare function external(value: unknown): string; Object.prototype.toString = external; Object.prototype.toString.call([]);',
    'declare function external(value: unknown): string; Function.prototype.call = external as any; Object.prototype.toString.call([]);'
  ])
    assert.equal(intact(source, 'Array'), false, source)
})

test('opaque sibling native instances expose inherited prototypes through aliases, containers, fields and call frames', () => {
  for (const [intrinsic, value] of [
    ['Array', '[]'],
    ['Map', 'new Map()'],
    ['WeakMap', 'new WeakMap()']
  ] as const) {
    for (const body of [
      `const sibling = ${value}; external(sibling);`,
      `const sibling = ${value}; const holder = {nested:{sibling}}; external(holder);`,
      `function make() { return ${value} }; external(make());`,
      `function forward(value: unknown) { external(value) }; forward(${value});`,
      `class Holder { field = ${value} }; external(new Holder());`
    ])
      assert.equal(intact(`declare function external(value: unknown): void; ${body}`, intrinsic), false, body)
  }
  assert.equal(intact('declare function external(value: unknown): void; external(JSON.parse("[]"));', 'Array'), false)
  assert.equal(
    intact('declare function host(): number[]; declare function external(value: unknown): void; external(host());', 'Array'),
    false
  )
  assert.equal(intact('declare function external(value: unknown): void; external(1);', 'Object'), false)
})

test('opaque source callable and object consumers can reach actual returned and overwritten native values', () => {
  for (const body of [
    'function make() {return []}; external(make);',
    'const make = () => []; external(make);',
    'class Holder { make() { return [] } }; external(new Holder());',
    'class Holder { field = 1; constructor() { (this as any).field = [] } }; external(new Holder());',
    'class Holder { field = 1; constructor() { this.field = [] as any } }; external(new Holder());',
    'class Holder { field = 1 }; const held = new Holder(); (held as any).field = []; external(held);'
  ])
    assert.equal(intact(`declare function external(value: unknown): void; ${body}`, 'Array'), false, body)
})

test('native collection entries are reachable contents without becoming own properties', () => {
  for (const body of [
    'const values = new Map(); values.set(1, []); external(values);',
    'const values = new Map(); values.set([], 1); external(values);',
    'const values = new WeakMap(); values.set({}, []); external(values);',
    'class Holder { values = new Map(); constructor() { this.values.set(1, []) } }; external(new Holder());',
    'declare function host(): Map<number, number[]>; external(host());'
  ])
    assert.equal(intact(`declare function external(value: unknown): void; ${body}`, 'Array'), false, body)
  assert.equal(intact('const values = new Map(); values.set(1, []); Object.assign(globalThis, values);', 'Array'), true)
})

test('opaque reachability retains prototypes through copies without treating inherited members as copied own properties', () => {
  for (const body of [
    'const copy = Object.assign({}, {values: []}); external(copy);',
    'const copy = {...{values: []}}; external(copy);',
    'const copy = Object.assign({}, {make: () => []}); external(copy);',
    'const values = new Map(); values.set(1, []); const holder = {values}; external(holder);'
  ])
    assert.equal(intact(`declare function external(value: unknown): void; ${body}`, 'Array'), false, body)
  for (const body of [
    'Object.assign(globalThis, []);',
    'const values = new Map(); values.set(1, []); Object.assign(globalThis, {...values});'
  ])
    assert.equal(intact(body, 'Array'), true, body)
  assert.equal(
    intact('declare function external(value: unknown): void; external({});', 'Object', 'defineProperty'),
    false,
    'opaque code can replace a static member through value.constructor'
  )
  assert.equal(intact('Object.assign(globalThis, {});', 'Object', 'defineProperty'), true)
})

test('solved bulk keys preserve empty copies and revoke trust for source fields and unknown descriptors', () => {
  assert.equal(intact('const values = new Map(); values.set(1, []); Object.assign(Array.prototype, values);', 'Array'), true)
  for (const source of [
    'class Patch { slice = () => [] }; Object.assign(Array.prototype, new Patch());',
    'const patch = {slice: () => []}; Object.assign(Array.prototype, {...patch});',
    'declare const descriptors: PropertyDescriptorMap; Object.defineProperties(Object, descriptors);',
    'class Patch { [Symbol.iterator] = () => [] }; Object.assign(Array.prototype, new Patch());'
  ])
    assert.equal(intact(source, source.includes('descriptors') ? 'Object' : 'Array'), false, source)
})

test('static member obligations authenticate their own identities independently from prototypes', () => {
  assert.equal(intact('', 'Object', 'defineProperty'), true)
  assert.equal(intact('', 'Reflect', 'defineProperty'), true)
  for (const source of [
    'Object.defineProperty = (() => ({})) as any;',
    'const object = Object; object.defineProperty = (() => ({})) as any;',
    'Reflect.defineProperty(Object, "defineProperty", {value: () => ({})});'
  ])
    assert.equal(intact(source, 'Object', 'defineProperty'), false, source)
  assert.equal(intact('Reflect.defineProperty = (() => true) as any;', 'Reflect', 'defineProperty'), false)
  assert.equal(intact('const Object = {defineProperty(){}};', 'Object', 'defineProperty'), false)
  const ledger = createDeferredIntrinsicProtocolLedger()
  const location = ts.createSourceFile('input.ts', '', ts.ScriptTarget.ES2022, true)
  const attempt = ledger.capture(() => {
    ledger.require('Object', location)
    ledger.requireMember('Object', 'defineProperty', location)
    ledger.requireMember('Object', 'defineProperty', location)
    ledger.requireMember('Reflect', 'defineProperty', location)
  })
  assert.equal(attempt.requirements.length, 3)
  assert.equal(ledger.requireMember('Object', 'defineProperty', location), false)
})
