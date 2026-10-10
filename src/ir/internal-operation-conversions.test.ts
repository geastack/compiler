import assert from 'node:assert/strict'
import test from 'node:test'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import { internalOperationConversionInputsOf } from './internal-operation-conversions.js'
import { operationConversionInputsOf } from './operation-conversions.js'
import type { IrOperation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
const operand = (representation: Representation) => ({ value: 'value' as never, representation })
const result = (representation: Representation) => ({ id: 'result' as never, representation })
const deriver = {} as RepresentationDeriver

test('iterator exhaustion has its own undefined recipe, while same-carrier steps need none', () => {
  const cursor: Representation = {
    kind: 'iterator',
    source: 'sequence',
    element: number,
    completion: { kind: 'undefined' },
    resume: { kind: 'undefined' }
  }
  const operation: Extract<IrOperation, { kind: 'iterator-next' }> = {
    kind: 'iterator-next',
    lineage: 'operation' as never,
    iterator: operand(cursor),
    value: null,
    result: result(optional)
  }
  const inputs = internalOperationConversionInputsOf(operation, deriver)
  assert.deepEqual(
    inputs.map((input) => input.source),
    [{ kind: 'undefined' }, number]
  )
  assert.ok(inputs.every((input) => input.target === optional))
  assert.deepEqual(internalOperationConversionInputsOf({ ...operation, result: result(number) }, deriver), [])
})

test('an array spread certifies the actual source element rather than the source array', () => {
  const source: Representation = { kind: 'array-object', element: optional, ownership: 'shared-refcount', extension: null }
  const operation: IrOperation = {
    kind: 'allocate-array-object',
    lineage: 'operation' as never,
    elements: [{ kind: 'spread', value: operand(source), from: 2, element: number }],
    result: result({ kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null })
  }
  const [input] = internalOperationConversionInputsOf(operation, deriver)
  assert.ok(input)
  assert.equal(input.source, optional)
  assert.equal(input.target, number)
  assert.equal(input.role, 'array-element')
})

test('await publication keeps every fulfillment and absence branch', () => {
  const target: Representation = {
    kind: 'tagged-union',
    arms: [number, string, { kind: 'undefined' } as Representation].map((value, index) => ({
      value,
      tag: String(index),
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const source: Representation = {
    kind: 'optional',
    absence: 'undefined',
    payload: {
      kind: 'tagged-union',
      arms: [number, string].map((value, index) => ({
        value: { kind: 'promise', value },
        tag: String(index),
        semanticType: String(index) as never,
        runtimeDiscriminator: { kind: 'carrier' }
      }))
    }
  }
  const operation: Extract<IrOperation, { kind: 'await' }> = {
    kind: 'await',
    lineage: 'operation' as never,
    operand: operand(source),
    result: result(target)
  }
  const inputs = internalOperationConversionInputsOf(operation, deriver)
  assert.deepEqual(
    inputs.map((input) => input.source),
    [number, string, { kind: 'undefined' }]
  )
  assert.ok(inputs.every((input) => input.target === target && input.role === 'await-result'))
  assert.deepEqual(internalOperationConversionInputsOf({ ...operation, result: null }, deriver), [])
  assert.deepEqual(internalOperationConversionInputsOf({ ...operation, operand: operand(number), result: result(optional) }, deriver), [
    { role: 'await-result', source: number, target: optional }
  ])
  assert.deepEqual(
    internalOperationConversionInputsOf({ ...operation, operand: operand(number), result: result({ kind: 'void' }) }, deriver),
    []
  )
})

test('a keyed collection get certifies the storage optional into the published union', () => {
  const collection: Representation = { kind: 'keyed-collection', family: 'map', key: string, value: number, ownership: 'shared-refcount' }
  const published: Representation = {
    kind: 'tagged-union',
    arms: [number, string, { kind: 'undefined' } as Representation].map((value, index) => ({
      tag: String(index),
      semanticType: String(index) as never,
      value,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const method: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: collection,
      parameters: [{ value: string, ownership: 'owned', passing: 'by-value' }],
      result: optional,
      restFrom: null
    }
  }
  const read = {
    kind: 'get',
    lineage: 'read' as never,
    receiver: operand(collection),
    key: { value: 'key' as never, representation: string },
    result: result(method)
  } as unknown as IrOperation
  const key = { kind: 'constant', literal: 'string', text: 'get', result: result(string) } as unknown as IrOperation
  const call = {
    kind: 'call',
    lineage: 'call' as never,
    callee: { value: 'callee' as never, representation: method },
    receiver: null,
    arguments: [operand(string)],
    result: result(published)
  } as unknown as IrOperation
  const definitionOf = (value: unknown): IrOperation | null => (value === 'callee' ? read : value === 'key' ? key : null)
  assert.deepEqual(internalOperationConversionInputsOf(call, deriver, undefined, undefined, definitionOf as never), [])
  const inputs = operationConversionInputsOf(call, null, deriver, new Map(), false, undefined, definitionOf as never)
  assert.deepEqual(
    inputs.map((input) => [input.role, input.source]),
    [['prototype-result', { kind: 'optional', payload: number, absence: 'undefined' }]]
  )
})
