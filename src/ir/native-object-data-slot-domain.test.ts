import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import { normalCompletion, pureEffects, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation, AllocationOperation, PropertyOperation } from '../semantics/model/operations.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { nativeObjectDataSlotAuthorityOf } from './native-object-data-slots.js'
import type { IrBody, IrOperation } from './model.js'

const string: Representation = { kind: 'string' }
const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
const record = (fields: Extract<Representation, { kind: 'record' }>['fields'] = []): Extract<Representation, { kind: 'record' }> => ({
  kind: 'record',
  shapeId: 'physical-source',
  ownership: 'shared-refcount',
  fields,
  accessors: []
})

/** The raw literal has no extra key. Its canonical allocation protocol is
 * independently selected below, as it is by lower-allocation in production.
 */
const inputOf = (carrier: Representation, writable = true, indexed = false) => {
  const types = createStructuralTypeTable()
  const text = types.intern({ kind: 'primitive', primitive: 'string' })
  const shape = types.intern({
    kind: 'object',
    members: [],
    index: indexed ? [{ key: 'string', value: text, readonly: false }] : [],
    membersDropped: false
  })
  const receiver: SemanticOperand = {
    role: 'receiver',
    ordinal: 0,
    type: shape,
    source: { kind: 'result', result: 'allocation' as never },
    evaluation: { kind: 'runtime' }
  }
  const key: SemanticOperand = {
    role: 'key',
    ordinal: 0,
    type: text,
    source: { kind: 'constant', literal: 'string', text: 'extra' },
    evaluation: { kind: 'runtime' }
  }
  const value: SemanticOperand = { ...key, role: 'value', source: { kind: 'constant', literal: 'string', text: 'stored' } }
  const base = (id: string, operands: readonly SemanticOperand[]) => ({
    id: id as never,
    caller: { kind: 'function' as const, functionId: 'domain' as never },
    operands,
    results: [{ id: id as never, role: 'value' as const, type: shape }],
    evaluationOrdinal: 0,
    completion: normalCompletion,
    effects: pureEffects
  })
  const allocation: AllocationOperation = {
    ...base('allocation', []),
    family: 'allocation',
    allocated: 'object-literal',
    shape,
    callable: null
  }
  const read: PropertyOperation = {
    ...base('read', [receiver, key]),
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null
  }
  const write: PropertyOperation = {
    ...base('write', [receiver, key, value]),
    family: 'property',
    internalMethod: 'set',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    ...(writable ? { ordinaryObjectDataWriteAbsent: true as const } : {})
  }
  const source: SemanticOperation[] = [allocation, read, write]
  const graph: SemanticGraph = {
    regions: new Map(),
    structuralTypes: types.seal(),
    operations: new Map(source.map((one) => [one.id, one])),
    results: new Map(source.map((one) => [one.results[0]!.id, one.id])),
    edges: [],
    coverage: new Map()
  }
  const owner = { value: 'owner' as never, representation: carrier }
  const keyValue = { value: 'key' as never, representation: string }
  const rhs = { value: 'rhs' as never, representation: string }
  const operations: IrOperation[] = [
    { kind: 'allocate-record', lineage: 'allocation' as never, fields: [], result: { id: owner.value, representation: carrier } },
    { kind: 'constant', lineage: 'key' as never, literal: 'string', text: 'extra', result: { id: keyValue.value, representation: string } },
    { kind: 'get', lineage: 'read' as never, receiver: owner, key: keyValue, result: { id: 'answer' as never, representation: optional } },
    { kind: 'constant', lineage: 'rhs' as never, literal: 'string', text: 'stored', result: { id: rhs.value, representation: string } },
    { kind: 'set', lineage: 'write' as never, receiver: owner, key: keyValue, value: rhs, result: null, strict: true }
  ]
  const body = {
    owner: 'domain-body' as never,
    sourceOwner: 'domain' as never,
    blocks: new Map([['entry' as never, { operations, terminator: { kind: 'return', lineage: 'done' as never, value: null } }]])
  } as unknown as IrBody
  const nodes = new Map<string, ConversionNode>()
  const conversions = {
    nodeById: (id: string) => nodes.get(id) ?? null,
    nodeFor: (source: Representation, target: Representation): ConversionNode => {
      const id = `${representationKey(source)}->${representationKey(target)}`
      const known = nodes.get(id)
      if (known) return known
      const node: ConversionNode = {
        id,
        source,
        target,
        capability:
          representationKey(source) === representationKey(target)
            ? { kind: 'identity' }
            : { kind: 'static', materializer: { id: 'native-test-leaf', domain: 'native-test-leaf', allocates: false } }
      }
      nodes.set(id, node)
      return node
    }
  }
  const deriver = {
    deriveStored: () => string,
    nativeCallableConventions: () => null,
    layoutOf: () => carrier
  } as unknown as RepresentationDeriver
  return { input: { bodies: new Map([[body.owner, body]]), placements: new Map(), graph, deriver, conversions }, operations }
}

test('a real closed shared extension remains required independently of successful writer admission', () => {
  const valid = inputOf(record())
  const authority = nativeObjectDataSlotAuthorityOf(valid.input)
  assert.equal(authority.required.size, 2)
  assert.equal(authority.receipts.size, 2)
  assert.deepEqual(
    authority.receipts.get(valid.operations[2]!)?.read.map((entry) => entry.source.kind),
    ['string', 'undefined']
  )
  const blocked = nativeObjectDataSlotAuthorityOf(inputOf(record(), false).input)
  assert.equal(blocked.required.size, 2)
  assert.equal(blocked.receipts.size, 0)
})

test('an absent fixed optional slot is not an extension, despite an empty initializer list', () => {
  const fixed = record([{ key: 'extra', value: optional, required: false }])
  const authority = nativeObjectDataSlotAuthorityOf(inputOf(fixed).input)
  assert.equal(authority.required.size, 0)
  assert.equal(authority.receipts.size, 0)
})

test('canonical dictionary and record index storage are not plain-object extensions', () => {
  for (const carrier of [
    { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' },
    { ...record(), kind: 'record-with-index', indexes: [{ key: 'string', value: string }] }
  ] as readonly Representation[]) {
    const authority = nativeObjectDataSlotAuthorityOf(inputOf(carrier).input)
    assert.equal(authority.required.size, 0)
    assert.equal(authority.receipts.size, 0)
  }
  const semanticIndex = nativeObjectDataSlotAuthorityOf(inputOf(record(), true, true).input)
  assert.equal(semanticIndex.required.size, 0)
})

test('owned copies cannot acquire source-owned native extension receipts', () => {
  const authority = nativeObjectDataSlotAuthorityOf(inputOf({ ...record(), ownership: 'owned' }).input)
  assert.equal(authority.required.size, 0)
  assert.equal(authority.receipts.size, 0)
})
