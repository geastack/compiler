import assert from 'node:assert/strict'
import test from 'node:test'
import { declarationId, type IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import type { HostSpellings } from '../targets/cpp/host/host-members.js'
import type { CallOperation, IrBody, IrOperation } from './model.js'
import { buildHostMethodAliasIndex } from './host-method-aliases.js'
import { operationConversionInputsOf } from './operation-conversions.js'

const host = declarationId('host-alias', 0)
const alias = declarationId('host-alias', 1)
const string: Representation = { kind: 'string' }
const empty: Representation = { kind: 'record', shapeId: 'ambient-object', ownership: 'shared-refcount', fields: [], accessors: [] }
const native: Representation = {
  kind: 'native-handle',
  protocol: 'ObjectConstructor',
  version: 1,
  native: null,
  bases: [],
  call: null,
  construct: null
}
const frame: Representation = {
  kind: 'function-value-dispatch',
  abi: { receiver: null, restFrom: null, parameters: [{ value: empty, passing: 'const-ref', ownership: 'shared-refcount' }], result: empty }
}
const operand = (value: string, representation: Representation) => ({ value: value as IrValueId, representation })
const operations = [
  { kind: 'binding-read', declaration: host, result: { id: 'host', representation: native } },
  { kind: 'constant', literal: 'string', text: 'defineProperty', result: { id: 'key', representation: string } },
  { kind: 'get', receiver: operand('host', native), key: operand('key', string), result: { id: 'method', representation: frame } },
  { kind: 'binding-write', declaration: alias, value: operand('method', frame) }
] as unknown as readonly IrOperation[]
const body = (ops: readonly IrOperation[]): IrBody => ({ blocks: new Map([['entry', { operations: ops }]]) }) as unknown as IrBody
const placements = new Map([[host, { storage: { kind: 'host-class' } } as BindingPlacement]])
const hosts = {
  members: new Map([['ObjectConstructor.defineProperty', { kind: 'method', emit: 'defineProperty', arity: 3 }]])
} as unknown as HostSpellings

test('host aliases require an installed row, the native host placement, and exactly one cell write', () => {
  assert.deepEqual(buildHostMethodAliasIndex([body(operations)], placements, hosts).get(alias), {
    protocol: 'ObjectConstructor',
    member: 'defineProperty'
  })
  assert.equal(buildHostMethodAliasIndex([body(operations)], new Map(), hosts).size, 0)
  assert.equal(buildHostMethodAliasIndex([body(operations)], placements, { ...hosts, members: new Map() }).size, 0)
  const rewritten = [...operations, { kind: 'binding-write', declaration: alias, value: operand('unknown', frame) } as IrOperation]
  assert.equal(buildHostMethodAliasIndex([body(rewritten)], placements, hosts).size, 0)
})

test('only a proved alias call bypasses the ambient object parameter convention', () => {
  const read = { kind: 'binding-read', declaration: alias, result: { id: 'callee', representation: frame } } as unknown as IrOperation
  const call = {
    kind: 'call',
    lineage: 'call',
    callee: operand('callee', frame),
    receiver: null,
    arguments: [operand('actual', native)],
    result: null
  } as unknown as CallOperation
  const definitionOf = (value: IrValueId): IrOperation | null => (value === 'callee' ? read : null)
  const deriver = {} as RepresentationDeriver
  const aliases = buildHostMethodAliasIndex([body(operations)], placements, hosts)
  const planned = (aliases: ReturnType<typeof buildHostMethodAliasIndex>) =>
    operationConversionInputsOf(
      call,
      null,
      deriver,
      new Map(),
      false,
      undefined,
      definitionOf,
      undefined,
      undefined,
      hosts,
      undefined,
      aliases
    )
  assert.deepEqual(planned(aliases), [])
  assert.deepEqual(planned(new Map()), [{ role: 'call-argument', source: native, target: empty }])
})
