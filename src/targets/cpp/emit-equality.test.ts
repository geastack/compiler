import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../representation/model.js'
import { strictEqualityText } from './emit-equality.js'
import { typeofAnswersFor } from './emit-typeof.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const callable = (receiver: Representation | null): Representation => ({
  kind: 'function-value-dispatch',
  abi: { receiver, parameters: [{ value: number, ownership: 'owned', passing: 'by-value' }], result: number, restFrom: null }
})
const first = callable({ kind: 'class-ref', declaration: 'First' as never, shapeId: 'first', ownership: 'shared-refcount', ancestors: [] })
const second = callable({
  kind: 'class-ref',
  declaration: 'Second' as never,
  shapeId: 'second',
  ownership: 'shared-refcount',
  ancestors: []
})
const callback = callable(null)
const sum = (values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const union = sum([first, second])

test('callable union compares preserved identity against a different receiver ABI in either operand order', () => {
  for (const [left, right] of [
    [
      { text: 'methods', representation: union },
      { text: 'callback', representation: callback }
    ],
    [
      { text: 'callback', representation: callback },
      { text: 'methods', representation: union }
    ]
  ]) {
    const output = strictEqualityText('===', left!, right!)
    assert.ok(output)
    assert.ok(output.includes('methods.is<0>()'))
    assert.ok(output.includes('methods.is<1>()'))
    assert.ok(output.includes('functionObject'))
    assert.ok(output.includes('callback'))
    assert.notEqual(output, 'false')
  }
})

test('a matching callable ABI does not hide another union arm with the same function identity', () => {
  const output = strictEqualityText('!==', { text: 'methods', representation: union }, { text: 'callback', representation: first })
  assert.ok(output)
  assert.ok(output.includes('methods.is<0>()'))
  assert.ok(output.includes('methods.is<1>()'))
  assert.ok(output.startsWith('!('))
})

test('two callable unions compare identity within and across different ABI arms', () => {
  const output = strictEqualityText('===', { text: 'left', representation: union }, { text: 'right', representation: union })
  assert.ok(output)
  for (const left of [0, 1]) for (const right of [0, 1]) assert.ok(output.includes(`left.is<${left}>() && right.is<${right}>()`))
  assert.ok(output.includes('functionObject'))
})

test('function and primitive union arms remain distinct JavaScript types', () => {
  assert.equal(strictEqualityText('===', { text: 'methods', representation: union }, { text: 'number', representation: number }), 'false')
})

test('native references keep both possible typeof answers without poisoning disjoint primitive union comparisons', () => {
  const ref: Representation = {
    kind: 'class-ref',
    declaration: 'Box' as never,
    shapeId: 'box',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const string: Representation = { kind: 'string' }
  assert.deepEqual(typeofAnswersFor(ref), ['undefined', 'object'])
  assert.equal(
    strictEqualityText('===', { text: 'ref', representation: ref }, { text: 'absent', representation: { kind: 'undefined' } }),
    'ref.isUndefined()'
  )
  const values: Representation = { kind: 'optional', payload: sum([string, number, ref]), absence: 'undefined' }
  const keys = sum([string, number])
  for (const [left, right] of [
    [values, keys],
    [keys, values]
  ]) {
    const output = strictEqualityText('===', { text: 'left', representation: left! }, { text: 'right', representation: right! })
    assert.ok(output)
    assert.ok(output.includes('has_value()'))
    assert.ok(output.includes('get<0>()'))
    assert.ok(output.includes('get<1>()'))
  }
  assert.equal(typeofAnswersFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }), null)
})

test('a shared record and differently shaped native view compare their certified origin without a conversion', () => {
  const record: Representation = {
    kind: 'record',
    shapeId: 'original',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'shown', value: { kind: 'string' }, required: true }]
  }
  const view: Representation = { kind: 'native-record-ref', shapeId: 'wider-view', native: null, ownership: 'shared-refcount' }
  const convert = (): never => {
    throw new Error('object identity must not recast or box either allocation')
  }
  assert.equal(
    strictEqualityText('===', { text: 'original()', representation: record }, { text: 'view()', representation: view }, convert),
    'original() == view()'
  )
  const union = sum([record, view])
  const output = strictEqualityText('===', { text: 'left', representation: union }, { text: 'right', representation: union }, convert)
  assert.ok(output?.includes('left.is<0>() && right.is<1>()'))
  assert.ok(output?.includes('left.is<1>() && right.is<0>()'))
  assert.equal(
    strictEqualityText(
      '===',
      { text: 'owned', representation: { ...record, ownership: 'owned' } },
      { text: 'view', representation: view },
      convert
    ),
    null
  )
})
