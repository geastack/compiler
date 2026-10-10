import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { BindingOperation, PropertyOperation, SemanticOperation } from '../semantics/model/operations.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import { valueRecordTypesOf } from './value-records.js'

const binding = (name: string, declaration: string, type: StructuralTypeId, source?: StructuralTypeId): BindingOperation => ({
  id: name as OperationId,
  family: 'binding',
  caller: { kind: 'region', regionId: 'module' as never },
  action: source === undefined ? 'read' : 'initialize',
  declaration: declaration as DeclarationId,
  mutable: true,
  temporalDeadZone: false,
  operands:
    source === undefined
      ? []
      : [{ role: 'initializer', ordinal: 0, type: source, source: { kind: 'parameter', ordinal: 0 }, evaluation: { kind: 'runtime' } }],
  results: [{ id: `${name}-result` as SemanticResultId, role: 'value', type }],
  completion: normalCompletion,
  effects: pureEffects,
  evaluationOrdinal: 0
})

const mutation = (type: StructuralTypeId): PropertyOperation => ({
  id: 'mutation' as OperationId,
  family: 'property',
  caller: { kind: 'region', regionId: 'module' as never },
  internalMethod: 'set',
  strict: true,
  descriptor: null,
  keyIsComputed: false,
  operands: [{ role: 'receiver', ordinal: 0, type, source: { kind: 'parameter', ordinal: 0 }, evaluation: { kind: 'runtime' } }],
  results: [],
  completion: normalCompletion,
  effects: { ...pureEffects, writesMutableState: true },
  evaluationOrdinal: 0
})

const fixture = () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const object = (keys: readonly string[], accessor = false) =>
    table.intern({
      kind: 'object',
      members: keys.map((key) => ({
        key: { kind: 'string', value: key },
        type: string,
        optional: false,
        readonly: false,
        accessor: accessor ? { getter: 'getter' as DeclarationId, setter: null } : null
      })),
      index: [],
      membersDropped: false
    })
  const original = object(['shown', 'hidden'])
  const view = object(['shown'])
  const getter = object(['shown'], true)
  const graph = (...operations: SemanticOperation[]): SemanticGraph => ({
    structuralTypes: table.seal(),
    regions: new Map(),
    operations: new Map(operations.map((operation) => [operation.id, operation])),
    edges: [],
    coverage: new Map(),
    results: new Map(operations.flatMap((operation) => operation.results.map((result) => [result.id, operation.id])))
  })
  return { table, graph, original, view, getter }
}

test('a narrower binding read remains shared when another view of its exact cell mutates the object', () => {
  const { graph, original, view } = fixture()
  const values = valueRecordTypesOf(
    graph(
      binding('source', 'source-cell', original),
      binding('narrow-read', 'source-cell', view),
      binding('chain', 'chain-cell', view, view),
      mutation(original)
    )
  )
  assert.equal(values.has(original), false)
  assert.equal(values.has(view), false)
})

test('an accessor-backed source cannot be sampled into a primitive record at binding or through a second alias', () => {
  const { graph, getter, view } = fixture()
  const values = valueRecordTypesOf(graph(binding('view', 'view-cell', view, getter), binding('chain', 'chain-cell', view, view)))
  assert.equal(values.has(view), false)
})

test('immutable primitive data aliases retain the by-value optimization', () => {
  const { graph, original, view } = fixture()
  const values = valueRecordTypesOf(graph(binding('view', 'view-cell', view, original), binding('chain', 'chain-cell', view, view)))
  assert.equal(values.has(original), true)
  assert.equal(values.has(view), true)
})
