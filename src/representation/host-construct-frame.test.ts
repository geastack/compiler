import assert from 'node:assert/strict'
import test from 'node:test'
import type { SignatureShape } from '../semantics/model/structural-types.js'
import type { SelectedSignature } from '../semantics/model/selected-signature.js'
import { selectedHostConstructFrameOf } from './derive.js'
import type { CallableAbi, Representation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const entries: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const collection: Representation = {
  kind: 'keyed-collection',
  family: 'weak-map',
  key: { kind: 'string' },
  value: number,
  ownership: 'shared-refcount'
}
const carriers: Record<string, Representation> = {
  'type|length': number,
  'type|entries': entries,
  'type|unresolved': { kind: 'unresolved', reason: 'test' } as never,
  'type|weak-map-default': { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
  'type|typed-array': { kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' } as never
}

/** A deriver that records which shapes it was asked to lay out. */
const recordingDeriver = () => {
  const asked: SignatureShape[] = []
  return {
    asked,
    abiOf: (shape: SignatureShape): CallableAbi => {
      asked.push(shape)
      return {
        parameters: shape.parameters.map((parameter) => ({
          value: carriers[parameter.slot]!,
          ownership: 'owned' as const,
          passing: 'by-value' as const
        })),
        restFrom: null,
        receiver: null,
        result: carriers[shape.result]!
      }
    }
  }
}

const parameter = (type: string, optional = false, rest = false) => ({
  type: type as never,
  slot: type as never,
  optional,
  rest,
  hasInitializer: false
})

// `new <K extends WeakKey = WeakKey, V = any>(entries?: readonly (readonly [K, V])[] | null): WeakMap<K, V>`
const weakMapSignature: SelectedSignature = {
  declaration: 'decl|WeakMapConstructor.new' as never,
  provenance: 'ambient',
  parameters: [parameter('type|entries', true)],
  minimumArity: 0,
  thisParameter: null,
  typeArguments: { kind: 'inferred', reason: 'checker-mapper-not-public' },
  returnType: 'type|weak-map-default' as never
}

// `new (length: number): Float32Array<ArrayBuffer>`
const lengthSignature: SelectedSignature = {
  declaration: 'decl|Float32ArrayConstructor.new' as never,
  provenance: 'ambient',
  parameters: [parameter('type|length')],
  minimumArity: 1,
  thisParameter: null,
  typeArguments: { kind: 'none' },
  returnType: 'type|typed-array' as never
}

test('a zero-argument generic host construction lays out no formal and holds its own result carrier', () => {
  const deriver = recordingDeriver()
  const frame = selectedHostConstructFrameOf(deriver, weakMapSignature, 0, collection)
  assert.deepEqual(frame, { parameters: [], restFrom: null, receiver: null, result: collection })
  // The omitted `entries` formal -- whose K/V the checker inferred and withholds -- is never derived.
  assert.deepEqual(
    deriver.asked.map((shape) => shape.parameters.length),
    [0]
  )
})

test('a filled formal of an inferred generic overload has no frame', () => {
  assert.equal(selectedHostConstructFrameOf(recordingDeriver(), weakMapSignature, 1, collection), null)
})

test('a non-generic host overload lays out exactly the formals the site fills', () => {
  const result = carriers['type|typed-array']!
  const frame = selectedHostConstructFrameOf(recordingDeriver(), lengthSignature, 1, result)
  assert.deepEqual(
    frame?.parameters.map((slot) => slot.value),
    [number]
  )
  assert.equal(frame?.result, result)
})

test('an arity the checker could not have selected, a source overload, a rest formal and an unresolved formal have no frame', () => {
  const result = carriers['type|typed-array']!
  assert.equal(selectedHostConstructFrameOf(recordingDeriver(), lengthSignature, 0, result), null)
  assert.equal(selectedHostConstructFrameOf(recordingDeriver(), lengthSignature, 2, result), null)
  assert.equal(selectedHostConstructFrameOf(recordingDeriver(), { ...lengthSignature, provenance: 'source' }, 1, result), null)
  assert.equal(
    selectedHostConstructFrameOf(
      recordingDeriver(),
      { ...lengthSignature, parameters: [parameter('type|length', false, true)] },
      1,
      result
    ),
    null
  )
  assert.equal(
    selectedHostConstructFrameOf(recordingDeriver(), { ...lengthSignature, parameters: [parameter('type|unresolved')] }, 1, result),
    null
  )
})
