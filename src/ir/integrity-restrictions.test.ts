import assert from 'node:assert/strict'
import test from 'node:test'
import { integrityRestrictionsOf } from './integrity-restrictions.js'
import type { CallOperation, IrBody, IrNonTerminatorOperation } from './model.js'
import type { Representation } from '../representation/model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const namespace: Representation = {
  kind: 'native-handle',
  protocol: 'ObjectConstructor',
  native: null,
  version: 1,
  bases: [],
  viewsFrom: new Map(),
  call: null,
  construct: null
}
const target: Representation = { kind: 'native-record-ref', shapeId: 'settings' as never, ownership: 'shared-refcount', native: null }
const frame: Representation = {
  kind: 'class-ref',
  declaration: 'frame' as never,
  shapeId: 'frame',
  ownership: 'shared-refcount',
  ancestors: []
}
const lineage = 'integrity-test' as never
const operand = (id: string, representation: Representation) => ({ value: id as never, representation })
const result = (id: string, representation: Representation) => ({ id: id as never, representation })
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: {
    parameters: [{ value: target, ownership: 'shared-refcount', passing: 'const-ref' }],
    restFrom: null,
    result: target,
    receiver: null
  }
}
const freeze: CallOperation = {
  kind: 'call',
  lineage,
  callee: operand('freeze', callable),
  receiver: null,
  thisArgument: operand('Object', namespace),
  arguments: [operand('settings', target)],
  result: null,
  intrinsicReturnIdentity: 'argument0',
  intrinsicIntegrity: 'freeze'
}
const bodyOf = (call: CallOperation): IrBody => {
  const entry = 'integrity-entry' as never
  const operations: IrNonTerminatorOperation[] = [
    { kind: 'constant', lineage, literal: 'string', text: 'freeze', result: result('freeze-key', { kind: 'string' }) },
    {
      kind: 'get',
      lineage,
      receiver: operand('Object', namespace),
      key: operand('freeze-key', { kind: 'string' }),
      result: result('freeze', callable)
    },
    {
      kind: 'get',
      lineage,
      receiver: operand('bag', dynamic),
      key: operand('runtime-key', { kind: 'string' }),
      result: result('picked', dynamic)
    },
    call
  ]
  return {
    owner: 'integrity-body' as never,
    sourceOwner: 'integrity-body' as never,
    abi: null,
    construct: null,
    entry,
    blockOrder: [entry],
    values: new Map(),
    tryRegions: [],
    blocks: new Map([[entry, { id: entry, operations, terminator: { kind: 'return', lineage, value: null } }]])
  }
}

test('a direct Object member call uses either native receiver channel without publishing its namespace', () => {
  const { thisArgument, ...physical } = freeze
  for (const call of [freeze, { ...physical, receiver: thisArgument! }]) {
    const restrictions = integrityRestrictionsOf([bodyOf(call)])
    assert.equal(restrictions.restricts(target, 'level'), true)
    assert.equal(restrictions.restricts(frame, 'index'), false)
    assert.equal(restrictions.fixedFieldState(frame, 'index'), true)
    assert.equal(restrictions.restricts(number), false)
  }
})

test('passing or detaching the namespace retains the fail-closed computed-read restriction', () => {
  for (const call of [
    { ...freeze, arguments: [...freeze.arguments, operand('Object', namespace)] },
    { ...freeze, callee: operand('other-function', callable) }
  ]) {
    const restrictions = integrityRestrictionsOf([bodyOf(call)])
    assert.equal(restrictions.restricts(frame, 'index'), true)
    assert.equal(restrictions.fixedFieldState(frame, 'index'), false)
  }
})
