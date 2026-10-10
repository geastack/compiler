import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { PropertyOperation } from '../semantics/model/operations.js'
import { computedPropertyKeyTextsOf } from './typed-property-access.js'

const graph = {
  structuralTypes: new Map([
    ['text', { shape: { kind: 'literal', primitive: 'string', text: 'text' } }],
    ['size', { shape: { kind: 'literal', primitive: 'string', text: 'size' } }],
    ['either', { shape: { kind: 'union', members: ['text', 'size'] } }],
    ['unknown', { shape: { kind: 'primitive', primitive: 'string' } }]
  ])
} as unknown as SemanticGraph
const operation = (type: string, provenKeyTexts?: readonly string[]): PropertyOperation =>
  ({
    keyIsComputed: true,
    operands: [{ role: 'key', ordinal: 0, type }],
    ...(provenKeyTexts === undefined ? {} : { provenKeyTexts })
  }) as unknown as PropertyOperation

test('a generic copy publishes its exact literal key domain instead of the unspecialized source union', () => {
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('text', ['text', 'size'])), ['text'])
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('size', ['text', 'size'])), ['size'])
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('either', ['text', 'size'])), ['size', 'text'])
})

test('unknown key types retain the sealed domain and two independent finite proofs intersect', () => {
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('unknown', ['text'])), ['text'])
  assert.equal(computedPropertyKeyTextsOf(graph, operation('unknown')), undefined)
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('either', ['text'])), ['text'])
  assert.deepEqual(computedPropertyKeyTextsOf(graph, operation('text')), ['text'])
})
