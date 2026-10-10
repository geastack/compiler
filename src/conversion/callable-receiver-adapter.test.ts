import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { resultAdaptedCallableText, resultAdapterTransportOf } from '../targets/cpp/emit-narrowing.js'
import { createConversionNodes } from './nodes.js'
import {
  nativeCallableEntryReceiverOf,
  nativeCallableIdentityTransportMatches,
  nativeCallableDynamicIdentityTransportMatches,
  nativeCallablePrefixAdapterMatches,
  nativeReceiverIgnoringCallableAdapterMatches
} from './native-callable-adapter.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { recipeClosureOf } from './recipe-closure.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { callablePayloadText } from '../targets/cpp/emit-callable-view.js'
import { nativeMethodReceiverAdmitted } from './native-method.js'
import { nativeUnboundMethodText } from '../targets/cpp/emit-native-method.js'

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

test('contextual explicit any-this erasure retains identity and a field-observing receiver boundary', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const physical: Representation = { ...source, abi: { ...source.abi, receiver: dynamic } }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(nativeMethodReceiverAdmitted(dynamic), false)
  const node = census.nativeMethodFor(physical, source)
  assert.ok(node?.capability.kind === 'static')
  assert.equal(node.capability.materializer.nativeFieldProtocol, undefined)
  assert.equal(nativeCallableIdentityTransportMatches(physical, source, node), true)
  const contract = node.capability.materializer.nativeMethod!
  const text = nativeUnboundMethodText(contract, 'source')
  assert.ok(text.includes('unboundMethodAs<gea::Value>'))
  assert.ok(text.includes('gea_receiver.dynamicValue()'))
  assert.ok(!text.includes('gea::Value::box'))
})

test('a declared-any Function boundary retains identity without claiming native frame execution or suppressing reflection', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const [from, to] of [
    [source, dynamic],
    [dynamic, source]
  ] as const) {
    const node = census.nodeFor(from, to)
    assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
    assert.equal(nativeCallableDynamicIdentityTransportMatches(from, to, node), true)
    assert.equal(node.capability.materializer.nativeFieldProtocol, undefined)
    assert.equal(nativeCallableEntryReceiverOf(from, to, node), null)
    const { callableIdentityTransport: _identity, ...unproven } = node.capability.materializer
    assert.equal(
      nativeCallableDynamicIdentityTransportMatches(from, to, {
        ...node,
        capability: { kind: 'static', materializer: unproven }
      }),
      false
    )
    assert.equal(nativeCallableDynamicIdentityTransportMatches(to, from, node), false)
  }
  assert.equal(nativeCallableDynamicIdentityTransportMatches(number, dynamic, census.nodeFor(number, dynamic)), false)
})

test('native source-only entries preserve Function identity separately from their logical receiver frame', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const method = census.nativeMethodFor(target, source)!
  assert.ok(method)
  assert.equal(nativeCallableIdentityTransportMatches(target, source, method), true)
  assert.equal(nativeCallableEntryReceiverOf(target, source, method), 'logical')
  assert.equal(nativeCallablePrefixAdapterMatches(target, source, method), false)
  assert.equal(nativeCallableIdentityTransportMatches(target, source, census.nodeFor(target, source)), false)
  assert.equal(nativeCallableEntryReceiverOf(target, source, undefined), null)
  assert.ok(method.capability.kind === 'static')
  const { callableIdentityTransport: _identity, ...unproven } = method.capability.materializer
  assert.equal(
    nativeCallableIdentityTransportMatches(target, source, { ...method, capability: { kind: 'static', materializer: unproven } }),
    false
  )
  assert.equal(
    nativeCallableEntryReceiverOf(target, source, {
      ...method,
      capability: {
        kind: 'static',
        materializer: {
          ...method.capability.materializer,
          nativeMethod: { ...method.capability.materializer.nativeMethod!, source: source.abi }
        }
      }
    }),
    null
  )
})

test('native result adapters keep Function identity without claiming their transformed result is a body transport', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const unknownResult: Representation = {
    ...source,
    abi: { ...source.abi, result: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  }
  const method = census.nativeMethodFor(target, unknownResult)!
  assert.ok(method)
  assert.equal(nativeCallableIdentityTransportMatches(target, unknownResult, method), true)
  assert.equal(nativeCallableEntryReceiverOf(target, unknownResult, method), null)
  const reordered: Representation = {
    ...source,
    abi: { ...source.abi, parameters: [{ value: { kind: 'string' }, ownership: 'owned', passing: 'by-value' }] }
  }
  const mismatch = census.nativeMethodFor(target, reordered)!
  assert.ok(mismatch)
  assert.equal(nativeCallableEntryReceiverOf(target, reordered, mismatch), null)
})

