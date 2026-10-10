import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { sourceAccessorDescriptorOf, sourceAccessorDescriptorOwnNamesOf } from './source-accessor-descriptor.js'
import { sourceDescriptorOwnProtocolOf } from './source-descriptor-protocol.js'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { attachDeferredIntrinsicProtocolLedger, createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { createStructuralMapper } from '../structural.js'
import { createIdentityTable } from '../identities.js'
import { createStructuralTypeTable } from '../../model/structural-type-table.js'

const inspect = (source: string) => {
  const entry = resolve('test/runtime/native-accessor-descriptor-functions.runtime.ts')
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, types: [] }
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
  const table = createStructuralTypeTable()
  const mapper = createStructuralMapper(
    checker,
    createIdentityTable(program, checker),
    table,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    flow,
    undefined,
    undefined,
    undefined,
    () => true
  )
  const query = flow.calls
    .map((site) => site.call)
    .find(
      (call): call is ts.CallExpression =>
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'getOwnPropertyDescriptor'
    )!
  assert.ok(query)
  return { checker, flow, ledger, mapper, table, query }
}

test('an exact installed descriptor retains native getter results and setter parameters', () => {
  const { checker, flow, ledger, mapper, table, query } = inspect(`
    function getter(this: { marker: number }): number[] { return [1, 2]; }
    function setter(values: number[]): void { void values; }
    const owner = {};
    Object.defineProperty(owner, 'entry', { get: getter, set: setter, configurable: true });
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'entry');
  `)
  const receipt = ledger.capture(() => sourceAccessorDescriptorOf(checker, flow, query))
  assert.ok(receipt.value?.getter)
  assert.ok(receipt.value?.setter)
  assert.ok(receipt.requirements.some((one) => one.member === 'defineProperty'))
  assert.ok(receipt.requirements.some((one) => one.prototypeKeys?.names?.includes('value')))
  const type = ledger.capture(() => mapper.typeAt(query)).value
  const union = table.get(type).shape
  assert.equal(union.kind, 'union')
  if (union.kind !== 'union') return
  const descriptor = union.members.map((member) => table.get(member).shape).find((shape) => shape.kind === 'object')!
  assert.ok(descriptor && descriptor.kind === 'object')
  if (descriptor.kind !== 'object') return
  assert.equal(
    descriptor.members.some((member) => member.key.kind === 'string' && member.key.value === 'value'),
    false
  )
  for (const name of ['get', 'set']) {
    const field = descriptor.members.find((member) => member.key.kind === 'string' && member.key.value === name)!
    const shape = table.get(field.type).shape
    assert.equal(shape.kind, 'signature')
    if (shape.kind !== 'signature') continue
    assert.equal(shape.call[0]!.thisParameter, null)
    const nativeType = name === 'get' ? shape.call[0]!.result : shape.call[0]!.parameters[0]!.type
    assert.equal(table.get(nativeType).shape.kind, 'array')
  }
})

test('aliases, conditional installation, intervening effects and mutable descriptor inputs supply no source receipt', () => {
  for (const between of [
    "const alias = owner; Object.defineProperty(alias, 'entry', { get: getter });",
    "if (true) Object.defineProperty(owner, 'entry', { get: getter });",
    "Object.defineProperty(owner, 'entry', { get: getter }); console.log('effect');",
    "const input = { get: getter }; Object.defineProperty(owner, 'entry', input);"
  ]) {
    const { checker, flow, ledger, query } = inspect(`
      function getter(): number[] { return [1]; }
      const owner = {};
      ${between}
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'entry');
    `)
    assert.equal(ledger.capture(() => sourceAccessorDescriptorOf(checker, flow, query)).value, null, between)
  }
})

test('a replaced source Function cannot nominate the native accessor result', () => {
  const { checker, flow, ledger, query } = inspect(`
    let getter = (): number[] => [1];
    getter = (): number[] => [2];
    const owner = {};
    Object.defineProperty(owner, 'entry', { get: getter });
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'entry');
  `)
  assert.equal(ledger.capture(() => sourceAccessorDescriptorOf(checker, flow, query)).value, null)
})

