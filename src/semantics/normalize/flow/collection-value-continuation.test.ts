import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { indexValueFlow } from './value-flow.js'
import { wholeProgram } from '../reachability.js'
import { hasClosedValueUses } from './callable-reach.js'
import { censusArgumentsObjects } from '../arguments-objects.js'
import { collectionKeyArgumentIsInert, collectionStoredValuesOf, collectionValueContinuationsOf } from './collection-value-continuation.js'

const inspect = (source: string, readText?: string) => {
  const entry = resolve('test/fixtures/collection-value-continuation.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, 'export {};\n' + source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const args = censusArgumentsObjects(checker, [file])
  const closed = (plan: import('./native-collection-protocol.js').NativeCollectionProtocolPlan) =>
    hasClosedValueUses(
      checker,
      flow,
      plan.roots,
      plan.terminalUse,
      (node) => checker.getTypeAtLocation(node),
      (owner) => args.usesByOwner.get(owner)
    )
  if (readText !== undefined) {
    const read = flow.calls.find((site) => site.call.getText(file) === readText)?.call
    return read && ts.isCallExpression(read)
      ? (collectionStoredValuesOf(checker, flow, read, closed)?.map((node) => node.getText(file)) ?? null)
      : null
  }
  const write = flow.allWrites.find((entry) => entry.edge === 'collection-value' && entry.value?.getText(file) === 'held')
  if (!write || !ts.isCallExpression(write.site) || !write.value || !ts.isExpression(write.value)) return null
  return collectionValueContinuationsOf(checker, flow, write.site, write.value, closed)?.map((result) => result.getText(file)) ?? null
}

test('local native map publication follows every get through aliases', () => {
  for (const family of ['Map', 'WeakMap']) {
    assert.deepEqual(
      inspect(`const values = new ${family}<object, object>(); const alias = values;
        const key = {}; const held = {}; values.set(key, held);
        alias.has(key); values.delete(key); alias.get(key); values.get({});`),
      ['alias.get(key)', 'values.get({})']
    )
  }
  for (const callee of ['(Map)', '(Map as MapConstructor)', '(Map satisfies MapConstructor)', '(Map!)']) {
    assert.deepEqual(
      inspect(`const values = new ${callee}(); const other = new (Map)(); const held = {}; values.set(1, held); values.get(1);`),
      ['values.get(1)']
    )
  }
  assert.deepEqual(
    inspect(
      'class Holder { cache = new Map(); get(key: number) { return this.cache.get(key) } } const owner = new Holder(); owner.get(1); const values = new Map(); const held = {}; values.set(1, held); values.get(1);'
    ),
    ['values.get(1)']
  )
  assert.deepEqual(inspect('const values = new Map(); const held = {}; values.set(1, held); values.clear();'), [])
  assert.deepEqual(inspect('let values = new WeakMap(); const held = {}; values.set({}, held); values = new WeakMap(); values.get({});'), [
    'values.get({})'
  ])
})

test('collection proof rejects opaque publication, overrides and iteration', () => {
  const prefix = 'declare function external(value: unknown): void; const values = new Map(); const held = {}; values.set(1, held);'
  for (const use of [
    'external(values);',
    'const other = new Map(); Object.getPrototypeOf(other).get = () => ({});',
    'const other = new Map(); Reflect.getPrototypeOf(other).set = () => ({});',
    'const other = new Map(); const alias = other; external(alias);',
    'export const other = new Map();',
    'const other = new Map(); export { other as cache };',
    'const other = new Map(); const bag = { other }; external(bag);',
    'class Holder { cache = new Map(); } const owner = new Holder(); external(owner);',
    'const alias = values; external(alias);',
    'values.get = () => ({});',
    'values.forEach(external);',
    'external(values.values());',
    'external(values.set(2, {}));',
    'Map.prototype.get = () => ({});',
    '(Map as MapConstructor).prototype.get = () => ({});',
    'external((Map));',
    'const ctor = Map; external(ctor);',
    'const global = globalThis; external(global);',
    'const global = globalThis; global.Map.prototype.get = () => ({});'
  ])
    assert.equal(inspect(prefix + use), null, use)
  assert.equal(
    inspect('class Fake { set(key: unknown, value: unknown) {} } const values = new Fake(); const held = {}; values.set(1, held);'),
    null
  )
  assert.equal(
    inspect(
      'class Custom extends Map { set(key: unknown, value: unknown) { return this } } const values = new Custom(); const held = {}; values.set(1, held);'
    ),
    null
  )
  assert.equal(inspect('export const values = new Map(); const held = {}; values.set(1, held);'), null)
  assert.equal(inspect(prefix + 'export const globals = globalThis;'), null)
  for (const exposed of ['export { values };', 'export { values as cache };', 'export default values;'])
    assert.equal(inspect(prefix + exposed), null, exposed)
  assert.equal(inspect(prefix + 'const globals = globalThis; export { globals as api };'), null)
})

test('class-field collection aliases publish one complete stored-value graph', () => {
  const source = `class Holder {
    maps = new (Map)<number, object>();
    put(held: object) { const alias = this.maps; alias.set(1, held); }
    get() { return this.maps.get(1); }
  }
  const owner = new Holder(); owner.put({}); owner.get();`
  assert.deepEqual(inspect(source), ['this.maps.get(1)'])
  assert.deepEqual(inspect(source, 'this.maps.get(1)'), ['held'])
  assert.equal(inspect(source + 'declare function external(value: unknown): void; external(owner);', 'this.maps.get(1)'), null)
  assert.equal(inspect('const values = new Map([[1, {}]]); values.get(1);', 'values.get(1)'), null)
  assert.equal(
    inspect(
      'declare function external(value: unknown): void; function send(value: object) { external(arguments[0]); } const other = new Map(); send(other); const values = new Map(); const held = {}; values.set(1, held);'
    ),
    null
  )
})

/** Whether argument `index` of the call spelled `callText` is an inert key. */
const keyIsInert = (source: string, callText: string, index = 0): boolean => {
  const entry = resolve('test/fixtures/collection-key-argument.ts')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === resolve(entry) ? ts.createSourceFile(name, 'export {};\n' + source, version, true) : original(name, version, ...rest)
  const program = ts.createProgram([entry], options, host)
  const file = program.getSourceFile(entry)!
  const checker = program.getTypeChecker()
  const flow = indexValueFlow(checker, [file], wholeProgram)
  const args = censusArgumentsObjects(checker, [file])
  const closed = (plan: import('./native-collection-protocol.js').NativeCollectionProtocolPlan) =>
    hasClosedValueUses(
      checker,
      flow,
      plan.roots,
      plan.terminalUse,
      (node) => checker.getTypeAtLocation(node),
      (owner) => args.usesByOwner.get(owner)
    )
  const call = flow.calls.find((site) => site.call.getText(file) === callText)?.call
  assert.ok(call && ts.isCallExpression(call) && call.arguments[index], callText)
  return collectionKeyArgumentIsInert(checker, flow, call, call.arguments[index]!, closed)
}

test('a closed native map only compares its key arguments by identity', () => {
  // Three's `WebGLObjects.update`: the drawable itself keys the frame map.
  const source = `const updateMap = new WeakMap<object, number>(); const object = {};
    if (updateMap.get(object) !== 1) updateMap.set(object, 1); updateMap.has(object); updateMap.delete(object);`
  for (const call of ['updateMap.get(object)', 'updateMap.set(object, 1)', 'updateMap.has(object)', 'updateMap.delete(object)'])
    assert.equal(keyIsInert(source, call), true, call)
  const both = 'const values = new Map<object, object>(); const object = {}; values.set(object, object); values.get(object);'
  assert.equal(keyIsInert(both, 'values.set(object, object)', 0), true)
  assert.equal(keyIsInert(both, 'values.set(object, object)', 1), false)
})

test('iteration, key extraction and an escaping map keep the key argument open', () => {
  const prefix =
    'declare function external(value: unknown): void; const values = new Map<object, number>(); const object = {}; values.set(object, 1);'
  for (const use of [
    'for (const entry of values) {}',
    'external(values.keys());',
    'values.forEach(external);',
    'external(values);',
    'const alias = values; external(alias);',
    'external([...values]);'
  ])
    assert.equal(keyIsInert(prefix + use, 'values.set(object, 1)'), false, use)
  assert.equal(
    keyIsInert(
      'class Fake { get(key: unknown) {} } const values = new Fake(); const object = {}; values.get(object);',
      'values.get(object)'
    ),
    false
  )
})
