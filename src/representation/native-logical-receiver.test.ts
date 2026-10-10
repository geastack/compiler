import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallableAbi, Representation } from './model.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from './native-logical-receiver.js'
import { nativeCallReceiverText } from '../targets/cpp/emit-native-method.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const reference: Representation = { kind: 'record', shapeId: 'receiver', fields: [], accessors: [], ownership: 'shared-refcount' }
const array: Representation = { kind: 'array-object', element: number, extension: null, ownership: 'shared-refcount' }
const dictionary: Representation = { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' }
const frame: CallableAbi = { receiver: null, parameters: [], result: number, restFrom: null }
const ordinaryFunction: Representation = { kind: 'function-value-dispatch', abi: frame }
const nativeError: Representation = {
  kind: 'native-record-ref',
  shapeId: 'intrinsic-error',
  native: 'gea::runtime::Error',
  ownership: 'shared-refcount'
}
const supported: readonly Representation[] = [
  { kind: 'undefined' },
  { kind: 'void' },
  { kind: 'null' },
  { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
  number,
  { kind: 'scalar', domain: 'boolean' },
  { kind: 'string' },
  { kind: 'symbol' },
  reference,
  array,
  dictionary,
  { ...dictionary, key: 'number' },
  { kind: 'native-record-ref', shapeId: 'native-receiver', native: null, ownership: 'shared-refcount' },
  // A shared typed-array view is an object reference like the buffer it views
  // (a shader uniform's `value.toJSON( meta )` over its typed uniform arms).
  { kind: 'typed-array', element: 'uint8', buffer: 'array-buffer', ownership: 'shared-refcount' },
  { kind: 'array-buffer', ownership: 'shared-refcount' },
  { kind: 'shared-array-buffer', ownership: 'shared-refcount' },
  nativeError,
  ordinaryFunction,
  { kind: 'function', functionId: 'known-source' as never, abi: frame },
  { kind: 'function-family', members: ['source-a', 'source-b'] as never, abi: frame },
  { kind: 'function-value-family', members: ['source-a', 'source-b'] as never, optional: true, abi: frame },
  { kind: 'constructor-family', members: ['constructor-a'] as never, abi: frame },
  { kind: 'constructor-value-dispatch', abi: frame },
  { kind: 'function-and-constructor', call: frame, construct: frame }
]
const unsupported: readonly Representation[] = [
  { ...array, ownership: 'owned' },
  { ...dictionary, ownership: 'owned' },
  { ...dictionary, key: 'symbol' },
  { kind: 'typed-array', element: 'uint8', buffer: 'array-buffer', ownership: 'owned' },
  { kind: 'data-view', ownership: 'shared-refcount' },
  { kind: 'dense-buffer', element: number },
  { kind: 'native-sequence', element: number },
  { ...reference, ownership: 'owned' },
  { kind: 'native-record-ref', shapeId: 'host-date', native: 'Date', ownership: 'shared-refcount' },
  { kind: 'borrowed-ref', referent: reference },
  { ...nativeError, ownership: 'owned' },
  { kind: 'constructor-family', members: ['constructor-a'] as never, abi: { ...frame, receiver: reference } },
  {
    kind: 'constructor-value-dispatch',
    abi: { ...frame, parameters: [{ value: array, ownership: 'shared-refcount', passing: 'by-value' }], restFrom: 0 }
  },
  { kind: 'function-and-constructor', call: frame, construct: { ...frame, receiver: reference } },
  {
    kind: 'function-value-dispatch',
    abi: frame,
    recursive: { type: 'recursive-function' as never, container: 'callable', role: 'definition' }
  },
  { kind: 'proxy-object', target: reference, handler: reference }
]

test('receiver certification and rendering consume the same existing transport inventory', () => {
  for (const representation of supported) {
    const protocol = nativeLogicalReceiverProtocolOf(representation)
    assert.equal(nativeLogicalReceiverProtocolSupported(protocol), true, representation.kind)
    assert.doesNotMatch(
      nativeCallReceiverText(representation, 'held', (_source, value) => `certified(${value})`),
      /::other\(\)/,
      representation.kind
    )
  }
  assert.equal(nativeCallReceiverText(number, 'held'), 'gea::NativeCallReceiver::primitive(static_cast<double>(held))')
  assert.equal(nativeCallReceiverText({ kind: 'string' }, '"text"'), 'gea::NativeCallReceiver::primitive(std::string("text"))')
  assert.equal(nativeCallReceiverText({ kind: 'string' }, 'held'), 'gea::NativeCallReceiver::primitive(std::string(held))')
  assert.equal(nativeCallReceiverText(reference, 'held'), 'gea::NativeCallReceiver::object(held)')
  assert.equal(nativeCallReceiverText(supported[3]!, 'held'), 'gea::NativeCallReceiver::fromValue(held)')
  assert.throws(() => nativeCallReceiverText(ordinaryFunction, 'held'), /certified ABI materializer/)
  assert.match(
    nativeCallReceiverText(ordinaryFunction, 'held', (_source, value) => `certified(${value})`),
    /primitive\(held, \+\[\].*certified\(gea_receiver_source\)/
  )
  assert.equal(nativeCallReceiverText(nativeError, 'held'), 'gea::NativeCallReceiver::object(held)')
})

test('an unsupported native carrier has no admitted erased receiver payload', () => {
  for (const representation of unsupported) {
    assert.equal(nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(representation)), false, representation.kind)
    assert.equal(nativeCallReceiverText(representation, 'held'), 'gea::NativeCallReceiver::other()', representation.kind)
  }
})

test('optional and tagged receivers require support for every live payload arm', () => {
  const optional: Representation = { kind: 'optional', payload: reference, absence: 'null' }
  assert.equal(nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(optional)), true)
  assert.match(nativeCallReceiverText(optional, 'held'), /has_value\(\).*::object\(\(\*held\)\).*::null\(\)/)
  const union: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'record', semanticType: 'record' as never, value: reference, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'owned-array', semanticType: 'owned-array' as never, value: unsupported[0]!, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  assert.equal(nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(union)), false)
  assert.match(nativeCallReceiverText(union, 'held'), /template is<0>.*::object\(gea_receiver.template get<0>\(\)\)/)
  assert.match(nativeCallReceiverText(union, 'held'), /template is<1>.*::other\(\)/)
  assert.equal(
    nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf({ kind: 'optional', payload: union, absence: 'undefined' })),
    false
  )
})
