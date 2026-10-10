import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { declaredStringPrototypeMemberNames } from '../representation/prototype-domains.js'
import {
  mixedPrototypeCallArmsOf,
  nativePrototypeMethodOf,
  nativeHostReflectionMemberOf,
  prototypeArmHasNoCallableMember,
  prototypeEntryMayBeCallable
} from './native-prototype-methods.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: { receiver: null, parameters: [], result: number, restFrom: null }
}
const array: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const dictionary: Representation = { kind: 'dictionary', key: 'string', value: { kind: 'string' }, ownership: 'shared-refcount' }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' },
    value
  }))
})

test('complete mixed prototype dispatch keeps native and provably noncallable alternatives', () => {
  const claims = mixedPrototypeCallArmsOf(sum(dictionary, { kind: 'string' }, array), 'join', (arm) => nativePrototypeMethodOf(arm, 'join'))
  assert.deepEqual(claims, [null, null, 'array-object'])
  assert.equal(
    mixedPrototypeCallArmsOf(sum(dictionary, { kind: 'string' }), 'join', (arm) => nativePrototypeMethodOf(arm, 'join')),
    null
  )
  assert.equal(
    mixedPrototypeCallArmsOf(sum({ ...dictionary, value: callable }, array), 'join', (arm) => nativePrototypeMethodOf(arm, 'join')),
    null
  )
  assert.equal(
    mixedPrototypeCallArmsOf(sum(dictionary, array), 'valueOf', () => null),
    null
  )
})

test('native handles, borrowed Functions and callable Proxy targets cannot be claimed as impossible call arms', () => {
  const handle: Representation = {
    kind: 'native-handle',
    protocol: 'CallableHost',
    native: null,
    version: 1,
    bases: [],
    call: callable.abi,
    construct: null
  }
  const borrowed: Representation = { kind: 'borrowed-ref', referent: callable }
  const proxy: Representation = {
    kind: 'proxy-object',
    target: callable,
    handler: { kind: 'record', shapeId: 'handler', fields: [], accessors: [], ownership: 'shared-refcount' }
  }
  for (const value of [handle, borrowed, proxy, { kind: 'dynamic', reason: 'declared-any-never-narrowed' } as Representation]) {
    assert.equal(prototypeEntryMayBeCallable(value), true, value.kind)
    assert.equal(prototypeArmHasNoCallableMember({ ...dictionary, value }, 'join'), false, value.kind)
    assert.equal(
      mixedPrototypeCallArmsOf(sum({ ...dictionary, value }, array), 'join', (arm) => nativePrototypeMethodOf(arm, 'join')),
      null
    )
  }
})

test('unimplemented String prototype members are present and never substitute a guaranteed TypeError', () => {
  for (const key of [
    'anchor',
    'bold',
    'isWellFormed',
    'toWellFormed',
    'matchAll',
    'toLocaleLowerCase',
    'toLocaleUpperCase',
    'trimLeft',
    'trimRight'
  ]) {
    assert.equal(prototypeArmHasNoCallableMember({ kind: 'string' }, key), false, key)
    assert.equal(nativePrototypeMethodOf({ kind: 'string' }, key), null, key)
  }
  assert.equal(prototypeArmHasNoCallableMember({ kind: 'string' }, 'join'), true)
})

test('the declared String domain includes every own callable member of the execution host', () => {
  for (const key of Object.getOwnPropertyNames(String.prototype)) {
    if (typeof Object.getOwnPropertyDescriptor(String.prototype, key)?.value !== 'function') continue
    assert.equal(declaredStringPrototypeMemberNames.has(key), true, `String.prototype.${key}`)
  }
})

test('host-owned Function properties cannot borrow an inherited reflection template', () => {
  const protocols = new Set(['CustomHost'])
  assert.equal(nativeHostReflectionMemberOf(new Map(), protocols, 'CustomHost', 'hasOwnProperty'), true)
  assert.equal(nativeHostReflectionMemberOf(new Map(), new Set(), 'CustomHost', 'hasOwnProperty'), false)
  assert.equal(
    nativeHostReflectionMemberOf(
      new Map([['CustomHost.hasOwnProperty', { kind: 'property', store: null, emit: 'native_function' }]]),
      protocols,
      'CustomHost',
      'hasOwnProperty'
    ),
    false
  )
  assert.equal(
    nativeHostReflectionMemberOf(
      new Map([['CustomHost.hasOwnProperty', { kind: 'method', emit: 'native_call()', arity: 0 }]]),
      protocols,
      'CustomHost',
      'hasOwnProperty'
    ),
    false
  )
})
