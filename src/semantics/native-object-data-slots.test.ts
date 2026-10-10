import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { nativeObjectDataSlotSchemasOf } from './native-object-data-slots.js'
import { nativeObjectDataExtensionSchemaAt, nativeObjectDataStorageOf } from '../projection/native-object-data.js'
import type { SemanticGraph } from './model/graph.js'
import type {
  SemanticOperation,
  AllocationOperation,
  BindingOperation,
  PropertyOperation,
  InvocationOperation,
  ComputationOperation
} from './model/operations.js'
import { normalCompletion, pureEffects, type SemanticOperand, type SemanticOperationBase } from './model/operands.js'
import { createStructuralTypeTable } from './model/structural-type-table.js'
import type { Representation } from '../representation/model.js'

const table = createStructuralTypeTable()
const text = table.intern({ kind: 'primitive', primitive: 'string' })
const number = table.intern({ kind: 'primitive', primitive: 'number' })
const any = table.intern({ kind: 'primitive', primitive: 'any' })
const object = table.intern({ kind: 'object', members: [], index: [], membersDropped: false })
const signature = table.intern({
  kind: 'signature',
  call: [{ parameters: [], minimumArity: 0, thisParameter: null, result: number }],
  construct: []
})
const indexed = table.intern({
  kind: 'object',
  members: [],
  index: [{ key: 'string', value: number, readonly: false }],
  membersDropped: false
})
const accessor = table.intern({
  kind: 'object',
  members: [
    {
      key: { kind: 'string', value: 'read' },
      type: number,
      optional: false,
      readonly: false,
      accessor: { getter: 'native-extension-getter' as DeclarationId, setter: null }
    }
  ],
  index: [],
  membersDropped: false
})
const dropped = table.intern({ kind: 'object', members: [], index: [], membersDropped: true })
const intersection = (resolved: StructuralTypeId | null) =>
  table.intern({ kind: 'intersection', members: resolved === null ? [object, signature] : [object, resolved], declaration: null, resolved })
const dataIntersection = intersection(object)
const indexedIntersection = intersection(indexed)
const accessorIntersection = intersection(accessor)
const droppedIntersection = intersection(dropped)
const unresolvedIntersection = intersection(null)
const types = table.seal()
const input = (role: string, id: string, type = object, ordinal = 0): SemanticOperand => ({
  role,
  ordinal,
  type,
  source: { kind: 'result', result: id as SemanticResultId },
  evaluation: { kind: 'runtime' }
})
const literal = (role: string, value: string, kind: 'string' | 'number' = 'string', ordinal = 0): SemanticOperand => ({
  role,
  ordinal,
  type: kind === 'string' ? text : number,
  source: { kind: 'constant', literal: kind, text: value },
  evaluation: { kind: 'runtime' }
})
const base = (id: string, operands: readonly SemanticOperand[], type = object): SemanticOperationBase => ({
  id: id as OperationId,
  caller: { kind: 'function', functionId: 'native-extension-fixture' as FunctionId },
  operands,
  results: [{ id: id as SemanticResultId, role: 'value', type }],
  evaluationOrdinal: 0,
  completion: normalCompletion,
  effects: pureEffects
})
const allocation = (id: string, callable: FunctionId | null = null): AllocationOperation => ({
  ...base(id, [], callable === null ? object : signature),
  family: 'allocation',
  allocated: callable === null ? 'object-literal' : 'function-object',
  shape: callable === null ? object : signature,
  callable
})
const binding = (id: string, action: BindingOperation['action'], cell: string, source?: string): BindingOperation => ({
  ...base(id, source === undefined ? [] : [input(action === 'initialize' ? 'initializer' : 'value', source)]),
  family: 'binding',
  action,
  declaration: cell as DeclarationId,
  mutable: true,
  temporalDeadZone: false
})
const property = (
  id: string,
  method: PropertyOperation['internalMethod'],
  receiver: string,
  key: string,
  value?: SemanticOperand
): PropertyOperation => ({
  ...base(id, [input('receiver', receiver), literal('key', key), ...(value ? [value] : [])]),
  family: 'property',
  internalMethod: method,
  strict: true,
  keyIsComputed: false,
  descriptor: method === 'define-own-property' ? { writable: true, enumerable: true, configurable: true } : null,
  ...(method === 'set' ? { ordinaryObjectDataWriteAbsent: true as const } : {})
})
const invocation = (id: string, operands: readonly SemanticOperand[], facts: Partial<InvocationOperation> = {}): InvocationOperation => ({
  ...base(id, operands),
  family: 'invocation',
  internalMethod: 'call',
  optionalChain: false,
  selectedSignature: null,
  resultDivergence: { kind: 'none' },
  target: { kind: 'open', evidence: [] },
  ...facts
})
const graphOf = (operations: readonly SemanticOperation[]): SemanticGraph => ({
  operations: new Map(operations.map((one) => [one.id, one])),
  results: new Map(operations.flatMap((one) => one.results.map((result) => [result.id, one.id] as const))),
  regions: new Map(),
  structuralTypes: types,
  edges: [],
  coverage: new Map()
})
const schema = (graph: SemanticGraph, key = 'extra', owner = 'original') =>
  nativeObjectDataSlotSchemasOf(graph)
    .schemas.get(owner as OperationId)
    ?.get(key)
