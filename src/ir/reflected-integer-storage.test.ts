import assert from 'node:assert/strict'
import test from 'node:test'
import { integerStorageCensusOf, integerStorageSlot, reflectedFieldStorageNeedsPublishedCarrier } from './integer-storage.js'
import type { IrBody, IrOperand } from './model.js'
import type { ReflectionDemand, ReflectionFieldOperation } from './reflection-demand.js'
import type { Representation } from '../representation/model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const record: Representation = {
  kind: 'record',
  shapeId: 'integral-origin',
  ownership: 'shared-refcount',
  fields: [{ key: 'amount', value: number, required: true }],
  accessors: []
}
const struct = 'IntegralOrigin'
const slot = integerStorageSlot(struct, 'amount')
const operand = (value: string, representation: Representation): IrOperand => ({ value, representation }) as IrOperand
const body = (written: string): IrBody =>
  ({
    sourceOwner: 'region|integral-test',
    blockOrder: ['entry'],
    blocks: new Map([
      [
        'entry',
        {
          operations: [
            { kind: 'constant', literal: 'number', text: '0', result: { id: 'zero', representation: number } },
            { kind: 'constant', literal: 'string', text: 'amount', result: { id: 'key', representation: { kind: 'string' } } },
            {
              kind: 'allocate-record',
              fields: [{ key: 'amount', value: operand('zero', number) }],
              result: { id: 'object', representation: record }
            },
            { kind: 'constant', literal: 'number', text: written, result: { id: 'written', representation: number } },
            {
              kind: 'set',
              receiver: operand('object', record),
              key: operand('key', { kind: 'string' }),
              value: operand('written', number),
              strict: true,
              result: null
            },
            {
              kind: 'get',
              receiver: operand('object', record),
              key: operand('key', { kind: 'string' }),
              result: { id: 'read', representation: number }
            }
          ],
          terminator: { kind: 'return', value: null }
        }
      ]
    ])
  }) as unknown as IrBody

const census = (demand: Pick<ReflectionDemand, 'level' | 'fieldOperations'>, written = '1') =>
  integerStorageCensusOf({
    bodies: [body(written)],
    structNameOf: (value) => (value === record ? struct : null),
    structFamilyOf: (value) => (value === record ? [struct] : []),
    fieldStructNameOf: (value, key) => (value === record && key === 'amount' ? struct : null),
    fieldRepresentationOf: (value, key) => (value === record && key === 'amount' ? number : null),
    excludedStructs: new Set(reflectedFieldStorageNeedsPublishedCarrier(demand) ? [struct] : []),
    fieldSeeds: new Map(),
    directCallees: new Map(),
    memberCandidates: new Map(),
    methodBodies: new Map(),
    classStructNameOf: () => struct,
    excludedFormalOwners: new Set(),
    excludedSignatureSlots: new Set()
  })

test('an integral-only live field retains its published number carrier for either native descriptor direction', () => {
  for (const operation of ['native-read', 'native-write'] satisfies ReflectionFieldOperation[]) {
    const demand = { level: 'full' as const, fieldOperations: new Map([['amount', new Set([operation])]]) }
    assert.equal(census(demand).slots.has(slot), false, operation)
  }
})

test('unobserved integral storage still narrows, while an actual fractional writer independently prevents narrowing', () => {
  const unobserved = { level: 'keys-only' as const }
  assert.equal(census(unobserved).slots.has(slot), true)
  assert.equal(census(unobserved, '0.5').slots.has(slot), false)
})
