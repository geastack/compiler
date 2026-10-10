import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { callableIdentityDemandOf } from './callable-identity-demand.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'

const lineage = 'native-receiver-identity' as never
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: { receiver: null, parameters: [], result: { kind: 'void' }, restFrom: null }
}
const operand = (value: string, representation: Representation): IrOperand => ({ value: value as never, representation })
const allocate = (value: string): IrNonTerminatorOperation => ({
  kind: 'allocate-callable',
  lineage,
  functionId: value as never,
  captures: [],
  result: { id: value as never, representation: callable }
})
const body = (operations: readonly IrNonTerminatorOperation[]): IrBody => ({
  owner: 'receiver-identity' as never,
  sourceOwner: 'receiver-identity' as never,
  abi: null,
  construct: null,
  entry: 'entry' as never,
  blockOrder: ['entry' as never],
  values: new Map(),
  tryRegions: [],
  blocks: new Map([['entry' as never, { id: 'entry' as never, operations, terminator: { kind: 'return', lineage: null, value: null } }]])
})
const policy = { classInstanceOf: () => null, shapeLayoutOf: () => null }

test('an actual callable logical receiver is identified at its source before Optional or physical frame copies', () => {
  const wrapped: Representation = { kind: 'optional', payload: callable, absence: 'undefined' }
  const operations: IrNonTerminatorOperation[] = [
    allocate('source'),
    allocate('unobserved'),
    {
      kind: 'convert',
      lineage,
      source: operand('source', callable),
      conversionUse: 'optional-copy' as never,
      result: { id: 'wrapped' as never, representation: wrapped }
    },
    {
      kind: 'call',
      lineage,
      callee: operand('reader', callable),
      receiver: null,
      thisArgument: operand('wrapped', wrapped),
      arguments: [],
      result: null
    }
  ]
  const demand = callableIdentityDemandOf([body(operations)], policy)
  assert.equal(demand.observesAllocation('source' as never, callable), true)
  assert.equal(demand.observesAllocation('unobserved' as never, callable), false)
})

test('ordinary invocation keeps an unobserved source allocation free of identity storage', () => {
  const operations: IrNonTerminatorOperation[] = [
    allocate('source'),
    {
      kind: 'call',
      lineage,
      callee: operand('source', callable),
      receiver: null,
      arguments: [],
      result: null
    }
  ]
  const demand = callableIdentityDemandOf([body(operations)], policy)
  assert.equal(demand.observesAllocation('source' as never, callable), false)
})

test('exact lazy callable receiver recipes retain their observable source ABI class', () => {
  const operations: IrNonTerminatorOperation[] = [
    {
      kind: 'call',
      lineage,
      callee: operand('reader', callable),
      receiver: null,
      arguments: [],
      result: null,
      conversionRecipes: [
        {
          role: 'logical-receiver',
          source: callable,
          target: { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
          conversion: 'source-any-boundary' as never
        }
      ]
    }
  ]
  assert.equal(callableIdentityDemandOf([body(operations)], policy).observes(callable), true)
})
