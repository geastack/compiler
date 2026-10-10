import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId, OperationId, SemanticResultId } from '../identity/ids.js'
import { callableOriginsOf } from './callable-origins.js'
import type { SemanticGraph } from './model/graph.js'
import type { SemanticOperation } from './model/operations.js'
import { identityOperandOf, type SemanticOperand } from './model/operands.js'

const source = (role: string, result: string, provenance = false): SemanticOperand =>
  ({
    role,
    ordinal: 0,
    source: { kind: 'result', result: result as SemanticResultId },
    evaluation: { kind: provenance ? 'provenance' : 'runtime' }
  }) as SemanticOperand

const operation = (id: string, facts: object, operands: readonly SemanticOperand[] = []): SemanticOperation =>
  ({ id: id as OperationId, ...facts, operands, results: [{ id: id as SemanticResultId, role: 'value' }] }) as unknown as SemanticOperation

const allocation = (id: string): SemanticOperation =>
  operation(id, { family: 'allocation', allocated: 'function-object', callable: `${id}-body` as FunctionId })

const graphOf = (operations: readonly SemanticOperation[]): SemanticGraph => ({
  operations: new Map(operations.map((operation) => [operation.id, operation])),
  results: new Map(operations.flatMap((operation) => operation.results.map((result) => [result.id, operation.id] as const))),
  regions: new Map(),
  structuralTypes: new Map(),
  edges: [],
  coverage: new Map()
})

test('plain assignment and comma identity reach binding cells regardless of operation table order', () => {
  const graph = graphOf([
    operation('read', { family: 'binding', action: 'read', declaration: 'cell' }),
    operation('initialize', { family: 'binding', action: 'initialize', declaration: 'cell' }, [source('initializer', 'comma')]),
    operation('comma', { family: 'computation', form: 'comma', operator: ',' }, [
      source('left', 'other'),
      source('right', 'assignment'),
      source('receiver', 'other', true)
    ]),
    operation('assignment', { family: 'computation', form: 'assignment', operator: '=' }, [source('value', 'native')]),
    allocation('other'),
    allocation('native')
  ])
  const origins = callableOriginsOf(graph)
  for (const id of ['assignment', 'comma', 'initialize', 'read']) assert.equal(origins.get(id as SemanticResultId), 'native-body')
  assert.equal(origins.get('other' as SemanticResultId), 'other-body')
})

test('operators, conditional choices, unknown values and conflicting binding writes do not invent Function provenance', () => {
  const graph = graphOf([
    allocation('first'),
    allocation('second'),
    ...(['binary', 'logical', 'conditional', 'update'] as const).map((form) =>
      operation(form, { family: 'computation', form, operator: form }, [source('left', 'first'), source('right', 'second')])
    ),
    operation('unknown-assignment', { family: 'computation', form: 'assignment', operator: '=' }, [source('value', 'parameter')]),
    operation('initialize', { family: 'binding', action: 'initialize', declaration: 'cell' }, [source('initializer', 'first')]),
    operation('write', { family: 'binding', action: 'write', declaration: 'cell' }, [source('value', 'second')]),
    operation('read', { family: 'binding', action: 'read', declaration: 'cell' })
  ])
  const origins = callableOriginsOf(graph)
  for (const id of ['binary', 'logical', 'conditional', 'update', 'unknown-assignment', 'initialize', 'write', 'read'])
    assert.equal(origins.has(id as SemanticResultId), false)
})

test('property stores preserve the receiver identity instead of the stored Function identity', () => {
  const stores = (['set', 'define-own-property'] as const).map((internalMethod) =>
    operation(internalMethod, { family: 'property', internalMethod }, [source('receiver', 'receiver'), source('value', 'stored')])
  )
  const objectStore = operation('object-store', { family: 'property', internalMethod: 'set' }, [
    source('receiver', 'ordinary-object'),
    source('value', 'stored')
  ])
  const origins = callableOriginsOf(graphOf([allocation('receiver'), allocation('stored'), ...stores, objectStore]))
  for (const store of stores) {
    assert.equal(origins.get(store.results[0]!.id), 'receiver-body')
    assert.equal(identityOperandOf(store)?.source.kind, 'result')
    assert.deepEqual(identityOperandOf(store)?.source, { kind: 'result', result: 'receiver' })
  }
  assert.equal(origins.has('object-store' as SemanticResultId), false)
})