const deriver = {
  deriveStored: (id: StructuralTypeId): Representation =>
    id === text
      ? { kind: 'string' }
      : id === number
        ? { kind: 'scalar', domain: 'number' }
        : { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
  nativeCallableConventions: () => ({
    call: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } as Representation },
    construct: null
  })
}

test('typed extension writers follow exact allocation aliases and keep unrelated same-shape objects separate', () => {
  const graph = graphOf([
    allocation('original'),
    allocation('unrelated'),
    binding('initialize', 'initialize', 'cell', 'original'),
    binding('view', 'read', 'cell'),
    property('first', 'set', 'view', 'extra', literal('value', 'first')),
    property('second', 'set', 'original', 'extra', literal('value', 'second')),
    property('other', 'set', 'unrelated', 'extra', literal('value', '7', 'number'))
  ])
  assert.deepEqual(
    schema(graph)?.writers.map((one) => one.mutation.operation.id),
    ['first', 'second']
  )
  assert.deepEqual(nativeObjectDataStorageOf(schema(graph)!, deriver)?.storage, { kind: 'string' })
  assert.deepEqual(nativeObjectDataStorageOf(schema(graph, 'extra', 'unrelated')!, deriver)?.storage, { kind: 'scalar', domain: 'number' })
})

test('only authenticated zero-argument Object invocations seed fresh native slot schemas', () => {
  for (const internalMethod of ['call', 'construct'] as const) {
    const original = invocation('original', [], { internalMethod, freshOrdinaryObject: true })
    const graph = graphOf([original, property('store', 'set', 'original', 'extra', literal('value', '7', 'number'))])
    assert.equal(nativeObjectDataSlotSchemasOf(graph).origins.get('original' as SemanticResultId), original)
    assert.equal(schema(graph)?.blockers.length, 0)
    assert.deepEqual(nativeObjectDataStorageOf(schema(graph)!, deriver)?.storage, { kind: 'scalar', domain: 'number' })
    assert.equal(nativeObjectDataExtensionSchemaAt(graph, 'store' as OperationId, 'extra'), schema(graph))
  }
  for (const original of [
    invocation('original', []),
    invocation('original', [literal('argument', '7', 'number')], { freshOrdinaryObject: true }),
    invocation('original', [], { freshOrdinaryObject: true, optionalChain: true })
  ]) {
    const graph = graphOf([original, property('store', 'set', 'original', 'extra', literal('value', '7', 'number'))])
    assert.equal(nativeObjectDataSlotSchemasOf(graph).origins.size, 0)
    assert.equal(schema(graph), undefined)
  }
  const indexedRoot = invocation('original', [], {
    freshOrdinaryObject: true,
    results: [{ id: 'original' as SemanticResultId, role: 'value', type: indexed }]
  })
  const indexedGraph = graphOf([indexedRoot, property('store', 'set', 'original', 'extra', literal('value', '7', 'number'))])
  assert.equal(nativeObjectDataExtensionSchemaAt(indexedGraph, 'store' as OperationId, 'extra'), null)
})

