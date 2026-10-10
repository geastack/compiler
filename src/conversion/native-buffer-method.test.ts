import assert from 'node:assert/strict'
import test from 'node:test'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeUnboundMethodText } from '../targets/cpp/emit-native-method.js'
import { nativeBufferMethodValueText } from '../targets/cpp/emit-buffers.js'
import type { Representation } from '../representation/model.js'
import { nativeBufferMethodDescriptorOf, nativeBufferUnboundMethodContractOf } from './native-buffer-method.js'
import { createConversionNodes } from './nodes.js'
import { methodConversionInputsOf, methodValueRecipesMatch } from '../ir/publish-conversion-recipes.js'
import { operationConversionInputsOf, operationConversionsOf } from '../ir/operation-conversions.js'
import type { GetOperation } from '../ir/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const ordinary: Representation = { kind: 'array-buffer', ownership: 'shared-refcount' }
const shared: Representation = { kind: 'shared-array-buffer', ownership: 'shared-refcount' }
const result: Representation = {
  kind: 'tagged-union',
  arms: [ordinary, shared].map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
}
const target: Representation = {
  kind: 'function-value-dispatch',
  abi: {
    receiver: null,
    parameters: [
      { value: number, passing: 'by-value', ownership: 'owned' },
      { value: { kind: 'optional', payload: number, absence: 'undefined' }, passing: 'by-value', ownership: 'owned' }
    ],
    result,
    restFrom: null
  }
}

test('buffer slice getters publish their native brand and physical result without admitting arbitrary script receiver erasure', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const receiver of [ordinary, shared]) {
    const descriptor = nativeBufferMethodDescriptorOf(receiver, 'slice', target)
    assert.ok(descriptor)
    assert.equal(descriptor.abi.receiver, receiver)
    assert.equal(descriptor.physicalResult, receiver)
    assert.equal(census.nativeMethodFor(descriptor.source, target), null)
    assert.equal(census.nodeFor(descriptor.source, target).capability.kind, 'never')
    const approved = census.nativeBufferMethodFor(descriptor.source, target)
    assert.ok(approved?.capability.kind === 'static')
    const contract = nativeBufferUnboundMethodContractOf(descriptor.source, target)
    assert.ok(contract)
    assert.equal(contract.receiverRequirement, 'present-native-brand')
    const text = nativeUnboundMethodText(contract, 'gea_source_slice')
    assert.ok(text.includes('unboundMethodAs'))
    assert.ok(text.includes('gea_receiver.is<'))
    assert.ok(text.includes('throwRuntimeError("TypeError"'))
    assert.ok(!text.includes('bindReceiver'))
  }
})

test('only fixed numeric slice frames on the two shared native buffer brands receive intrinsic descriptors', () => {
  assert.equal(nativeBufferMethodDescriptorOf(ordinary, 'resize', target), null)
  assert.equal(nativeBufferMethodDescriptorOf({ kind: 'array-buffer', ownership: 'owned' }, 'slice', target), null)
  assert.equal(nativeBufferMethodDescriptorOf({ kind: 'scalar', domain: 'number' }, 'slice', target), null)
  assert.equal(nativeBufferMethodDescriptorOf(ordinary, 'slice', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }), null)
})

test('a declined intrinsic getter never materializes a host class or another unrelated receiver', () => {
  const receiver: Representation = { kind: 'scalar', domain: 'number' }
  const get: GetOperation = {
    kind: 'get',
    lineage: 'other-get' as never,
    receiver: { value: 'other' as never, representation: receiver },
    key: { value: 'key' as never, representation: { kind: 'string' } },
    result: { id: 'value' as never, representation: target }
  }
  assert.equal(
    nativeBufferMethodValueText(
      {} as never,
      get,
      receiver,
      () => {
        throw new Error('this receiver has no materialized host value')
      },
      'assign',
      target
    ),
    null
  )
})

test('buffer union reads certify each intrinsic source and each physical result arm before rendering', () => {
  const operation: GetOperation = {
    kind: 'get',
    lineage: 'slice-read' as never,
    receiver: { value: 'buffer' as never, representation: result },
    key: { value: 'slice-key' as never, representation: { kind: 'string' } },
    result: { id: 'slice' as never, representation: target }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const methods = methodConversionInputsOf(operation, 'slice', new Map(), new Map())
  assert.equal(methods.length, 2)
  const recipes = methods.map((method) => ({ ...method, conversion: census.nativeBufferMethodFor(method.source, method.target)!.id }))
  assert.equal(methodValueRecipesMatch(methods, recipes, census), true)
  assert.equal(
    methodValueRecipesMatch(
      methods,
      recipes.map(({ builtin: _, ...recipe }) => recipe),
      census
    ),
    false
  )
  const inputs = operationConversionInputsOf(operation, 'slice', {} as RepresentationDeriver, new Map())
  assert.deepEqual(
    inputs.map((input) => input.role),
    ['buffer-method-result', 'buffer-method-result']
  )
  assert.ok(operationConversionsOf(inputs, census).every((recipe) => census.nodeById(recipe.conversion)?.capability.kind !== 'never'))
})
