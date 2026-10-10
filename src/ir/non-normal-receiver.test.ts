import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { FunctionId, IrValueId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import type { CallCalleeIdentity, CallOperation, IrBody, IrOperand, IrOperation } from './model.js'
import { nonNormalReceiverProofMatches, nonNormalReceiverProofOf, type NonNormalReceiverInput } from './non-normal-receiver.js'
import { resultOfIrOperation } from './queries.js'

const string: Representation = { kind: 'string' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const module: Representation = { kind: 'native-record-ref', shapeId: 'module-record', ownership: 'shared-refcount', native: null }
const lineage = (id: string) => id as SemanticResultId
const operand = (value: IrValueId, representation: Representation): IrOperand => ({ value, representation })
const fixture = () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const trapFunction = 'trap-function' as FunctionId
  const callerFunction = 'caller-function' as FunctionId
  const trapAbi: CallableAbi = {
    receiver: null,
    restFrom: null,
    parameters: [module, dynamic].map((value) => ({ value, passing: 'by-value' as const, ownership: 'owned' as const })),
    result: dynamic
  }
  const trapValue: Representation = { kind: 'function-value-dispatch', abi: trapAbi }
  const method: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
  }
  const handler: Representation = {
    kind: 'record',
    shapeId: 'handler',
    fields: [{ key: 'get', value: trapValue, required: true }],
    accessors: [],
    ownership: 'owned'
  }
  const proxy: Representation = { kind: 'proxy-object', target: module, handler }
  const sum: Representation = {
    kind: 'tagged-union',
    arms: [module, proxy].map((value, index) => ({
      tag: String(index),
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' },
      value
    }))
  }
  const trapBuilder = createIrBodyBuilder('trap-body' as PhysicalBodyId, trapFunction, trapAbi)
  const trapEntry = trapBuilder.openBlock()
  const returned = trapBuilder.openBlock()
  const thrown = trapBuilder.openBlock()
  trapBuilder.parameter(trapEntry, lineage('target-parameter'), 0, module)
  const key = trapBuilder.parameter(trapEntry, lineage('key-parameter'), 1, dynamic)
  const errorKey = trapBuilder.constant(trapEntry, lineage('error-key'), 'kModuleError', 'string', string)
  const boxing = conversions.nodeFor(string, dynamic)
  const boxedKey = trapBuilder.convert(trapEntry, lineage('error-key-box'), boxing.id, operand(errorKey, string), dynamic)
  const matches = trapBuilder.compute(
    trapEntry,
    lineage('key-match'),
    'equality',
    '===',
    [operand(key, dynamic), operand(boxedKey, dynamic)],
    boolean
  )
  trapBuilder.branch(trapEntry, lineage('key-branch'), operand(matches, boolean), returned, thrown)
  trapBuilder.return(returned, lineage('normal-return'), operand(key, dynamic))
  trapBuilder.throw(thrown, lineage('abrupt-return'), operand(key, dynamic))
  const trapBody = trapBuilder.seal()

  const callerAbi: CallableAbi = {
    receiver: null,
    restFrom: null,
    parameters: [{ value: sum, passing: 'by-value', ownership: 'owned' }],
    result: { kind: 'void' }
  }
  const builder = createIrBodyBuilder('caller-body' as PhysicalBodyId, callerFunction, callerAbi)
  const entry = builder.openBlock()
  const proxyBlock = builder.openBlock()
  const plainBlock = builder.openBlock()
  const join = builder.openBlock()
  const root = builder.parameter(entry, lineage('root'), 0, sum)
  const selectedKey = builder.constant(entry, lineage('property'), 'compress', 'string', string)
  const armTest = builder.proxyArmTest(entry, lineage('property'), operand(root, sum))
  builder.branch(entry, lineage('property'), operand(armTest, boolean), proxyBlock, plainBlock)
  const selected = builder.convert(proxyBlock, lineage('property'), conversions.nodeFor(sum, proxy).id, operand(root, sum), proxy)
  const target = builder.proxyPart(proxyBlock, lineage('property'), operand(selected, proxy), 'target', module)
  const actualHandler = builder.proxyPart(proxyBlock, lineage('property'), operand(selected, proxy), 'handler', handler)
  const getKey = builder.constant(proxyBlock, lineage('property'), 'get', 'string', string)
  const get = builder.get(proxyBlock, lineage('property'), operand(actualHandler, handler), operand(getKey, string), trapValue)
  const keyArgument = builder.convert(proxyBlock, lineage('property'), boxing.id, operand(selectedKey, string), dynamic)
  const call = builder.call(
    proxyBlock,
    lineage('property'),
    operand(get, trapValue),
    null,
    [operand(target, module), operand(keyArgument, dynamic)],
    dynamic
  )!
  const adapted = builder.convert(proxyBlock, lineage('property'), conversions.nodeFor(dynamic, method).id, operand(call, dynamic), method)
  builder.jump(proxyBlock, lineage('property'), join)
  const remainder = builder.mergeLiveArmRebuild(plainBlock, lineage('property'), operand(root, sum), module, [0], false, conversions)
  const plain = builder.get(plainBlock, lineage('property'), operand(remainder, module), operand(selectedKey, string), method)
  builder.jump(plainBlock, lineage('property'), join)
  const callee = builder.phi(
    join,
    lineage('property'),
    [
      { block: proxyBlock, value: operand(adapted, method) },
      { block: plainBlock, value: operand(plain, method) }
    ],
    method
  )
  builder.call(join, lineage('invocation'), operand(callee, method), null, [], null)
  builder.return(join, null, null)
  const source = builder.seal()
  const body: IrBody = {
    ...source,
    blocks: new Map(
      [...source.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((operation) =>
            operation.kind === 'call' && operation.result?.id === call
              ? { ...operation, closedCallee: { kind: 'exact' as const, functionId: trapFunction } }
              : operation.kind === 'call' && operation.lineage === lineage('invocation')
                ? { ...operation, thisArgument: operand(root, sum) }
                : operation
          )
        }
      ])
    )
  }
  const definitions = new Map<IrValueId, IrOperation>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result !== null) definitions.set(result.id, operation)
    }
  const operation = [...body.blocks.values()]
    .flatMap((block) => block.operations)
    .find((value): value is CallOperation => value.kind === 'call' && value.lineage === lineage('invocation'))!
  const semantic = {
    family: 'invocation',
    internalMethod: 'call',
    results: [{ role: 'value', id: lineage('invocation') }],
    operands: [{ role: 'callee', ordinal: 0, source: { kind: 'result', result: lineage('property') } }]
  } as unknown as SemanticOperation
  const property = {
    family: 'property',
    internalMethod: 'get',
    results: [{ role: 'value', id: lineage('property') }],
    caller: { kind: 'function', functionId: callerFunction },
    operands: [
      { role: 'receiver', ordinal: 0, source: { kind: 'parameter', ordinal: 0 } },
      { role: 'key', ordinal: 0, source: { kind: 'constant', text: 'compress', literal: 'string' } }
    ]
  } as unknown as SemanticOperation
  const input: NonNormalReceiverInput = {
    body,
    bodies: [body, trapBody],
    conversions,
    callables: new Map<IrValueId, CallCalleeIdentity>([[get, { kind: 'exact', functionId: trapFunction }]]),
    definitionOf: (value) => definitions.get(value) ?? null,
    semantic,
    semanticOperationOf: (value) => (value === lineage('property') ? property : null)
  }
  return { input, operation, definitions, trapBody, get, root, selectedKey, call, plain, proxyBlock, plainBlock, trapFunction }
}

