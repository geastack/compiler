import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { sourceDescriptorOwnProtocolOf, propertyDescriptorFieldNames } from './source-descriptor-protocol.js'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { createIdentityTable } from '../identities.js'
import { HostMutationTaint, namedKey } from '../host-mutation-keys.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements
} from '../deferred-intrinsic-protocols.js'

const inspect = (descriptor: string, source?: string) => {
  const entry = resolve('test/runtime/native-accessor-descriptor-functions.runtime.ts')
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, types: [] }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === entry
      ? ts.createSourceFile(
          name,
          source ??
            `export {}; function getter(): number { return 1; } const owner = {}; Object.defineProperty(owner, 'entry', ${descriptor});`,
          version,
          true
        )
      : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(entry)!
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const ledger = createDeferredIntrinsicProtocolLedger()
  attachDeferredIntrinsicProtocolLedger(flow, ledger)
  const definition = flow.calls
    .map((site) => site.call)
    .find(
      (call): call is ts.CallExpression =>
        ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'defineProperty'
    )!
  assert.ok(definition)
  const mutations = new HostMutationTaint()
  const context = {
    checker,
    identities: createIdentityTable(program, checker),
    globalHostMutationTaint: mutations,
    isStandardLibraryDeclaration: (declaration: ts.Declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  }
  return { checker, flow, ledger, definition, mutations, context }
}

test('typed accessor installation independently records omitted inherited descriptor fields without a reflection query', () => {
  const { checker, flow, ledger, definition, context, mutations } = inspect('{ get: getter, configurable: true }')
  const proof = ledger.capture(() => sourceDescriptorOwnProtocolOf(checker, flow, definition))
  assert.ok(proof.value)
  assert.equal(proof.value.definition, definition)
  assert.equal(proof.value.descriptor, definition.arguments[2])
  assert.deepEqual(proof.value.ownNames, ['configurable', 'get'])
  const inherited = proof.requirements.find((requirement) => requirement.prototypeKeys !== undefined)!
  assert.deepEqual(inherited.prototypeAbsentNames, ['enumerable', 'value', 'writable', 'set'])
  assert.deepEqual(inherited.prototypeKeys, { names: inherited.prototypeAbsentNames })
  assert.equal(failedIntrinsicProtocolRequirements(context, proof.requirements).length, 0)
  mutations.taintSurface(namedKey('value'))
  assert.equal(failedIntrinsicProtocolRequirements(context, proof.requirements).length, 1)
})

test('own fields shadow prototype state while an unclaimed key never does', () => {
  const { checker, flow, ledger, definition, context, mutations } = inspect('{ value: 1, writable: true }')
  const proof = ledger.capture(() => sourceDescriptorOwnProtocolOf(checker, flow, definition))
  assert.ok(proof.value)
  mutations.taintSurface(namedKey('value'))
  assert.equal(failedIntrinsicProtocolRequirements(context, proof.requirements).length, 0)
  mutations.taintSurface(namedKey('get'))
  assert.equal(failedIntrinsicProtocolRequirements(context, proof.requirements).length, 1)
})

test('ordinary descriptor methods are own data Functions while accessor declarations are not', () => {
  const state = inspect('{ get() { return 1; }, set(value: number) { void value; }, configurable: true }')
  const proof = state.ledger.capture(() => sourceDescriptorOwnProtocolOf(state.checker, state.flow, state.definition))
  assert.ok(proof.value)
  assert.deepEqual(proof.value.ownNames, ['configurable', 'get', 'set'])
  assert.equal(failedIntrinsicProtocolRequirements(state.context, proof.requirements).length, 0)
  state.mutations.taintSurface(namedKey('get'))
  assert.equal(failedIntrinsicProtocolRequirements(state.context, proof.requirements).length, 0)
  state.mutations.taintSurface(namedKey('value'))
  assert.equal(failedIntrinsicProtocolRequirements(state.context, proof.requirements).length, 1)
  for (const descriptor of ['{ get get() { return getter; } }', "{ ['get']() { return 1; } }", '{ get() { return 1; }, get: getter }']) {
    const denied = inspect(descriptor)
    assert.equal(
      denied.ledger.capture(() => sourceDescriptorOwnProtocolOf(denied.checker, denied.flow, denied.definition)).value,
      null,
      descriptor
    )
  }
})

test('a complete own-key protocol does not invent an inherited read', () => {
  // This is solely the HasProperty protocol. Payload validation separately
  // rejects invalid mixtures of data/accessor descriptor halves.
  const complete = inspect('{ enumerable: false, configurable: false, value: 1, writable: false, get: undefined, set: undefined }')
  const proof = complete.ledger.capture(() => sourceDescriptorOwnProtocolOf(complete.checker, complete.flow, complete.definition))
  assert.ok(proof.value)
  assert.deepEqual(new Set(proof.value.ownNames), new Set(propertyDescriptorFieldNames))
  assert.equal(
    proof.requirements.some((requirement) => requirement.prototypeKeys !== undefined),
    false
  )
})

test('prototype initializers, computed/accessor/spread fields and unknown descriptor aliases provide no ordinary own-field proof', () => {
  for (const descriptor of [
    '{ __proto__: null, value: 1 }',
    "{ ['__proto__']: null, value: 1 }",
    "{ ['value']: 1 }",
    '{ get value() { return 1; } }',
    '{ ...{ value: 1 } }',
    '{ value: 1, value: 2 }',
    'owner'
  ]) {
    const state = inspect(descriptor)
    assert.equal(
      state.ledger.capture(() => sourceDescriptorOwnProtocolOf(state.checker, state.flow, state.definition)).value,
      null,
      descriptor
    )
  }
})

test('a shadowed definition and a source-declared inherited key cannot acquire the standard protocol', () => {
  const shadowed = inspect(
    '',
    `export {}; function run(Object: { defineProperty(target: object, key: string, descriptor: object): void }) { Object.defineProperty({}, 'entry', { value: 1 }); }`
  )
  assert.equal(
    shadowed.ledger.capture(() => sourceDescriptorOwnProtocolOf(shadowed.checker, shadowed.flow, shadowed.definition)).value,
    null
  )
  const inherited = inspect(
    '',
    `export {}; declare global { interface Object { get: unknown; } } Object.defineProperty({}, 'entry', { value: 1 });`
  )
  assert.equal(
    inherited.ledger.capture(() => sourceDescriptorOwnProtocolOf(inherited.checker, inherited.flow, inherited.definition)).value,
    null
  )
})

test('an independently authenticated snapshot domain still discharges its omissions at this new definition', () => {
  const state = inspect('owner')
  assert.equal(state.ledger.capture(() => sourceDescriptorOwnProtocolOf(state.checker, state.flow, state.definition)).value, null)
  const proof = state.ledger.capture(() =>
    sourceDescriptorOwnProtocolOf(state.checker, state.flow, state.definition, (descriptor) =>
      descriptor === state.definition.arguments[2] ? ['get', 'set', 'enumerable', 'configurable'] : null
    )
  )
  assert.ok(proof.value)
  const inherited = proof.requirements.find((requirement) => requirement.prototypeKeys !== undefined)!
  assert.deepEqual(inherited.prototypeAbsentNames, ['value', 'writable'])
  state.mutations.taintSurface(namedKey('writable'))
  assert.equal(failedIntrinsicProtocolRequirements(state.context, proof.requirements).length, 1)
})