test('a proven finite computed writer contributes to every named native slot and unknown keys still block', () => {
  const computed: PropertyOperation = {
    ...property('computed-store', 'set', 'original', 'unused', literal('value', '7', 'number')),
    operands: [input('receiver', 'original'), input('key', 'computed-key', text), literal('value', '7', 'number')],
    keyIsComputed: true,
    provenKeyTexts: ['debug', 'error']
  }
  const graph = graphOf([allocation('original'), computed])
  for (const key of ['debug', 'error']) {
    const slot = schema(graph, key)!
    assert.equal(slot.blockers.length, 0)
    assert.deepEqual(
      slot.writers.map((one) => one.mutation.key),
      [key]
    )
    assert.deepEqual(nativeObjectDataStorageOf(slot, deriver)?.storage, { kind: 'scalar', domain: 'number' })
  }
  const { provenKeyTexts: proof, ...unknown } = computed
  assert.ok(proof)
  assert.equal(proof.length, 2)
  const open = graphOf([allocation('original'), unknown, property('read', 'get', 'original', 'debug')])
  assert.ok(schema(open, 'debug')?.blockers.some((one) => one.kind === 'unknown-key'))
  assert.equal(nativeObjectDataStorageOf(schema(open, 'debug')!, deriver), null)
})

test('contextual intersections use the canonical resolved data body without hiding descriptor blockers', () => {
  for (const [shape, admitted] of [
    [dataIntersection, true],
    [indexedIntersection, false],
    [accessorIntersection, false],
    [droppedIntersection, false],
    [unresolvedIntersection, false]
  ] as const) {
    const original = allocation('original')
    const owner = { ...original, shape, results: original.results.map((result) => ({ ...result, type: shape })) }
    const graph = graphOf([owner, property('store', 'set', 'original', 'extra', literal('value', 'first'))])
    assert.equal(schema(graph)?.blockers.length === 0, admitted)
    assert.equal(nativeObjectDataStorageOf(schema(graph)!, deriver) !== null, admitted)
  }
})

test('an unknown write to an alias cell revokes extension storage rather than hiding later mutations', () => {
  const graph = graphOf([
    allocation('original'),
    binding('initialize', 'initialize', 'cell', 'original'),
    binding('replace', 'write', 'cell', 'unknown'),
    binding('view', 'read', 'cell'),
    property('store', 'set', 'original', 'extra', literal('value', 'first'))
  ])
  assert.equal(nativeObjectDataStorageOf(schema(graph)!, deriver), null)
  assert.ok(schema(graph)?.blockers.some((one) => one.kind === 'open-alias'))
})

test('a complete joint source slot connects retained aliases and its exact writer operations', () => {
  const install = property('called-store', 'set', 'parameter-field', 'extra', literal('value', 'updated'))
  const read: PropertyOperation = {
    ...property('read', 'get', 'original', 'extra'),
    nativeOwnSlot: {
      key: 'extra',
      roots: [
        {
          allocation: 'original' as SemanticResultId,
          values: [{ type: text, source: literal('value', 'updated').source }],
          writers: [install.id]
        }
      ]
    }
  }
  const call = invocation('closed-call', [input('argument', 'original')])
  const graph = graphOf([allocation('original'), call, install, read])
  const storage = nativeObjectDataStorageOf(schema(graph)!, deriver)
  assert.deepEqual(storage?.storage, { kind: 'string' })
  assert.deepEqual(
    storage?.writers.map(({ writer }) => writer.mutation.operation.id),
    [install.id]
  )
  const open = graphOf([allocation('original'), call, install, property('read', 'get', 'original', 'extra')])
  assert.equal(nativeObjectDataStorageOf(schema(open)!, deriver), null)
})

test('a read of an original absent key is an absence protocol, never an extension installation', () => {
  const read = property('read', 'get', 'original', 'extra')
  const graph = graphOf([allocation('original'), read])
  assert.ok(schema(graph))
  assert.equal(nativeObjectDataExtensionSchemaAt(graph, read.id, 'extra'), null)
})

test('an erased primitive assertion cannot replace the actual stored carrier', () => {
  const value = { ...literal('value', '7', 'number'), type: text, asserted: true as const }
  const graph = graphOf([allocation('original'), property('store', 'set', 'original', 'extra', value)])
  assert.equal(schema(graph)?.writers[0]?.value?.type, number)
  assert.deepEqual(nativeObjectDataStorageOf(schema(graph)!, deriver)?.storage, { kind: 'scalar', domain: 'number' })
})

