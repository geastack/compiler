import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../representation/model.js'
import { absenceComparisonText, definedTestText, presenceTestText } from './emit-presence.js'
import { strictEqualityText } from './emit-equality.js'

const reference: Representation = {
  kind: 'class-ref',
  declaration: 'native-presence' as never,
  shapeId: 'native-presence',
  ownership: 'shared-refcount',
  ancestors: []
}
const wrapped: Representation = { kind: 'optional', payload: reference, absence: 'undefined' }
const union: Representation = {
  kind: 'tagged-union',
  arms: [wrapped, { kind: 'string' } as Representation].map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `presence-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
}

test('definedness and nullish presence recurse into optional native references in union arms', () => {
  const defined = definedTestText('value', union)
  assert.ok(defined.includes('is<0>()'))
  assert.ok(defined.includes('has_value()'))
  assert.ok(defined.includes('isUndefined()'))
  const present = presenceTestText('value', union)
  assert.ok(present.includes('is<0>()'))
  assert.ok(present.includes('has_value()'))
  assert.ok(present.includes('static_cast<bool>'))
})

test('strict comparisons distinguish a native null payload from undefined inside a union optional', () => {
  const value = { text: 'value', representation: union }
  const isNull = absenceComparisonText('===', value, { text: 'nullptr', representation: { kind: 'null' } })
  const isUndefined = absenceComparisonText('===', value, { text: 'undefined', representation: { kind: 'undefined' } })
  assert.ok(isNull?.includes('== nullptr'))
  assert.ok(isUndefined?.includes('isUndefined()'))
  assert.ok(isNull?.includes('has_value()'))
  assert.ok(isUndefined?.includes('has_value()'))
})

test('two optional carriers compare payload absence with outer absence in both directions', () => {
  const equality = strictEqualityText('===', { text: 'left', representation: wrapped }, { text: 'right', representation: wrapped })
  assert.ok(equality)
  assert.ok(equality.includes('(*left).isUndefined()'))
  assert.ok(equality.includes('(*right).isUndefined()'))
})
