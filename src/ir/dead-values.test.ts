import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { Representation } from '../representation/model.js'
import { discardUnreadCallResults } from './dead-values.js'
import type { CallOperation, IrBody } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const value = (id: string) => ({ value: id as never, representation: number })
const result = { id: 'unused' as never, representation: number }

const fixture = (observed: boolean) => {
  const call: CallOperation = {
    kind: 'call',
    lineage: 'source-call' as never,
    callee: value('callee'),
    receiver: value('receiver'),
    thisArgument: value('logical-this'),
    arguments: [value('argument')],
    result
  }
  const entry = 'entry' as never
  const body: IrBody = {
    owner: 'body' as never,
    sourceOwner: 'source' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([
      [entry, { id: entry, operations: [call], terminator: { kind: 'return', lineage: null, value: observed ? value('unused') : null } }]
    ]),
    blockOrder: [entry],
    values: new Map([[result.id, number]]),
    tryRegions: []
  }
  return { call, body, bodies: new Map([[body.owner, body]]) }
}

test('discarding an unread call result retains the call, its logical receiver and every evaluated operand', () => {
  const { call, body, bodies } = fixture(false)
  const rewritten = discardUnreadCallResults(bodies).get(body.owner)!
  const retained = rewritten.blocks.get(body.entry)!.operations[0] as CallOperation
  assert.equal(retained.kind, 'call')
  assert.equal(retained.result, null)
  assert.equal(retained.callee, call.callee)
  assert.equal(retained.receiver, call.receiver)
  assert.equal(retained.thisArgument, call.thisArgument)
  assert.equal(retained.arguments, call.arguments)
  assert.equal(retained.lineage, call.lineage)
  assert.equal(rewritten.values.has(result.id), false)
  assert.equal(body.values.has(result.id), true)
  const observed = fixture(true)
  assert.equal(discardUnreadCallResults(observed.bodies), observed.bodies)
})

test('discarded native pop results require no unsupported Listener-to-public-callback conversion', () => {
  const entry = resolve('test/runtime/typed-emitter-listeners-array-is-a-fresh-copy.runtime.ts')
  const compiled = compile({ rootFileNames: [entry], projectFileName: null, includeIr: true })
  assert.notEqual(compiled.certificate, null, JSON.stringify(compiled.refusals))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
  const keys = new Map(
    operations.flatMap((operation) => (operation.kind === 'constant' ? [[operation.result.id, operation.text] as const] : []))
  )
  const popValues = new Set(
    operations.flatMap((operation) => (operation.kind === 'get' && keys.get(operation.key.value) === 'pop' ? [operation.result.id] : []))
  )
  const calls = operations.filter(
    (operation): operation is CallOperation => operation.kind === 'call' && popValues.has(operation.callee.value)
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.result, null)
  assert.equal(
    calls[0]!.conversionRecipes?.some((recipe) => recipe.role === 'prototype-result'),
    false
  )
})
