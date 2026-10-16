import assert from 'node:assert/strict'
import test from 'node:test'
import { hostMemberReadsOf } from '../dist/targets/cpp/host/emit-host-properties.js'
const receiver = {
  value: 'root',
  representation: { kind: 'native-record-ref', shapeId: 'window', ownership: 'owned', native: 'native::Window' }
}
const operation = {
  kind: 'get',
  lineage: 'get-source',
  receiver,
  key: { value: 'key', representation: { kind: 'string' } },
  result: { id: 'method', representation: { kind: 'dynamic' } },
  hostMethod: { protocol: 'Window', member: 'listen' }
}
const hosts = { members: new Map([['Window.listen', { kind: 'method', arity: 2, emit: 'native::window.listen({arg0}, {arg1})' }]]) }
function read(census) {
  const body = {
    blocks: new Map([['entry', { operations: [operation], terminator: { kind: 'return', value: null } }]]),
    hostNamespaceCensus: census
  }
  return hostMemberReadsOf(body, hosts, new Map(), new Map(), new Map()).get('method')
}
const namespace = {
  reads: new Map([['root', 'window']]),
  values: new Map(),
  functionReads: new Map(),
  definitelyPresent: new Set(['root'])
}
test('authenticated present namespace receiver stays a path in deferred native method', () => {
  assert.equal(read(namespace).receiver, null)
})
test('ordinary native objects retain their actual receiver operand', () => {
  assert.deepEqual(read({ ...namespace, reads: new Map() }).receiver, receiver)
})
test('possibly absent namespace is not granted the present path exemption', () => {
  assert.deepEqual(read({ ...namespace, definitelyPresent: new Set() }).receiver, receiver)
})
