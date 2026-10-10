import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { FunctionId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { GetIteratorOperation, IteratorNextOperation } from './model.js'
import { nativeIteratorLogicalReceiverAdmitted } from './native-iterator-receivers.js'
import { allOperationsOf } from './model.js'

const frame: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const method: Representation = { kind: 'function-value-dispatch', abi: frame }
const cursor = (value: Representation, ownership: 'owned' | 'shared-refcount'): Representation => ({
  kind: 'record',
  shapeId: 'cursor',
  ownership,
  fields: [{ key: 'next', value, required: true }],
  accessors: []
})
const step = (receiver: Representation): IteratorNextOperation => ({
  kind: 'iterator-next',
  lineage: 'step' as never,
  iterator: { value: 'cursor' as never, representation: receiver },
  value: null,
  result: { id: 'step' as never, representation: { kind: 'void' } }
})
const deriver = { layoutOf: () => cursor(method, 'owned') } as unknown as RepresentationDeriver
const admitted = (operation: IteratorNextOperation) =>
  nativeIteratorLogicalReceiverAdmitted(operation, deriver, new Map(), new Set(), () => false)

test('protocol calls preserve shared native receivers and exact physical owned receiver frames', () => {
  assert.equal(admitted(step(cursor(method, 'shared-refcount'))), true)
  const owned = cursor(method, 'owned')
  const physical: Representation = { ...method, abi: { ...frame, receiver: owned } }
  assert.equal(admitted(step(cursor(physical, 'owned'))), true)
  assert.equal(admitted(step(cursor(method, 'owned'))), false)
  assert.equal(admitted(step(cursor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, 'owned'))), false)
})

test('an unsupported erased iterator receiver needs positive physical body or method-value provenance', () => {
  const source = 'independent-body' as FunctionId
  const fixed: Representation = { kind: 'function', functionId: source, abi: frame }
  assert.equal(
    nativeIteratorLogicalReceiverAdmitted(step(cursor(fixed, 'owned')), deriver, new Map(), new Set(), (id) => id === source),
    true
  )
  assert.equal(
    nativeIteratorLogicalReceiverAdmitted(step(cursor(fixed, 'owned')), deriver, new Map(), new Set(), () => false),
    false
  )
  const get: GetIteratorOperation = {
    kind: 'get-iterator',
    lineage: 'get-cursor' as never,
    protocol: 'iterator',
    receiver: { value: 'iterable' as never, representation: cursor(method, 'owned') },
    method: { value: 'method' as never, representation: method },
    result: { id: 'iterator' as never, representation: cursor(method, 'shared-refcount') }
  }
  assert.equal(
    nativeIteratorLogicalReceiverAdmitted(get, deriver, new Map(), new Set(), () => false),
    false
  )
  assert.equal(
    nativeIteratorLogicalReceiverAdmitted(get, deriver, new Map(), new Set(['method' as never]), () => false),
    true
  )
})

test('explicit dynamic-this cursor methods enter public method slots without losing the real receiver', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/iterator-protocol-preserves-logical-receiver.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.ok(result.source !== null, JSON.stringify(result.emissionRefusals))
  const bodies = [...(result.irBodies?.values() ?? [])]
  const acquire = bodies
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .find((operation) => operation.kind === 'get-iterator')
  assert.ok(acquire?.kind === 'get-iterator' && acquire.nativeNextMethodRead)
  assert.equal(acquire.nativeNextMethodRead.read.receiver, acquire.result.id)
  assert.equal(acquire.nativeNextMethodRead.read.key, 'next')
  const next = bodies
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .find((operation) => operation.kind === 'iterator-next')
  assert.ok(next?.kind === 'iterator-next' && next.nativeMethodRead)
  assert.equal(next.nativeMethodRead.read.key, 'next')
  assert.equal(next.nativeMethodRead.value.kind, 'function-value-dispatch')
  assert.ok(
    next.nativeMethodRead.read.sources.some(
      (entry) => entry.source.kind === 'function-value-dispatch' && entry.source.abi.receiver?.kind === 'dynamic'
    )
  )
  const close = bodies.flatMap((body) => body.iteratorCloseRegions ?? [])[0]
  assert.ok(close?.nativeMethodRead)
  assert.equal(close.nativeMethodRead.read.key, 'return')
  assert.ok(result.source.includes('gea::record::readLiveField<'))
  assert.ok(result.source.includes('callWithReceiver'))
})
