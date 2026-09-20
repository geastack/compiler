import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../representation/model.js'
import { strictEqualityText } from './emit-equality.js'

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
