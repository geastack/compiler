import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { IrBlockId, IrBody, IrNonTerminatorOperation, IrOperand, IrOperation } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { buildDyingArgumentIndex, dyingTransferUsesOf, ownedDyingValuesOf, receiverRenamesOf, transferOf } from './transfer.js'

const carrier: Representation = { kind: 'record', shapeId: 'source', ownership: 'shared-refcount', fields: [], accessors: [] }
const text: Representation = { kind: 'string' }
const operand = (value: string, representation: Representation = carrier): IrOperand => ({ value: value as IrValueId, representation })
const lineage = 'literal' as never
const blockId = 'entry' as IrBlockId
const owner = operand('owner')
const filled = operand('filled')
const key = operand('key', text)
const stored = operand('stored', text)

const bodyOf = (operations: readonly IrNonTerminatorOperation[]): IrBody => {
  const terminator: Extract<IrOperation, { kind: 'return' }> = { kind: 'return', lineage: null, value: null }
  const block = { id: blockId, operations, terminator }
  return {
    owner: 'physical-body' as never,
    sourceOwner: 'source-body' as never,
    abi: null,
    construct: null,
    entry: blockId,
    blocks: new Map([[blockId, block]]),
    blockOrder: [blockId],
    values: new Map(
      operations.flatMap((operation) => {
        const result = resultOfIrOperation(operation)
        return result === null ? [] : [[result.id, result.representation] as const]
      })
    ),
    tryRegions: []
  }
}

const initialization: readonly IrNonTerminatorOperation[] = [
  { kind: 'allocate-record', lineage, fields: [], result: { id: owner.value, representation: carrier } },
  { kind: 'constant', lineage, literal: 'string', text: 'shown', result: { id: key.value, representation: text } },
  { kind: 'constant', lineage, literal: 'string', text: 'initial', result: { id: stored.value, representation: text } },
  {
    kind: 'define-own-property',
    lineage,
    receiver: owner,
    key,
    value: stored,
    attributes: { writable: true, enumerable: true, configurable: true },
    result: { id: filled.value, representation: carrier }
  },
  { kind: 'binding-write', lineage, declaration: 'original' as never, value: filled }
]

const extensionRead: Extract<IrOperation, { kind: 'get' }> = {
  kind: 'get',
  lineage,
  receiver: operand('public-view'),
  key,
  result: { id: 'answer' as never, representation: text },
  nativeObjectDataSlot: {
    allocation: 'allocation' as never,
    owner,
    key: 'extra',
    storage: text,
    writers: [],
    read: [{ source: text, conversion: 'native-read' }],
    write: null
  }
}

test('a retained extension owner keeps its initialized storage alive after a receiver-result binding write', () => {
  const body = bodyOf([
    ...initialization,
    {
      kind: 'binding-read',
      lineage,
      declaration: 'original' as never,
      result: { id: extensionRead.receiver.value, representation: carrier }
    },
    extensionRead
  ])
  assert.ok(operandsOfIrOperation(extensionRead).some((input) => input.value === owner.value))
  const dyingArguments = buildDyingArgumentIndex([body])
  const dyingValues = new Set([...ownedDyingValuesOf(body), ...dyingTransferUsesOf(body)])
  for (const value of [owner.value, filled.value]) {
    assert.equal(dyingArguments.has(value), false)
    assert.equal(dyingValues.has(value), false)
    assert.equal(transferOf(dyingArguments, new Set([owner.value]), dyingValues, value, receiverRenamesOf(body)), 'retain')
  }
})

test('a filled literal still moves into its binding when no later native read retains the allocation', () => {
  const body = bodyOf(initialization)
  assert.equal(
    transferOf(buildDyingArgumentIndex([body]), new Set([owner.value]), dyingTransferUsesOf(body), filled.value, receiverRenamesOf(body)),
    'move'
  )
})

test('descriptor reinstallation keeps its original native snapshot owner and key as executable call inputs', () => {
  const call: Extract<IrOperation, { kind: 'call' }> = {
    kind: 'call',
    lineage,
    callee: operand('define-property', {
      kind: 'function-value-dispatch',
      abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
    }),
    receiver: null,
    arguments: [operand('new-owner'), operand('new-key', text), operand('public-descriptor')],
    result: null,
    nativeAccessorReinstallation: {
      receiver: 'new-owner' as never,
      key: 'new-key' as never,
      descriptor: 'public-descriptor' as never,
      observation: 'observation' as never,
      definition: 'native-definition' as never,
      snapshotReceiver: owner,
      snapshotKey: key
    }
  }
  const inputs = operandsOfIrOperation(call)
  assert.ok(inputs.includes(owner))
  assert.ok(inputs.includes(key))
  const body = bodyOf([...initialization, call])
  assert.equal(buildDyingArgumentIndex([body]).has(filled.value), false)
  assert.equal(dyingTransferUsesOf(body).has(filled.value), false)
})
