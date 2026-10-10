import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { recipeHasNormalResult, recipeIsMaterializableWithoutPriorSourceGuard, recipePreservesNativePayload } from './recipe-closure.js'
import type { Representation } from '../representation/model.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'

const value: Representation = { kind: 'string' }
const node = (id: string): ConversionNode => ({ id, source: value, target: value, capability: { kind: 'identity' } })

test('future recipe admission checks guarded dependencies and their own authentication contracts', () => {
  const guarded: ConversionNode = {
    ...node('guarded'),
    capability: {
      kind: 'static',
      materializer: { id: 'test:guarded', domain: 'guarded', allocates: false, requiresSourceGuard: true }
    }
  }
  const outer = (child: ConversionNode): ConversionNode => ({
    ...node('outer'),
    capability: {
      kind: 'static',
      materializer: { id: 'test:outer', domain: 'outer', allocates: false, dependencies: [child] }
    }
  })
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(outer(guarded)), false)
  const checked: ConversionNode = {
    ...guarded,
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:checked',
        domain: 'checked',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true
      }
    }
  }
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(outer(checked)), true)
  assert.equal(
    recipeIsMaterializableWithoutPriorSourceGuard(outer({ ...node('missing'), capability: { kind: 'never', reason: 'missing' } })),
    false
  )
})

test('future recipe admission authenticates cited identities and unresolved recursive guards', () => {
  const canonical = node('canonical')
  assert.equal(
    recipeIsMaterializableWithoutPriorSourceGuard(canonical, () => canonical),
    true
  )
  assert.equal(
    recipeIsMaterializableWithoutPriorSourceGuard({ ...canonical }, () => canonical),
    false
  )
  const recursive: ConversionNode = { ...node('recursive'), capability: { kind: 'recursive-ref', node: 'unresolved' } }
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(recursive), false)
})

test('renderable dead arms cannot prove a normal stored value through wrapped or cited recipes', () => {
  const abrupt: ConversionNode = {
    ...node('abrupt'),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:dead-arm',
        domain: 'dead-arm',
        allocates: false,
        nativeFieldProtocol: 'unused',
        normalCompletion: 'never'
      }
    }
  }
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(abrupt), true, 'dead-arm emission remains available')
  assert.equal(recipeHasNormalResult(abrupt), false)
  const outer: ConversionNode = {
    ...node('outer'),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:outer',
        domain: 'outer',
        allocates: false,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved',
        dependencies: [abrupt]
      }
    }
  }
  assert.equal(recipeHasNormalResult(outer), false)
  const wrapped: ConversionNode = {
    ...node('wrapped'),
    capability: { kind: 'optional', absenceTag: 'Undefined', payload: abrupt.capability }
  }
  assert.equal(recipeHasNormalResult(wrapped), false)
  const identity = node('identity')
  assert.equal(
    recipeHasNormalResult(identity, () => identity),
    true
  )
  assert.equal(
    recipeHasNormalResult({ ...identity }, () => identity),
    false
  )
})

test('native storage proof rejects coercion, discard and non-preserving dependency recipes', () => {
  const preserved: ConversionNode = {
    ...node('preserved'),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:preserved',
        domain: 'preserved',
        allocates: false,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved'
      }
    }
  }
  assert.equal(recipePreservesNativePayload(preserved), true)
  const discard: ConversionNode = {
    ...node('discard'),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:discard',
        domain: 'discard',
        allocates: false,
        nativeFieldProtocol: 'unused'
      }
    }
  }
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(discard), true)
  assert.equal(recipeHasNormalResult(discard), true)
  assert.equal(recipePreservesNativePayload(discard), false)
  const outer: ConversionNode = {
    ...preserved,
    id: 'outer',
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:outer',
        domain: 'outer',
        allocates: false,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved',
        dependencies: [discard]
      }
    }
  }
  assert.equal(recipePreservesNativePayload(outer), false)
  const coercion: ConversionNode = {
    ...node('coercion'),
    capability: {
      kind: 'coercion',
      operation: 'ToString',
      materializer: {
        id: 'test:coercion',
        domain: 'coercion',
        allocates: false,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved'
      }
    }
  }
  assert.equal(recipePreservesNativePayload(coercion), false)
})

test('abrupt sum alternatives preserve only the normal alternatives and cannot prove a naked stored value', () => {
  const abrupt: ConversionNode = {
    ...node('abrupt-sum-leaf'),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:throw',
        domain: 'throw',
        allocates: false,
        nativeFieldProtocol: 'unused',
        nativePayloadTransport: 'preserved',
        normalCompletion: 'never'
      }
    }
  }
  const sum: ConversionNode = {
    ...node('normal-sum'),
    capability: {
      kind: 'sum',
      arms: [
        { tag: 'absent', classifier: { id: 'test:tag', domain: 'absent' }, capability: abrupt.capability },
        { tag: 'value', classifier: { id: 'test:tag', domain: 'value' }, capability: { kind: 'identity' } }
      ]
    }
  }
  assert.equal(recipeHasNormalResult(abrupt), false)
  assert.equal(recipePreservesNativePayload(abrupt), false)
  assert.equal(recipeHasNormalResult(sum), true)
  assert.equal(recipePreservesNativePayload(sum), true)
})

test('canonical optional wraps transport live numbers while unreachable and discard recipes do not size native storage', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const wrapped = census.nodeFor(number, optional)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(wrapped, census.nodeById), true)
  assert.equal(recipeHasNormalResult(wrapped, census.nodeById), true)
  assert.equal(recipePreservesNativePayload(wrapped, census.nodeById), true)
  const absent = census.nodeFor({ kind: 'undefined' }, optional)
  assert.equal(recipeHasNormalResult(absent, census.nodeById), true)
  assert.equal(recipePreservesNativePayload(absent, census.nodeById), true)
  const abrupt = census.nodeFor({ kind: 'undefined' }, number)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(abrupt, census.nodeById), true)
  assert.equal(recipeHasNormalResult(abrupt, census.nodeById), false)
  assert.equal(recipePreservesNativePayload(abrupt, census.nodeById), false)
  const discarded = census.nodeFor(number, { kind: 'undefined' })
  assert.equal(recipeHasNormalResult(discarded, census.nodeById), true)
  assert.equal(recipePreservesNativePayload(discarded, census.nodeById), false)
  assert.equal(
    recipePreservesNativePayload(census.nodeFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, number), census.nodeById),
    false
  )
})
