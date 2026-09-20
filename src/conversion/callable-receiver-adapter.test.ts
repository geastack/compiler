import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { resultAdaptedCallableText, resultAdapterTransportOf } from '../targets/cpp/emit-narrowing.js'
import { createConversionNodes } from './nodes.js'
import { nativeCallablePrefixAdapterMatches, nativeReceiverIgnoringCallableAdapterMatches } from './native-callable-adapter.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const receiver: Representation = {
  kind: 'class-ref',
  declaration: 'callback-owner' as DeclarationId,
  shapeId: 'callback-owner',
  ancestors: [],
  ownership: 'shared-refcount'
}
const source: Extract<Representation, { kind: 'function-value-dispatch' }> = {
  kind: 'function-value-dispatch',
  abi: {
    parameters: [{ value: number, passing: 'by-value', ownership: 'owned' }],
    result: number,
    receiver: null,
    restFrom: null
  }
}
const target: Representation = { ...source, abi: { ...source.abi, receiver } }

test('a receiver-free callable fills a typed method slot without shifting its ordinary arguments', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(source, target)
  assert.equal(node.capability.kind, 'atom')
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(source, target, node), true)
  const transport = resultAdapterTransportOf(source, target)
  assert.deepEqual(transport?.nativeConventions, { from: source.abi, to: target.abi })
  const text = resultAdaptedCallableText(source, target, 'source')
  assert.ok(text !== null)
  assert.ok(text.includes('::adaptSource('))
  assert.ok(text.includes('gea_adapt_receiver'))
  assert.ok(text.includes('->call(gea_adapt_arg_0)'))
  assert.ok(!text.includes('gea::Value') && !text.includes('unbox'))
})

test('the same adapter never invents a missing dynamic receiver', () => {
  assert.equal(resultAdapterTransportOf(target, source), null)
  assert.equal(resultAdaptedCallableText(target, source, 'method'), null)
  assert.equal(resultAdapterTransportOf(source, source), null)
})

test('receiver adapter provenance needs the selected identity and exact ordinary frame proofs', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(source, target)
  const capability = node.capability
  assert.ok(capability.kind === 'atom')
  const { callableIdentityTransport: _identity, ...unproven } = capability.materializer
  assert.equal(
    nativeReceiverIgnoringCallableAdapterMatches(source, target, {
      ...node,
      capability: { ...capability, materializer: unproven }
    }),
    false
  )
  const changed: Representation = {
    ...source,
    abi: { ...source.abi, receiver, result: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  }
  const changedNode = census.nodeFor(source, changed)
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(source, changed, changedNode), false)
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(source, target, changedNode), false)
  assert.equal(
    nativeReceiverIgnoringCallableAdapterMatches(source, target, {
      ...node,
      capability: { ...capability, materializer: { ...capability.materializer, callableAdapter: { from: target.abi, to: target.abi } } }
    }),
    false
  )
  const reordered: Representation = {
    ...source,
    abi: { ...source.abi, receiver, parameters: [{ value: { kind: 'string' }, ownership: 'owned', passing: 'by-value' }] }
  }
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(source, reordered, census.nodeFor(source, reordered)), false)
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(target, source, census.nodeFor(target, source)), false)
})

test('a cited native method adapter ignores extra public arguments while retaining its original receiver and identity', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const empty: Representation = { ...source, abi: { ...source.abi, receiver, parameters: [] } }
  const publicFrame: Representation = { ...source, abi: { ...source.abi, receiver } }
  const node = census.nodeFor(empty, publicFrame)
  assert.equal(nativeCallablePrefixAdapterMatches(empty, publicFrame, node), true)
  assert.equal(nativeCallablePrefixAdapterMatches(empty, publicFrame, undefined), false)
  assert.equal(nativeCallablePrefixAdapterMatches(publicFrame, empty, census.nodeFor(publicFrame, empty)), false)
  assert.equal(nativeCallablePrefixAdapterMatches(source, target, census.nodeFor(source, target)), true)
  const wrongPrefix: Representation = {
    ...source,
    abi: { ...source.abi, receiver, parameters: [{ value: { kind: 'string' }, ownership: 'owned', passing: 'by-value' }] }
  }
  assert.equal(nativeCallablePrefixAdapterMatches(source, wrongPrefix, census.nodeFor(source, wrongPrefix)), false)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const { callableIdentityTransport: _identity, ...unproven } = node.capability.materializer
  assert.equal(
    nativeCallablePrefixAdapterMatches(empty, publicFrame, {
      ...node,
      capability: { ...node.capability, materializer: unproven }
    }),
    false
  )
})

test('an inherited native method slot transports a derived callback receiver without requesting boxed fields', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const child: Representation = {
    ...receiver,
    declaration: 'callback-child' as DeclarationId,
    shapeId: 'callback-child',
    ancestors: [receiver.declaration]
  }
  const from: Representation = { ...source, abi: { ...source.abi, receiver: child } }
  const to: Representation = { ...source, abi: { ...source.abi, receiver } }
  const node = census.nodeFor(from, to)
  assert.equal(nativeCallablePrefixAdapterMatches(from, to, node), true)
  const text = resultAdaptedCallableText(from, to, 'callback')
  assert.ok(text !== null)
  assert.ok(text.includes('downcastClassRef'))
  assert.ok(!text.includes('gea::Value') && !text.includes('unbox'))
  const unrelated: Representation = { ...receiver, declaration: 'unrelated-owner' as DeclarationId, shapeId: 'unrelated-owner' }
  const wrong: Representation = { ...source, abi: { ...source.abi, receiver: unrelated } }
  assert.equal(nativeCallablePrefixAdapterMatches(from, wrong, census.nodeFor(from, wrong)), false)
})

test('receiver inheritance and dropped public parameters compose in one certified native adapter', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const child: Representation = {
    ...receiver,
    declaration: 'combined-callback-child' as DeclarationId,
    shapeId: 'combined-callback-child',
    ancestors: [receiver.declaration]
  }
  const original: Representation = { ...source, abi: { ...source.abi, receiver: child, parameters: [] } }
  const publicFrame: Representation = {
    ...source,
    abi: { ...source.abi, receiver, parameters: Array.from({ length: 3 }, () => source.abi.parameters[0]!) }
  }
  const node = census.nodeFor(original, publicFrame)
  assert.equal(nativeCallablePrefixAdapterMatches(original, publicFrame, node), true)
  const text = resultAdaptedCallableText(original, publicFrame, 'callback')
  assert.ok(text !== null)
  assert.ok(text.includes('downcastClassRef') && text.includes('gea_adapt_arg_2'))
  assert.ok(!text.includes('gea::Value') && !text.includes('unbox'))
  assert.equal(nativeCallablePrefixAdapterMatches(publicFrame, original, census.nodeFor(publicFrame, original)), false)
})
