import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../representation/model.js'
import { typeofPresentTextFor, typeofTextFor } from './emit-typeof.js'
import { createCppTargetManifest, withCppIrOperandHelpers } from './manifest.js'
import { createIrBodyBuilder } from '../../ir/build.js'

test('an installed host object path has no native undefined cell to inspect', () => {
  const object: Representation = { kind: 'native-record-ref', native: null, shapeId: 'host' as never, ownership: 'shared-refcount' }
  assert.equal(typeofTextFor(object), null)
  assert.equal(typeofPresentTextFor(object), 'object')
  assert.equal(typeofPresentTextFor({ kind: 'optional', payload: object, absence: 'undefined' }), 'object')
})

test('present callable namespaces retain their function tag without guessing for mixed carriers', () => {
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], result: { kind: 'void' }, restFrom: null }
  }
  assert.equal(typeofPresentTextFor(callable), 'function')
  assert.equal(typeofPresentTextFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }), null)
  assert.equal(typeofPresentTextFor({ kind: 'undefined' }), null)
})

test('the final manifest answers actual lowered typeof carriers without granting an unresolved operand', () => {
  const semantic: Representation = { kind: 'scalar', domain: 'number' }
  const manifest = createCppTargetManifest({ selected: new Map(), evidence: new Map(), conflicts: [] }, undefined, [
    semantic,
    { kind: 'unresolved', reason: 'missing native storage' }
  ])
  const builder = createIrBodyBuilder('typeof-manifest-body' as never, 'typeof-manifest-owner' as never, null)
  const entry = builder.openBlock()
  const carrier: Representation = { kind: 'undefined' }
  const value = builder.parameter(entry, 'typeof-manifest-operand' as never, 0, carrier)
  builder.compute(entry, 'typeof-manifest-result' as never, 'typeof', 'typeof', [{ value, representation: carrier }], { kind: 'string' })
  builder.return(entry, null, null)
  const final = withCppIrOperandHelpers(manifest, [builder.seal()])
  assert.equal(manifest.runtimeHelpers.has('computation:typeof:undefined'), false)
  assert.equal(final.runtimeHelpers.has('computation:typeof:undefined'), true)
  assert.equal(final.runtimeHelpers.has('computation:typeof:unresolved'), false)
  assert.ok([...manifest.runtimeHelpers].every((key) => final.runtimeHelpers.has(key)))
})