test('only the selected Proxy arm is non-normal; the ordinary Function and its real receiver stay live', () => {
  const found = fixture()
  const proof = nonNormalReceiverProofOf(found.operation, found.input)
  assert.ok(proof)
  assert.equal(proof.arms.length, 1)
  assert.equal(proof.arms[0]?.functionId, found.trapFunction)
  assert.equal(proof.arms[0]?.key, 'compress')
  assert.equal(nonNormalReceiverProofMatches({ ...found.operation, nonNormalReceiverProof: proof }, found.input), true)
  assert.equal(found.operation.thisArgument!.value, found.root)
  assert.equal(found.definitions.get(found.plain)?.kind, 'get')
})

test('a bare Proxy witnesses its own checked Function bridge without peeling it as a native alias', () => {
  const found = fixture()
  const selected = [...found.definitions.values()].find((value) => value.kind === 'proxy-part')!
  assert.ok(selected.kind === 'proxy-part' && selected.proxy.representation.kind === 'proxy-object')
  const proxy = selected.proxy.representation
  const handler = proxy.handler
  assert.ok(handler.kind === 'record')
  const trapValue = handler.fields.find((field) => field.key === 'get')!.value
  const method = found.operation.callee.representation
  const abi: CallableAbi = {
    receiver: null,
    parameters: [{ value: proxy, passing: 'by-value', ownership: 'owned' }],
    restFrom: null,
    result: { kind: 'void' }
  }
  const builder = createIrBodyBuilder('direct-proxy-body' as PhysicalBodyId, found.input.body.sourceOwner, abi)
  const entry = builder.openBlock()
  const root = builder.parameter(entry, lineage('root'), 0, proxy)
  const target = builder.proxyPart(entry, lineage('property'), operand(root, proxy), 'target', module)
  const actualHandler = builder.proxyPart(entry, lineage('property'), operand(root, proxy), 'handler', handler)
  const getKey = builder.constant(entry, lineage('property'), 'get', 'string', string)
  const get = builder.get(entry, lineage('property'), operand(actualHandler, handler), operand(getKey, string), trapValue)
  const propertyKey = builder.constant(entry, lineage('property'), 'compress', 'string', string)
  const boxed = [...found.definitions.values()].find((value) => value.kind === 'convert' && value.source.representation.kind === 'string')!
  assert.ok(boxed.kind === 'convert')
  const boxing = found.input.conversions.nodeById(boxed.conversionUse)!
  const key = builder.convert(entry, lineage('property'), boxing.id, operand(propertyKey, string), dynamic)
  const called = builder.call(
    entry,
    lineage('property'),
    operand(get, trapValue),
    null,
    [operand(target, module), operand(key, dynamic)],
    dynamic
  )!
  const bridge = [...found.definitions.values()].find(
    (value) => value.kind === 'convert' && value.source.representation.kind === 'dynamic'
  )!
  assert.ok(bridge.kind === 'convert')
  const callee = builder.convert(entry, lineage('property'), bridge.conversionUse, operand(called, dynamic), method)
  builder.call(entry, lineage('invocation'), operand(callee, method), null, [], null)
  builder.return(entry, null, null)
  const source = builder.seal()
  const body = {
    ...source,
    blocks: new Map(
      [...source.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((value) =>
            value.kind === 'call' && value.result?.id === called
              ? { ...value, closedCallee: { kind: 'exact' as const, functionId: found.trapFunction } }
              : value.kind === 'call' && value.lineage === lineage('invocation')
                ? { ...value, thisArgument: operand(root, proxy) }
                : value
          )
        }
      ])
    )
  }
  const definitions = new Map<IrValueId, IrOperation>()
  for (const block of body.blocks.values())
    for (const value of block.operations) {
      const result = resultOfIrOperation(value)
      if (result !== null) definitions.set(result.id, value)
    }
  const operation = [...body.blocks.values()]
    .flatMap((block) => block.operations)
    .find((value): value is CallOperation => value.kind === 'call' && value.lineage === lineage('invocation'))!
  const input: NonNormalReceiverInput = {
    ...found.input,
    body,
    bodies: [body, found.trapBody],
    definitionOf: (id) => definitions.get(id) ?? null,
    callables: new Map([[get, { kind: 'exact', functionId: found.trapFunction }]])
  }
  assert.ok(nonNormalReceiverProofOf(operation, input))
})

