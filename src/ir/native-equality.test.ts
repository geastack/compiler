import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { nativeEqualityOf } from './native-equality.js'
import { createIrBodyBuilder } from './build.js'
import { verifyIrBody } from './verify.js'
import type { PhysicalBodyId, FunctionId, SemanticResultId } from '../identity/ids.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const string: Representation = { kind: 'string' }
const operands = (...values: Representation[]) => values.map((representation) => ({ representation }))

test('strict equality seals each native primitive and operand order', () => {
  for (const [primitive, representation] of [
    ['number', number],
    ['boolean', boolean],
    ['string', string]
  ] as const) {
    assert.deepEqual(nativeEqualityOf('===', operands(dynamic, representation)), { dynamicOperand: 0, primitive, negate: false })
    assert.deepEqual(nativeEqualityOf('!==', operands(representation, dynamic)), { dynamicOperand: 1, primitive, negate: true })
  }
})

test('loose equality, coercion, absent values and two dynamic operands do not use primitive strict comparison', () => {
  for (const operator of ['==', '!=', '+', '<']) assert.equal(nativeEqualityOf(operator, operands(dynamic, number)), null)
  assert.equal(nativeEqualityOf('===', operands(dynamic, dynamic)), null)
  assert.equal(nativeEqualityOf('===', operands(number, number)), null)
  assert.equal(nativeEqualityOf('===', operands(dynamic, { kind: 'null' })), null)
  assert.equal(nativeEqualityOf('===', operands(dynamic, { kind: 'optional', payload: number, absence: 'undefined' })), null)
  assert.equal(nativeEqualityOf('===', operands(dynamic)), null)
})

test('native numeric storage domains keep Number semantics and BigInt stays distinct', () => {
  for (const domain of ['number', 'int32', 'uint32', 'float64'] as const)
    assert.equal(nativeEqualityOf('===', operands(dynamic, { kind: 'scalar', domain }))?.primitive, 'number')
  assert.equal(nativeEqualityOf('===', operands(dynamic, { kind: 'scalar', domain: 'bigint' }))?.primitive, 'bigint')
  assert.equal(nativeEqualityOf('===', operands(dynamic, { kind: 'symbol' }))?.primitive, 'symbol')
})

test('verification rejects a primitive recipe that disagrees with its operand carrier', () => {
  const builder = createIrBodyBuilder('native-equality-body' as PhysicalBodyId, 'native-equality-owner' as FunctionId, null)
  const block = builder.openBlock()
  const lineage = 'native-equality-result' as SemanticResultId
  const left = builder.constant(block, lineage, '7', 'number', dynamic)
  const right = builder.constant(block, lineage, '7', 'number', number)
  const result = builder.compute(
    block,
    lineage,
    'equality',
    '===',
    [
      { value: left, representation: dynamic },
      { value: right, representation: number }
    ],
    boolean
  )
  builder.return(block, lineage, { value: result, representation: boolean })
  const body = builder.seal()
  const mutated = {
    ...body,
    blocks: new Map(
      [...body.blocks].map(([id, entry]) => [
        id,
        {
          ...entry,
          operations: entry.operations.map((operation) =>
            operation.kind === 'compute' && operation.nativeEquality
              ? { ...operation, nativeEquality: { ...operation.nativeEquality, primitive: 'string' as const } }
              : operation
          )
        }
      ])
    )
  }
  assert.equal(verifyIrBody(body).length, 0)
  assert.ok(verifyIrBody(mutated).some((violation) => violation.guard === 'native-equality-recipe'))
})