test('an assignment result retains the actual RHS leaf across IR identity lowering', () => {
  const rhs = { ...literal('value', '7', 'number'), type: text, asserted: true as const }
  const assignment: ComputationOperation = {
    ...base('assigned', [input('left', 'unrelated'), rhs], text),
    family: 'computation',
    form: 'assignment',
    operator: '='
  }
  const graph = graphOf([
    allocation('original'),
    assignment,
    property('store', 'set', 'original', 'extra', input('value', 'assigned', text))
  ])
  const value = schema(graph)?.writers[0]?.value
  assert.deepEqual(value?.operand.source, { kind: 'constant', literal: 'number', text: '7' })
  assert.equal(value?.type, number)
  assert.deepEqual(nativeObjectDataStorageOf(schema(graph)!, deriver)?.storage, { kind: 'scalar', domain: 'number' })
})

test('a closed bulk data source separates ordinary descriptor deletion from payload writers', () => {
  const original = allocation('original')
  const target = allocation('target')
  const store = property('store', 'define-own-property', 'original', 'extra', literal('value', 'first'))
  const deleted = property('deleted', 'delete', 'original', 'extra')
  const slots = [
    { key: 'extra', values: [{ type: text, source: { kind: 'constant' as const, literal: 'string' as const, text: 'first' } }] }
  ]
  const copy = invocation('copy', [input('argument', 'target'), input('argument', 'original', object, 1)], {
    intrinsicMutation: 'object-assign',
    nativeOwnAssignment: {
      targets: [target.results[0]!.id],
      targetSlots: [{ allocation: target.results[0]!.id, slots }],
      prototype: 'ordinary-intact-absent',
      sources: [
        {
          ordinal: 1,
          source: { kind: 'result', result: original.results[0]!.id },
          nullable: false,
          roots: [{ allocation: original.results[0]!.id, slots: slots.map((slot) => ({ ...slot, copyPresent: false })) }]
        }
      ]
    }
  })
  const closed = graphOf([original, target, store, deleted, copy])
  assert.equal(schema(closed)?.blockers.length, 0)
  assert.deepEqual(
    schema(closed)?.writers.map((one) => one.mutation.operation.id),
    ['store']
  )
  assert.deepEqual(nativeObjectDataStorageOf(schema(closed)!, deriver)?.storage, { kind: 'string' })
  const { nativeOwnAssignment: omitted, ...ordinary } = copy
  assert.equal(nativeObjectDataStorageOf(schema(graphOf([original, target, store, deleted, ordinary]))!, deriver), null)
  const reflective = invocation('reflective-delete', [input('argument', 'original'), literal('argument', 'extra', 'string', 1)], {
    intrinsicReflection: 'deleteProperty'
  })
  assert.equal(
    nativeObjectDataStorageOf(schema(graphOf([original, target, store, reflective, copy]))!, deriver),
    null,
    'a source data closure does not certify a different reflection protocol'
  )
  const opaque = { ...deleted, operands: [input('receiver', 'original'), input('key', 'unknown', text)] }
  assert.equal(nativeObjectDataStorageOf(schema(graphOf([original, target, store, opaque, copy]))!, deriver), null)
})

test('closed bulk writers retain exact target allocations when a rebinding hides the local argument origin', () => {
  const original = allocation('original')
  const source = allocation('source')
  const slots = [
    { key: 'extra', values: [{ type: text, source: { kind: 'constant' as const, literal: 'string' as const, text: 'copied' } }] }
  ]
  const copy = invocation('copy', [input('argument', 'rebound-target'), input('argument', 'source', object, 1)], {
    intrinsicMutation: 'object-assign',
    nativeOwnAssignment: {
      targets: [original.results[0]!.id],
      targetSlots: [{ allocation: original.results[0]!.id, slots }],
      prototype: 'ordinary-intact-absent',
      sources: [
        {
          ordinal: 1,
          source: { kind: 'result', result: source.results[0]!.id },
          nullable: false,
          roots: [{ allocation: source.results[0]!.id, slots: slots.map((slot) => ({ ...slot, copyPresent: true })) }]
        }
      ]
    }
  })
  const row = schema(graphOf([original, source, copy]))!
  assert.deepEqual(
    row.writers.map((writer) => writer.mutation.operation.id),
    ['copy']
  )
  assert.deepEqual(nativeObjectDataStorageOf(row, deriver)?.storage, { kind: 'string' })
  const { nativeOwnAssignment: omitted, ...ordinary } = copy
  assert.deepEqual(schema(graphOf([original, source, ordinary]))?.writers ?? [], [])
  for (const fact of [
    { ...omitted!, targets: [source.results[0]!.id] },
    { ...omitted!, targetSlots: [{ allocation: original.results[0]!.id, slots: [{ ...slots[0]!, key: 'other' }] }] }
  ]) {
    const rejected = schema(graphOf([original, source, { ...copy, nativeOwnAssignment: fact }]))
    assert.deepEqual(rejected?.writers ?? [], [])
    if (rejected) assert.equal(nativeObjectDataStorageOf(rejected, deriver), null)
  }
})