test('missing, forged and unrelated-receiver receipts cannot suppress the erased receiver demand', () => {
  const found = fixture()
  const proof = nonNormalReceiverProofOf(found.operation, found.input)
  assert.ok(proof)
  assert.equal(nonNormalReceiverProofMatches(found.operation, found.input), false)
  assert.equal(
    nonNormalReceiverProofMatches({ ...found.operation, nonNormalReceiverProof: { ...proof, conversions: [] } }, found.input),
    false
  )
  assert.equal(
    nonNormalReceiverProofOf(
      { ...found.operation, thisArgument: { ...found.operation.thisArgument!, value: 'other-same-shaped-receiver' as never } },
      found.input
    ),
    undefined
  )
})

test('a different trap Function or an ambiguous physical source body is not the authenticated call entry', () => {
  const found = fixture()
  assert.equal(
    nonNormalReceiverProofOf(found.operation, {
      ...found.input,
      callables: new Map([[found.get, { kind: 'exact', functionId: 'other' as FunctionId }]])
    }),
    undefined
  )
  assert.equal(
    nonNormalReceiverProofOf(found.operation, {
      ...found.input,
      bodies: [found.input.body, found.trapBody, { ...found.trapBody, owner: 'another-copy' as PhysicalBodyId }]
    }),
    undefined
  )
})

test('a live returning trap key and a wrong semantic property key retain unsupported Proxy calls', () => {
  const found = fixture()
  const definition = found.definitions.get(found.selectedKey)!
  const changed = new Map(found.definitions).set(found.selectedKey, { ...definition, text: 'kModuleError' } as IrOperation)
  const property = found.input.semanticOperationOf(lineage('property'))!
  const semanticOperationOf = () => ({
    ...property,
    operands: property.operands.map((value) =>
      value.role === 'key' ? { ...value, source: { kind: 'constant' as const, literal: 'string' as const, text: 'kModuleError' } } : value
    )
  })
  assert.equal(
    nonNormalReceiverProofOf(found.operation, { ...found.input, definitionOf: (id) => changed.get(id) ?? null, semanticOperationOf }),
    undefined
  )
  assert.equal(nonNormalReceiverProofOf(found.operation, { ...found.input, definitionOf: (id) => changed.get(id) ?? null }), undefined)
})

test('swapping the Proxy branch and removing its own SSA input cannot borrow another arm’s completion', () => {
  const found = fixture()
  const entry = found.input.body.blocks.get(found.input.body.entry)!
  assert.equal(entry.terminator.kind, 'branch')
  const end = entry.terminator
  assert.ok(end.kind === 'branch')
  const body = {
    ...found.input.body,
    blocks: new Map(found.input.body.blocks).set(entry.id, {
      ...entry,
      terminator: { ...end, whenTrue: found.plainBlock, whenFalse: found.proxyBlock }
    })
  }
  assert.equal(nonNormalReceiverProofOf(found.operation, { ...found.input, body }), undefined)
  assert.equal(
    nonNormalReceiverProofOf(found.operation, {
      ...found.input,
      definitionOf: (id) => (id === found.call ? null : (found.definitions.get(id) ?? null))
    }),
    undefined
  )
})
