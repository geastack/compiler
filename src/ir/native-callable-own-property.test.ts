import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { operationOfResult, type FunctionId, type IrValueId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { allOperationsOf, isTerminatorOperation, type GetOperation, type IrBody, type IrOperation, type SetOperation } from './model.js'
import {
  createNativeCallableOwnPropertySource,
  ordinaryFunctionDataWriteMatches,
  ordinaryFunctionStoreResultMatches,
  nativeCallablePrivateSlotsOf,
  nativeCallablePrivateSlotMatches,
  type NativeCallablePrivateSlotInput
} from './native-callable-own-property.js'
import { nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'

const string: Representation = { kind: 'string' }
const frame: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const callable: Representation = { kind: 'function-value-dispatch', abi: frame }
const constructor: Representation = { kind: 'function-and-constructor', call: frame, construct: frame }
const operand = (value: string, representation: Representation) => ({ value: value as IrValueId, representation })
const body = (operations: readonly IrOperation[]): IrBody => ({
  owner: 'body' as never,
  sourceOwner: 'region' as never,
  abi: null,
  construct: null,
  entry: 'entry' as never,
  blockOrder: ['entry' as never],
  values: new Map(),
  tryRegions: [],
  blocks: new Map([
    [
      'entry' as never,
      {
        id: 'entry' as never,
        operations: operations.filter((operation) => !isTerminatorOperation(operation)),
        terminator: operations.find(isTerminatorOperation) ?? { kind: 'return', lineage: null, value: null }
      }
    ]
  ])
})
const fixture = () => {
  const allocate = (id: string, representation: Representation): IrOperation => ({
    kind: 'allocate-callable',
    lineage: `allocate-${id}` as never,
    functionId: id as FunctionId,
    captures: [],
    result: { id: id as IrValueId, representation }
  })
  const key: IrOperation = {
    kind: 'constant',
    lineage: 'key-origin' as never,
    literal: 'string',
    text: 'make',
    result: { id: 'key' as IrValueId, representation: string }
  }
  const store: SetOperation = {
    kind: 'set',
    lineage: 'store-origin' as never,
    receiver: operand('constructor', constructor),
    key: operand('key', string),
    value: operand('method', callable),
    result: null,
    strict: true,
    ordinaryFunctionDataWrite: true
  }
  const read: GetOperation = {
    kind: 'get',
    lineage: 'read-origin' as never,
    receiver: store.receiver,
    key: store.key,
    result: { id: 'read' as IrValueId, representation: callable }
  }
  const call: IrOperation = {
    kind: 'call',
    lineage: 'call-origin' as never,
    callee: operand('read', callable),
    receiver: null,
    thisArgument: store.receiver,
    arguments: [],
    result: null
  }
  const operations = [allocate('constructor', constructor), allocate('method', callable), key, store, read, call]
  const query = (ops = operations, independent = true) =>
    createNativeCallableOwnPropertySource([body(ops)], new Map(), undefined, () => independent)(read, 'make')
  return { key, store, read, call, operations, query }
}

test('a native constructor data slot supplies only its exact initialized independent source Function', () => {
  const { operations, read, query } = fixture()
  assert.deepEqual(query(), ['method'])
  assert.equal(query(operations, false), null)
  assert.equal(
    createNativeCallableOwnPropertySource(
      [body(operations)],
      new Map(),
      undefined,
      () => true
    )({ ...read, receiver: operand('external', constructor) }, 'make'),
    null
  )
})

test('prototype uncertainty, ordering, mutation, extraction and external publication cannot close the slot', () => {
  const { operations, store, read, query } = fixture()
  const { ordinaryFunctionDataWrite, ...unproved } = store
  assert.equal(query(operations.map((operation) => (operation === store ? unproved : operation))), null)
  assert.equal(query([...operations.slice(0, 3), read, store, ...operations.slice(5)]), null)
  assert.equal(query([...operations, { ...store, lineage: 'replacement' as never }]), null)
  assert.equal(
    query([
      ...operations,
      {
        kind: 'binding-write',
        lineage: 'extraction' as never,
        declaration: 'extracted' as never,
        value: operand('read', callable)
      }
    ]),
    null
  )
  assert.equal(
    query([
      ...operations,
      {
        kind: 'call',
        lineage: 'publication' as never,
        callee: operand('external', callable),
        receiver: null,
        arguments: [operand('constructor', constructor)],
        result: null
      }
    ]),
    null
  )
})

test('unknown or mismatched installation results are not receiver aliases; construction needs a complete closure', () => {
  const { operations, store, read, query } = fixture()
  const result: Representation = { kind: 'scalar', domain: 'boolean' }
  const success = { ...store, result: { id: 'success' as IrValueId, representation: result } }
  assert.equal(
    query(
      operations.map((operation) =>
        operation === read ? { ...read, receiver: operand('success', constructor) } : operation === store ? success : operation
      )
    ),
    null
  )
  assert.equal(
    query([
      ...operations.map((operation) => (operation === store ? success : operation)),
      {
        kind: 'return',
        lineage: null,
        value: operand('success', result)
      }
    ]),
    null
  )
  assert.equal(
    query([
      ...operations,
      {
        kind: 'construct',
        lineage: 'instance' as never,
        callee: store.receiver,
        newTarget: store.receiver,
        target: { kind: 'exact', target: { kind: 'implicit-source-constructor', classDeclaration: 'constructor' as never }, evidence: [] },
        arguments: [],
        result: { id: 'instance' as IrValueId, representation: { kind: 'void' } }
      }
    ]),
    null
  )
})

test('only the canonical property receiver result authorizes receiver threading', () => {
  const { store } = fixture()
  const result = { ...store, result: { id: 'threaded' as IrValueId, representation: constructor } }
  const semantic = {
    family: 'property',
    internalMethod: 'set',
    results: [{ id: store.lineage, role: 'value', type: 'receiver-type' }],
    operands: [{ role: 'receiver', ordinal: 0, type: 'receiver-type' }]
  } as unknown as SemanticOperation
  assert.equal(ordinaryFunctionStoreResultMatches(result, semantic), true)
  assert.equal(ordinaryFunctionStoreResultMatches(result, null), false)
  assert.equal(
    ordinaryFunctionStoreResultMatches(
      { ...result, result: { ...result.result, representation: { kind: 'scalar', domain: 'boolean' } } },
      semantic
    ),
    false
  )
})

test('private-slot receipts bind the exact stored allocation and original data operations', () => {
  const { operations, store, read } = fixture()
  const semantic = operations
    .filter((operation) => operation.kind === 'allocate-callable' || operation.kind === 'set' || operation.kind === 'get')
    .map((operation) => {
      const source =
        operation.kind === 'allocate-callable'
          ? { family: 'allocation', allocated: 'function-object', callable: operation.functionId, operands: [] }
          : {
              family: 'property',
              internalMethod: operation.kind,
              ...(operation.kind === 'set' ? { ordinaryFunctionDataWrite: true } : {}),
              operands: [
                { role: 'receiver', ordinal: 0, source: { kind: 'result', result: operations[0]!.lineage } },
                { role: 'key', ordinal: 0, source: { kind: 'constant', literal: 'string', text: 'make' } },
                ...(operation.kind === 'set'
                  ? [{ role: 'value', ordinal: 0, source: { kind: 'result', result: operations[1]!.lineage } }]
                  : [])
              ]
            }
      return [
        operationOfResult(operation.lineage),
        { ...source, results: [{ role: 'value', id: operation.lineage }] } as unknown as SemanticOperation
      ] as const
    })
  const module = body(operations)
  const implementation = { ...body([]), owner: 'implementation' as never, sourceOwner: 'method' as FunctionId, abi: frame }
  const input: NativeCallablePrivateSlotInput = {
    bodies: new Map([
      [module.owner, module],
      [implementation.owner, implementation]
    ]),
    placements: new Map(),
    conversions: { nodeById: () => null },
    deriver: { layoutOf: () => ({ kind: 'void' }) } as never,
    classes: new Map(),
    graph: {
      operations: new Map(semantic),
      results: new Map(semantic.flatMap(([id, operation]) => operation.results.map((result) => [result.id, id] as const)))
    }
  }
  const plans = nativeCallablePrivateSlotsOf(input)
  const receipt = plans.get(read)
  assert.ok(receipt)
  assert.equal(plans.get(store), receipt)
  assert.equal(nativeCallablePrivateSlotMatches(receipt, { ...receipt, value: operand('wrong-allocation', callable) }), false)
  assert.equal(nativeCallablePrivateSlotMatches(receipt, { ...receipt, callable: 'wrong-body' as FunctionId }), false)
  const changed = operations.map((operation) =>
    operation.kind === 'allocate-callable' && operation.functionId === 'method'
      ? { ...operation, functionId: 'substituted-body' as FunctionId }
      : operation
  )
  const corrupted = { ...module, blocks: body(changed).blocks }
  assert.equal(
    nativeCallablePrivateSlotsOf({
      ...input,
      bodies: new Map([
        [corrupted.owner, corrupted],
        [implementation.owner, implementation]
      ])
    }).size,
    0
  )
})

test('ordinary Function installation authenticates the canonical key and source operation', () => {
  const { store, key } = fixture()
  const semantic = {
    family: 'property',
    internalMethod: 'set',
    ordinaryFunctionDataWrite: true,
    results: [{ id: store.lineage, role: 'value' }],
    operands: [{ role: 'key', ordinal: 0, source: { kind: 'constant', literal: 'string', text: 'make' } }]
  } as unknown as SemanticOperation
  assert.equal(ordinaryFunctionDataWriteMatches(store, semantic, key), true)
  assert.equal(ordinaryFunctionDataWriteMatches({ ...store, lineage: 'another-source' as never }, semantic, key), false)
  const { ordinaryFunctionDataWrite: _proof, ...unprovedSource } = semantic as Extract<SemanticOperation, { family: 'property' }>
  assert.equal(ordinaryFunctionDataWriteMatches(store, unprovedSource, key), false)
  assert.equal(ordinaryFunctionDataWriteMatches(store, semantic, { ...key, text: 'other' } as IrOperation), false)
})

const entry = resolve('test/runtime/js-constructor-with-statics.js')
const original = readFileSync(entry, 'utf8')
const compileSource = (source: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })

test('a private constructor static retains native storage and its exact source receipt', () => {
  const result = compileSource(original)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.ok(result.source !== null, JSON.stringify(result.emissionRefusals))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  assert.ok(operations.some((operation) => operation.kind === 'set' && operation.privateNativeCallableSlot !== undefined))
  assert.ok(operations.some((operation) => operation.kind === 'get' && operation.privateNativeCallableSlot !== undefined))
  assert.ok(!result.source.includes('gea::Value::box(gea::Value::Tag::Function'))
})

test('instance constructor/prototype observation or publication prevents native private-slot elision', () => {
  for (const observation of ['console.log(made.constructor)', 'console.log(Object.getPrototypeOf(made))', 'console.log(made)']) {
    const result = compileSource(original.replace('var direct =', `${observation};\nvar direct =`))
    const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    assert.ok(!operations.some((operation) => operation.kind === 'get' && operation.privateNativeCallableSlot !== undefined), observation)
  }
})

test('a real inherited setter or later data mutation cannot borrow the native installation proof', () => {
  const inherited = compileSource(`Object.defineProperty(Function.prototype, 'fromParts', { set: function(value) {} });\n${original}`)
  const operations = (inherited.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  assert.ok(!operations.some((operation) => operation.kind === 'set' && operation.ordinaryFunctionDataWrite === true))
  for (const inserted of [
    `SourceNode.fromParts = function replacement(line) { return new SourceNode(line, 'changed.js') };`,
    `console.log(SourceNode);`,
    `Object.defineProperty(SourceNode, 'fromParts', { get: function() { return function(line) { return new SourceNode(line, 'getter.js') } } });`
  ]) {
    const result = compileSource(original.replace('var made =', `${inserted}\nvar made =`))
    assert.equal(result.certificate, null, `${inserted}: ${JSON.stringify(result.refusals)}`)
  }
})

test('a receiver-dependent JavaScript body supplies no independent-source shortcut', () => {
  const source = original
    .replace('/** @param {number} line */', '/**\n * @param {number} line\n * @this {*}\n */')
    .replace('function SourceNode_fromParts(line) {', 'function SourceNode_fromParts(line) { console.log(this);')
  const result = compileSource(source)
  const bodies = result.irBodies ?? []
  const operations = bodies.flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const keys = new Set(
    operations.flatMap((operation) => (operation.kind === 'constant' && operation.text === 'fromParts' ? [operation.result.id] : []))
  )
  const read = operations.find((operation): operation is GetOperation => operation.kind === 'get' && keys.has(operation.key.value))
  assert.ok(read)
  const query = createNativeCallableOwnPropertySource(bodies, result.projection.placements, result.conversionCensus, (functionId) => {
    const variants = bodies.filter((body) => body.sourceOwner === functionId)
    return variants.length > 0 && variants.every(nativeBodyIgnoresLogicalReceiver)
  })
  assert.equal(query(read, 'fromParts'), null)
})