test('unknown consumers, key writes and delete cannot borrow a closed typed extension schema', () => {
  const store = property('store', 'set', 'original', 'extra', literal('value', 'first'))
  const opaqueKey = {
    ...store,
    id: 'opaque-key' as OperationId,
    operands: [input('receiver', 'original'), input('key', 'unknown', text), literal('value', 'second')]
  }
  for (const extra of [
    invocation('escape', [input('argument', 'original')]),
    opaqueKey,
    property('delete', 'delete', 'original', 'extra')
  ]) {
    const graph = graphOf([allocation('original'), store, extra])
    assert.equal(nativeObjectDataStorageOf(schema(graph)!, deriver), null)
  }
})

test('prototype absence and every actual writer are separate requirements of native storage', () => {
  const store = property('store', 'set', 'original', 'extra', literal('value', 'first'))
  const { ordinaryObjectDataWriteAbsent: _proof, ...intercepted } = store
  const unsafe = graphOf([allocation('original'), intercepted])
  assert.equal(nativeObjectDataStorageOf(schema(unsafe)!, deriver), null)
  const mixed = graphOf([allocation('original'), store, property('different', 'set', 'original', 'extra', literal('value', '7', 'number'))])
  assert.equal(nativeObjectDataStorageOf(schema(mixed)!, deriver), null)
})

test('an inherited builtin read is not an added own slot, while an actual own shadow retains its obligation', () => {
  const inherited = property('inherited', 'get', 'original', 'hasOwnProperty')
  const graph = graphOf([allocation('original'), inherited])
  assert.equal(nativeObjectDataExtensionSchemaAt(graph, inherited.id, 'hasOwnProperty'), null)
  const deleted = graphOf([allocation('original'), property('delete', 'delete', 'original', 'hasOwnProperty'), inherited])
  assert.equal(nativeObjectDataExtensionSchemaAt(deleted, inherited.id, 'hasOwnProperty'), null)
  const own = property('shadow', 'set', 'original', 'hasOwnProperty', literal('value', 'own'))
  const shadowed = graphOf([allocation('original'), own, inherited])
  assert.ok(nativeObjectDataExtensionSchemaAt(shadowed, inherited.id, 'hasOwnProperty'))
  assert.ok(nativeObjectDataExtensionSchemaAt(shadowed, own.id, 'hasOwnProperty'))
})

test('descriptor aliases expose actual native get/set Function writers without ambient signature replacement', () => {
  const getter = 'actual-getter' as FunctionId
  const graph = graphOf([
    allocation('descriptor'),
    allocation('getter', getter),
    property('definition', 'define-own-property', 'descriptor', 'get', { ...input('value', 'getter', any), asserted: true }),
    binding('descriptor-initialize', 'initialize', 'descriptor-cell', 'descriptor'),
    binding('descriptor-alias', 'read', 'descriptor-cell'),
    invocation(
      'define',
      [input('argument', 'unknown-target'), literal('argument', 'extra', 'string', 1), input('argument', 'descriptor-alias', object, 2)],
      { intrinsicDataDefinition: true }
    )
  ])
  const held = schema(graph, 'get', 'descriptor')!
  assert.equal(held.blockers.length, 0)
  assert.equal(held.writers[0]?.value?.callable, getter)
  assert.equal(held.writers[0]?.value?.type, signature)
  assert.equal(nativeObjectDataStorageOf(held, deriver)?.storage.kind, 'function-value-dispatch')
})