test('a receiver-free callable fills a typed method slot without shifting its ordinary arguments', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(source, target)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  assert.ok(node.capability.materializer.callableView)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById), true)
  assert.equal(nativeReceiverIgnoringCallableAdapterMatches(source, target, node), true)
  const transport = resultAdapterTransportOf(source, target)
  assert.deepEqual(transport?.nativeConventions, { from: source.abi, to: target.abi })
  const text = resultAdaptedCallableText(source, target, 'source')
  assert.ok(text !== null)
  assert.ok(text.includes('::adaptSourceWithReceiver<-1, false, true>('))
  assert.ok(text.includes('gea_adapt_receiver'))
  assert.ok(text.includes('->callWithReceiver(gea::NativeCallReceiver::object(gea_adapt_receiver), gea_adapt_arg_0)'))
  assert.ok(!text.includes('gea::Value') && !text.includes('unbox'))
})

test('sealed callable recipes publish identity independently of their exact field transport leaves', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const result: Representation = {
    kind: 'record',
    shapeId: 'observed-callback-result',
    ownership: 'shared-refcount',
    fields: [{ key: 'payload', value: number, required: true }],
    accessors: []
  }
  const physical: Representation = { ...source, abi: { ...source.abi, result } }
  const publicFrame: Representation = {
    ...source,
    abi: { ...source.abi, result: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  }
  const observed = census.nodeFor(physical, publicFrame)
  assert.ok(observed.capability.kind === 'atom' || observed.capability.kind === 'static')
  assert.equal(nativeCallableIdentityTransportMatches(physical, publicFrame, observed), true)
  assert.equal(observed.capability.materializer.callableAdapter, undefined)
  assert.equal(observed.capability.materializer.nativeFieldProtocol, undefined)
  assert.equal(observed.capability.materializer.callableView?.result?.source, result)

  const native = census.nodeFor(source, target)
  assert.ok(native.capability.kind === 'atom' || native.capability.kind === 'static')
  assert.equal(native.capability.materializer.callableIdentityTransport, 'preserved')
  assert.equal(native.capability.materializer.nativeFieldProtocol, 'unused')
  assert.deepEqual(native.capability.materializer.callableAdapter, { from: source.abi, to: target.abi })
  assert.equal(nativeCallableIdentityTransportMatches(source, target, native), true)
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
  assert.ok(capability.kind === 'atom' || capability.kind === 'static')
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
  assert.ok(node.capability.materializer.callableView)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById), true)
  const { callableIdentityTransport: _identity, ...unproven } = node.capability.materializer
  assert.equal(
    nativeCallablePrefixAdapterMatches(empty, publicFrame, {
      ...node,
      capability: { ...node.capability, materializer: unproven }
    }),
    false
  )
})

test('a future base receiver cannot enter a derived callback without an authenticated native method entry', () => {
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
  assert.equal(node.capability.kind, 'never')
  assert.equal(nativeCallablePrefixAdapterMatches(from, to, node), false)
  const method = census.nativeMethodFor(from, to)
  assert.ok(method)
  assert.ok(method.capability.kind === 'static')
  assert.ok(method.capability.materializer.nativeMethod)
  assert.equal(method.capability.materializer.nativeMethod.receiver, child)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(method, census.nodeById), true)
  const unrelated: Representation = { ...receiver, declaration: 'unrelated-owner' as DeclarationId, shapeId: 'unrelated-owner' }
  const wrong: Representation = { ...source, abi: { ...source.abi, receiver: unrelated } }
  assert.equal(nativeCallablePrefixAdapterMatches(from, wrong, census.nodeFor(from, wrong)), false)
})

