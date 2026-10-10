import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { lexicalReceiverOriginMatches, nativeBodyIgnoresLogicalReceiver } from './native-logical-receiver-body.js'
import type { IrBody, ReceiverOperation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const frame: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: number }
const receiver: ReceiverOperation = {
  kind: 'receiver',
  lineage: 'receiver-origin' as never,
  result: { id: 'receiver' as never, representation: number }
}
const body = (abi: CallableAbi | null, operations: readonly ReceiverOperation[]): IrBody => ({
  owner: 'body' as never,
  sourceOwner: 'source' as never,
  abi,
  construct: null,
  entry: 'entry' as never,
  blockOrder: ['entry' as never],
  values: new Map(),
  tryRegions: [],
  blocks: new Map([['entry' as never, { id: 'entry' as never, operations, terminator: { kind: 'return', lineage: null, value: null } }]])
})

test('physical nil frames ignore incoming this only when receiver reads are authenticated lexical captures', () => {
  assert.equal(nativeBodyIgnoresLogicalReceiver(body(frame, [])), true)
  assert.equal(nativeBodyIgnoresLogicalReceiver(body(frame, [receiver])), false)
  assert.equal(nativeBodyIgnoresLogicalReceiver(body(frame, [{ ...receiver, origin: 'lexical' }])), true)
  assert.equal(nativeBodyIgnoresLogicalReceiver(body({ ...frame, receiver: number }, [])), false)
  assert.equal(nativeBodyIgnoresLogicalReceiver(body(null, [])), false)
})

test('a lexical marker cannot borrow an ordinary or unrelated semantic receiver', () => {
  const lexical = { ...receiver, origin: 'lexical' as const }
  const source = {
    family: 'reference',
    form: 'this',
    results: [{ id: receiver.lineage, role: 'value' }],
    operands: [{ role: 'captured-receiver', ordinal: 0, source: { kind: 'receiver' } }]
  } as unknown as SemanticOperation
  assert.equal(lexicalReceiverOriginMatches(lexical, source), true)
  assert.equal(lexicalReceiverOriginMatches(receiver, source), false)
  assert.equal(lexicalReceiverOriginMatches({ ...lexical, lineage: 'unrelated' as never }, source), false)
  const ordinary = { ...source, operands: [{ ...source.operands[0]!, role: 'receiver' }] }
  assert.equal(lexicalReceiverOriginMatches(lexical, ordinary), false)
  assert.equal(lexicalReceiverOriginMatches(lexical, null), false)
})