const snapshot = (between: string, suffix = 'console.log(descriptor.get === getter, descriptor.set === setter);', binding = 'const') => {
  const state = inspect(`
    function getter(): number[] { return [1]; }
    function setter(values: number[]): void { void values; }
    const owner = {};
    const restored = {};
    Object.defineProperty(owner, 'entry', { get: getter, set: setter, configurable: true });
    ${binding} descriptor = Object.getOwnPropertyDescriptor(owner, 'entry')!;
    ${between}
    Object.defineProperty(restored, 'copy', descriptor);
    ${suffix}
  `)
  const definition = state.flow.calls
    .map((site) => site.call)
    .find(
      (call): call is ts.CallExpression =>
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'defineProperty' &&
        call.arguments[2] !== undefined &&
        ts.isIdentifier(call.arguments[2]) &&
        call.arguments[2].text === 'descriptor'
    )!
  assert.ok(definition)
  const descriptor = definition.arguments[2]!
  return { ...state, descriptor, definition }
}

test('an immutable accessor snapshot permits its data reads and independently discharges reinstallation omissions', () => {
  const state = snapshot('')
  const proof = state.ledger.capture(() =>
    sourceDescriptorOwnProtocolOf(state.checker, state.flow, state.definition, (descriptor) =>
      sourceAccessorDescriptorOwnNamesOf(state.checker, state.flow, descriptor, state.definition)
    )
  )
  assert.ok(proof.value)
  assert.deepEqual(proof.value.ownNames, ['configurable', 'enumerable', 'get', 'set'])
  assert.equal(proof.value.descriptor, state.descriptor)
  const ownDefinition = proof.requirements.find(
    (requirement) => requirement.location === state.definition && requirement.prototypeKeys !== undefined
  )
  assert.deepEqual(ownDefinition?.prototypeAbsentNames, ['value', 'writable'])
  assert.ok(
    proof.requirements.some((requirement) => requirement.location === state.query && requirement.member === 'getOwnPropertyDescriptor')
  )
})

test('snapshot mutation, aliases, opaque publication and descriptor-receiver calls cannot borrow its original own-field domain', () => {
  for (const between of [
    'descriptor.get = getter;',
    'delete descriptor.set;',
    '({ get: descriptor.get } = { get: getter });',
    'Object.defineProperty(descriptor, "value", { value: 1 });',
    'Reflect.set(descriptor, "get", getter);',
    'const alias = descriptor;',
    'declare function opaque(value: unknown): void; opaque(descriptor);',
    'descriptor.get!();',
    'const later = () => descriptor.get;',
    'export { descriptor };'
  ]) {
    const state = snapshot(between)
    assert.equal(
      state.ledger.capture(() => sourceAccessorDescriptorOwnNamesOf(state.checker, state.flow, state.descriptor, state.definition)).value,
      null,
      between
    )
  }
  const mutable = snapshot('', '', 'let')
  assert.equal(
    mutable.ledger.capture(() => sourceAccessorDescriptorOwnNamesOf(mutable.checker, mutable.flow, mutable.descriptor, mutable.definition))
      .value,
    null
  )
})

test('a deferred reinstallation cannot borrow source statement order across its execution boundary', () => {
  const state = snapshot('', 'function later() { Object.defineProperty({}, "later", descriptor); }')
  const late = state.flow.calls
    .map((site) => site.call)
    .find(
      (call): call is ts.CallExpression =>
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'defineProperty' &&
        call.arguments[1] !== undefined &&
        ts.isStringLiteral(call.arguments[1]) &&
        call.arguments[1].text === 'later'
    )!
  assert.ok(late)
  assert.equal(
    state.ledger.capture(() => sourceAccessorDescriptorOwnNamesOf(state.checker, state.flow, late.arguments[2]!, late)).value,
    null
  )
})
