import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrBody, IrOperation } from '../ir/model.js'
import type { Representation } from '../representation/model.js'
import { immediateVirtualCalleesOf } from './immediate-callees.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const operand = (value: string) => ({ value: value as never, representation: number })

const bodyOf = (operations: readonly IrOperation[], returned: string | null = null): IrBody => {
  const entry = 'immediate-callees-entry' as never
  return {
    owner: 'immediate-callees-body' as never,
    sourceOwner: 'immediate-callees-owner' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([
      [
        entry,
        {
          id: entry,
          operations: operations as never,
          terminator: { kind: 'return', lineage: null, value: returned === null ? null : operand(returned) } as never
        }
      ]
    ]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}

const callOf = (callee: string, result: string, virtual: boolean, args: readonly string[] = []): IrOperation =>
  ({
    kind: 'call',
    lineage: null,
    callee: operand(callee),
    receiver: null,
    arguments: args.map(operand),
    ...(virtual ? { target: { kind: 'virtual' } } : {}),
    result: { id: result as never, representation: number }
  }) as never

test('a value used only as a virtual callee is immediate', () => {
  assert.deepEqual([...immediateVirtualCalleesOf(bodyOf([callOf('m', 'r', true)]))], ['m'])
})

test('a callee that is also returned, passed, or called directly escapes', () => {
  assert.equal(immediateVirtualCalleesOf(bodyOf([callOf('m', 'r', true)], 'm')).size, 0)
  assert.equal(immediateVirtualCalleesOf(bodyOf([callOf('m', 'r', true, ['m'])])).size, 0)
  assert.equal(immediateVirtualCalleesOf(bodyOf([callOf('m', 'r', true), callOf('m', 's', false)])).size, 0)
})
