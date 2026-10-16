import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeNativeIterableProviders, readNativeIterableProviders } from './native-iterable-providers.js'

const provider = () => ({
  protocol: 'host-sync-iterable@1',
  receiverNative: 'host::Collection',
  memberModel: 'native-fixed-member',
  iteratorFactory: { kind: 'method', arity: 0, emit: 'host::values({receiver})' }
})
const read = (value: unknown) => readNativeIterableProviders(new Map([['host::Collection', value]]))

test('versioned native metadata keeps the real typed zero-argument factory', () => {
  assert.deepEqual(read(provider()).get('host::Collection'), provider())
  assert.equal(readNativeIterableProviders(new Map()).size, 0)
})

test('missing or mismatched provider identities do not default to an iterable', () => {
  for (const patch of [
    { protocol: undefined },
    { protocol: 'host-sync-iterable@2' },
    { receiverNative: 'other' },
    { memberModel: 'readonly-typescript' }
  ])
    assert.throws(() => read({ ...provider(), ...patch }))
  assert.throws(() => readNativeIterableProviders({}))
})

test('dynamic, variadic, property and raw receiver factories cannot claim this ABI', () => {
  for (const patch of [
    { result: 'dynamic' },
    { arity: 'variadic' },
    { arity: 1 },
    { kind: 'property' },
    { receiver: 'raw' },
    { receiver: 'unknown' },
    { emit: 'host::values({receiver}, {arg0})' },
    { emit: '' }
  ])
    assert.throws(() => read({ ...provider(), iteratorFactory: { ...provider().iteratorFactory, ...patch } }))
})

test('multiple plugins cannot silently replace a native carrier factory', () => {
  const first = read(provider())
  assert.equal(mergeNativeIterableProviders([undefined, first, first]).size, 1)
  const other = read({ ...provider(), iteratorFactory: { ...provider().iteratorFactory, emit: 'other::iterator({receiver})' } })
  assert.throws(() => mergeNativeIterableProviders([first, other]))
})
