import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { createDeferredIntrinsicProtocolLedger } from '../deferred-intrinsic-protocols.js'
import { settleProofMemoClaims, type ProvisionalProofMemo } from './proof-memo-settlement.js'

const site = ts.createSourceFile('proof-memo.ts', 'holder.field', ts.ScriptTarget.ES2022, true)
const protocol = (intrinsic: 'Object' | 'Function', key: string) => {
  const ledger = createDeferredIntrinsicProtocolLedger()
  return ledger.capture(() => ledger.requirePrototypeKeys(intrinsic, { names: [key] }, site)).requirements
}
const claim = (keys: readonly object[], escaped: readonly object[] = []): ProvisionalProofMemo => ({
  assumed: new Set(keys),
  escaped: new Set(escaped),
  requirements: []
})

test('recursive field and allocation receipts settle with the same verified member leaders and replay all protocols', () => {
  const member = {}
  const family = {}
  const field = claim([member])
  const allocation = claim([member])
  const retainedReceipt = allocation.requirements
  const claims = [field, allocation]
  const object = protocol('Object', 'field')
  const callable = protocol('Function', 'call')
  settleProofMemoClaims(claims, 0, {
    closed: true,
    own: new Set([member]),
    inherited: new Set([family]),
    assumed: new Set([family]),
    escaped: new Set(),
    requirements: object
  })
  assert.equal(claims.length, 2)
  assert.deepEqual(field.assumed, new Set([family]))
  assert.deepEqual(retainedReceipt, object)
  settleProofMemoClaims(claims, 0, {
    closed: true,
    own: new Set([family]),
    inherited: new Set(),
    assumed: new Set(),
    escaped: new Set(),
    requirements: [...object, ...callable]
  })
  assert.equal(claims.length, 0)
  assert.equal(field.assumed.size, 0)
  assert.equal(allocation.assumed.size, 0)
  assert.deepEqual(retainedReceipt, [...object, ...callable])
  const consumer = createDeferredIntrinsicProtocolLedger()
  assert.deepEqual(consumer.capture(() => consumer.include(retainedReceipt)).requirements, [...object, ...callable])
  assert.equal(consumer.include(retainedReceipt), false, 'a cached receipt still requires an actual ledger capture')
})

test('failed, escaped and unrelated proof leaders cannot erase a condition or invent protocol authority', () => {
  const member = {}
  const foreign = {}
  for (const outcome of [
    { closed: false, escaped: new Set<object>() },
    { closed: true, escaped: new Set([foreign]) }
  ]) {
    const field = claim([member])
    const claims = [field]
    settleProofMemoClaims(claims, 0, {
      ...outcome,
      own: new Set([member]),
      inherited: new Set(),
      assumed: new Set(),
      requirements: protocol('Object', 'field')
    })
    assert.deepEqual(field.assumed, new Set([member]))
    assert.deepEqual(field.requirements, [])
  }
  const guarded = claim([member, foreign])
  const escaped = claim([member], [foreign])
  const unrelated = claim([foreign])
  settleProofMemoClaims([guarded, escaped, unrelated], 0, {
    closed: true,
    own: new Set([member]),
    inherited: new Set(),
    assumed: new Set(),
    escaped: new Set(),
    requirements: protocol('Object', 'field')
  })
  assert.deepEqual(guarded.assumed, new Set([foreign]), 'an open external guard remains conditional')
  assert.deepEqual(escaped.assumed, new Set([member]))
  assert.deepEqual(escaped.requirements, [])
  assert.deepEqual(unrelated.requirements, [])
})
