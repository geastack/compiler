import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { IrValueId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeIteratorFieldReadOf, nativeIteratorFieldReadMatches } from './native-iterator-field-views.js'

const result: Representation = { kind: 'string' }
const abi: CallableAbi = { receiver: null, parameters: [], result, restFrom: null }
const publicMethod: Representation = { kind: 'function-value-dispatch', abi }
const physicalMethod: Representation = {
  kind: 'function-value-dispatch',
  abi: { ...abi, receiver: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
}
const carrier: Representation = {
  kind: 'record',
  shapeId: 'public-cursor',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [
    { key: 'next', value: publicMethod, required: true },
    { key: 'return', value: publicMethod, required: true }
  ]
}
const receiver = { value: 'cursor' as IrValueId, representation: carrier }
const deriver = {} as RepresentationDeriver
const census = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const flow = {
  nativeFieldStorageValues: new Map([
    [
      receiver.value,
      new Map([
        ['next', [physicalMethod]],
        ['return', [physicalMethod]]
      ])
    ]
  ]),
  nativeAccessorStorageValues: new Map(),
  nativeFieldMethodValues: new Map()
}

test('next and implicit return reads seal their exact physical method frame separately from the yielded value', () => {
  const conversions = census()
  const next = nativeIteratorFieldReadOf(receiver, 'next', deriver, new Map(), flow, conversions)
  const close = nativeIteratorFieldReadOf(receiver, 'return', deriver, new Map(), flow, conversions)
  assert.ok(next)
  assert.ok(close)
  assert.deepEqual(next.value, publicMethod)
  assert.equal(next.read.sources[0]?.conversion, conversions.nativeMethodFor(physicalMethod, publicMethod)?.id)
  assert.equal(next.read.key, 'next')
  assert.equal(close.read.key, 'return')
  assert.equal(nativeIteratorFieldReadMatches(next, close), false)
  assert.equal(nativeIteratorFieldReadMatches(next, { ...next, value: physicalMethod }), false)
  assert.equal(nativeIteratorFieldReadMatches(next, { ...next, read: { ...next.read, receiver: 'other-cursor' as IrValueId } }), false)
})

test('a public protocol signature alone cannot invent the original allocation or a readable slot', () => {
  const empty = { nativeFieldStorageValues: new Map(), nativeAccessorStorageValues: new Map(), nativeFieldMethodValues: new Map() }
  assert.equal(nativeIteratorFieldReadOf(receiver, 'next', deriver, new Map(), empty, census()), null)
  const unknown = {
    ...flow,
    nativeFieldStorageValues: new Map([
      [receiver.value, new Map([['next', [{ kind: 'unresolved', reason: 'no stored method proof' } as Representation]]])]
    ])
  }
  assert.equal(nativeIteratorFieldReadOf(receiver, 'next', deriver, new Map(), unknown, census()), null)
})