test('an inherited native self-result checks its actual allocation without admitting an ordinary future downcast', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const child: Representation = {
    ...receiver,
    declaration: 'self-result-child' as DeclarationId,
    shapeId: 'self-result-child',
    ancestors: [receiver.declaration]
  }
  const original: Representation = { ...source, abi: { ...source.abi, receiver, result: receiver } }
  const publicFrame: Representation = { ...original, abi: { ...original.abi, result: child } }
  assert.equal(census.nodeFor(original, publicFrame).capability.kind, 'never')
  const method = census.nativeMethodFor(original, publicFrame)
  assert.ok(method?.capability.kind === 'static')
  const frame = method.capability.materializer.nativeMethod?.frameAdaptation
  assert.ok(frame?.capability.kind === 'static')
  const result = frame.capability.materializer.callableView?.result
  assert.ok(result?.capability.kind === 'static')
  const checked = result.capability.materializer.nativeMethodResult?.checked
  assert.equal(checked, census.assertedClassDowncastFor(receiver, child))
  assert.ok(result.capability.materializer.dependencies?.includes(checked!))
  assert.equal(result.capability.materializer.nativeClassReferenceIdentity, 'preserved')
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(method, census.nodeById), true)
  const closure = recipeClosureOf([method], census.nodeById)
  const ctx = {
    conversions: census,
    printerDrift: [],
    owner: 'test',
    conversionIsCertified: (id: string) => closure.has(id)
  } as unknown as ConversionSite
  const rendered = recipeText(ctx, result, 'read_native_self_result()')
  assert.equal(rendered?.split('read_native_self_result()').length, 2, 'the native result is evaluated once')
  assert.ok(rendered?.includes('::undefined()'), 'native strict undefined remains an admitted absence state')
  assert.ok(rendered?.includes('assertedDowncastClassRef<'), 'an allocated Base result cannot be reinterpreted as a Child')
  const unknownResult: Representation = { ...original, abi: { ...original.abi, result: number } }
  assert.equal(census.nativeMethodFor(unknownResult, publicFrame), null)
  assert.equal(census.nodeFor(original, publicFrame).capability.kind, 'never', 'the contextual method cannot mutate ordinary admission')
})

test('ignored public arguments do not authenticate an unknown future receiver', () => {
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
  assert.equal(node.capability.kind, 'never')
  assert.equal(nativeCallablePrefixAdapterMatches(original, publicFrame, node), false)
  const method = census.nativeMethodFor(original, publicFrame)
  assert.ok(method)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(method, census.nodeById), true)
  assert.ok(method.capability.kind === 'static')
  assert.ok(method.capability.materializer.nativeMethod?.frameAdaptation)
  assert.ok(method.capability.materializer.nativeMethod?.publicAdaptation)
  assert.equal(nativeCallablePrefixAdapterMatches(publicFrame, original, census.nodeFor(publicFrame, original)), false)
})

test('an optional callable cites its complete admitted frame instead of concealing an adapter', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const held: Representation = { kind: 'optional', payload: target, absence: 'undefined' }
  const node = census.nodeFor(source, held)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const plan = node.capability.materializer.callablePayload
  assert.ok(plan)
  assert.equal(plan.mode, 'wrap')
  assert.equal(plan.payload, census.nodeFor(source, target))
  assert.ok(node.capability.materializer.dependencies?.includes(plan.payload))
  const closure = recipeClosureOf([node], census.nodeById)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById), true)
  const ctx = {
    conversions: census,
    printerDrift: [],
    owner: 'test',
    conversionIsCertified: (id: string) => closure.has(id)
  } as unknown as ConversionSite
  const rendered = recipeText(ctx, node, 'callback')
  assert.ok(rendered?.includes('::adaptSourceWithReceiver<-1, false, true>('))
  assert.ok(rendered?.startsWith('gea::Optional<'))
  const optionalSource: Representation = { kind: 'optional', payload: source, absence: 'undefined' }
  const mapped = census.nodeFor(optionalSource, held)
  assert.ok(mapped.capability.kind === 'atom' || mapped.capability.kind === 'static')
  assert.equal(mapped.capability.materializer.callablePayload?.mode, 'map')
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(mapped, census.nodeById), true)
  const mappedPlan = mapped.capability.materializer.callablePayload!
  const mappedClosure = recipeClosureOf([mapped], census.nodeById)
  const mappedText = callablePayloadText(
    { ...ctx, conversionIsCertified: (id) => mappedClosure.has(id) },
    mappedPlan,
    'read_optional_callback()'
  )
  assert.equal(mappedText?.split('read_optional_callback()').length, 2, 'an effectful optional getter is evaluated once')
  assert.ok(mappedText?.includes('gea_callable_payload.has_value()'))
})

test('an Optional wrapper never licenses an unchecked future native receiver downcast', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const child: Representation = {
    ...receiver,
    declaration: 'wrapped-child' as DeclarationId,
    shapeId: 'wrapped-child',
    ancestors: [receiver.declaration]
  }
  const original: Representation = { ...source, abi: { ...source.abi, receiver: child } }
  const held: Representation = { kind: 'optional', payload: target, absence: 'undefined' }
  assert.equal(census.nodeFor(original, held).capability.kind, 'never')
  assert.equal(census.nodeFor({ kind: 'optional', payload: original, absence: 'undefined' }, held).capability.kind, 'never')
  assert.equal(census.nodeFor({ kind: 'optional', payload: original, absence: 'undefined' }, target).capability.kind, 'never')
})
