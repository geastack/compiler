import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { CallOperation, GetOperation, IrOperand, IrOperation } from './model.js'
import { nativeArrayInsertionOf } from './native-array-insertion.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const lineage = 'native-array-insertion-test' as never
const frame: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const functionValue: Representation = { kind: 'function-value-dispatch', abi: frame }
const arrayOf = (element: Representation): Extract<Representation, { kind: 'array-object' }> => ({
  kind: 'array-object',
  element,
  ownership: 'shared-refcount',
  extension: null
})
const operand = (id: string, representation: Representation): IrOperand => ({ value: id as never, representation })
const fixture = (source = functionValue, target = functionValue) => {
  const receiver = arrayOf(target)
  const read: GetOperation = {
    kind: 'get',
    lineage,
    receiver: operand('array', receiver),
    key: operand('key', { kind: 'string' }),
    result: { id: 'method' as never, representation: functionValue }
  }
  const key: IrOperation = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'push',
    result: { id: 'key' as never, representation: { kind: 'string' } }
  }
  const call: CallOperation = {
    kind: 'call',
    lineage,
    callee: operand('method', functionValue),
    receiver: null,
    thisArgument: operand('array', receiver),
    arguments: [operand('packed', arrayOf(source))],
    result: { id: 'length' as never, representation: number }
  }
  const definitions = new Map<string, IrOperation>([
    ['method', read],
    ['key', key]
  ])
  return { read, call, definitions, definitionOf: (id: string) => definitions.get(id) ?? null }
}

test('a bulk insert follows its exact native member, packed element and supplied receiver', () => {
  const { call, definitionOf, read } = fixture()
  const plan = nativeArrayInsertionOf(call, definitionOf, new Map())
  assert.equal(plan?.read, read)
  assert.equal(plan?.conversion, null)
  assert.equal(
    nativeArrayInsertionOf({ ...call, thisArgument: operand('another-array', read.receiver.representation) }, definitionOf, new Map()),
    null
  )
  assert.equal(nativeArrayInsertionOf({ ...call, arguments: [operand('worker', functionValue)] }, definitionOf, new Map()), null)
  const shadowed = {
    ...read,
    receiver: operand('array', {
      ...read.receiver.representation,
      extension: [{ key: 'push', value: functionValue, required: true }]
    } as Representation)
  }
  assert.equal(
    nativeArrayInsertionOf(call, (id) => (id === 'method' ? shadowed : definitionOf(id)), new Map()),
    null
  )
})

test('different packed Function frames need the exact cited identity-preserving adapter', () => {
  const extended: Representation = {
    kind: 'function-value-dispatch',
    abi: { ...frame, parameters: [{ value: number, ownership: 'owned', passing: 'by-value' }] }
  }
  const { call, definitionOf } = fixture(functionValue, extended)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(functionValue, extended)
  assert.notEqual(node.capability.kind, 'never')
  assert.equal(nativeArrayInsertionOf(call, definitionOf, new Map(), census), null)
  const cited: CallOperation = {
    ...call,
    conversionRecipes: [{ role: 'prototype-argument', source: functionValue, target: extended, conversion: node.id }]
  }
  assert.equal(nativeArrayInsertionOf(cited, definitionOf, new Map(), census)?.conversion, node)
  const wrong = census.nodeFor(number, { kind: 'string' })
  assert.equal(
    nativeArrayInsertionOf(
      { ...cited, conversionRecipes: [{ role: 'prototype-argument', source: functionValue, target: extended, conversion: wrong.id }] },
      definitionOf,
      new Map(),
      census
    ),
    null
  )
})
