import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createConversionNodes } from './nodes.js'
import { nativeLogicalReceiverRecipeOf } from './native-logical-receiver.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { cppTypeOf } from '../targets/cpp/types.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const text: Representation = { kind: 'string' }
const numeric: Representation = { kind: 'scalar', domain: 'number' }
const reference: Representation = {
  kind: 'record',
  shapeId: 'logical-receiver',
  fields: [],
  accessors: [],
  ownership: 'shared-refcount'
}
const callable = (receiver: Representation | null, restFrom: number | null = null): Representation => ({
  kind: 'function-value-dispatch',
  abi: { receiver, parameters: [], result: text, restFrom } satisfies CallableAbi
})

test('identical C++ function types cannot erase actual-argument packing or introduce a suffix frame', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const abi: CallableAbi = {
    receiver: null,
    parameters: [
      { value: numeric, ownership: 'owned', passing: 'by-value' },
      {
        value: { kind: 'array-object', element: numeric, extension: null, ownership: 'shared-refcount' },
        ownership: 'shared-refcount',
        passing: 'by-value'
      }
    ],
    result: numeric,
    restFrom: 1,
    argumentsFrame: 'actual'
  }
  const actual: Representation = { kind: 'function-value-dispatch', abi }
  const { argumentsFrame: omitted, ...suffixAbi } = abi
  const suffix: Representation = { kind: 'function-value-dispatch', abi: suffixAbi }
  const fixed: Representation = { kind: 'function-value-dispatch', abi: { ...suffixAbi, restFrom: null } }
  for (const target of [suffix, fixed]) {
    assert.equal(cppTypeOf(actual), cppTypeOf(target))
    assert.equal(conversions.nodeFor(actual, target).capability.kind, 'never')
  }
  assert.equal(conversions.nodeFor(actual, actual).capability.kind, 'identity')
})

test('physical dynamic callable loading seals its exact lazy native receiver factory', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const method: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: reference,
      parameters: [
        {
          value: { kind: 'array-object', element: text, extension: null, ownership: 'shared-refcount' },
          ownership: 'shared-refcount',
          passing: 'by-value'
        }
      ],
      result: numeric,
      restFrom: 0
    }
  }
  const receiver: Representation = { kind: 'optional', payload: method, absence: 'null' }
  const target = callable(receiver)
  const node = conversions.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const held = node.capability.materializer.nativeLogicalReceiver
  assert.ok(held)
  assert.equal(held.receiver, receiver)
  assert.equal(held.materializers.length, 1)
  assert.equal(held.materializers[0]!.source, method)
  assert.ok(node.capability.materializer.dependencies?.includes(held.materializers[0]!))
  const site = { conversions, printerDrift: [], owner: 'native-logical-receiver' } as unknown as ConversionSite
  const emitted = recipeText(site, node, 'actual_dynamic_function')
  assert.ok(emitted)
  assert.match(emitted, /inWithReceiver\(.*\+\[\]\(const gea::Optional</)
  assert.match(emitted, /has_value\(\).*NativeCallReceiver::primitive/)
  assert.match(emitted, /NativeCallReceiver::null\(\)/)
  assert.match(emitted, /boxMethod<1,\s*false>/)
})

test('an unsupported physical receiver cannot borrow a boxed callable load', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const owned = { ...reference, ownership: 'owned' } as Representation
  assert.equal(nativeLogicalReceiverRecipeOf(owned, conversions.nodeFor, conversions.nodeById), null)
  assert.equal(conversions.nodeFor(dynamic, callable(owned)).capability.kind, 'never')
})

test('ordinary native references and both Optional absence policies need no callable materializer', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const absence of ['null', 'undefined'] as const) {
    const recipe = nativeLogicalReceiverRecipeOf(
      { kind: 'optional', payload: reference, absence },
      conversions.nodeFor,
      conversions.nodeById
    )
    assert.ok(recipe)
    assert.deepEqual(recipe.materializers, [])
  }
})

test('a receiver factory cannot borrow a materializer for another source ABI or target carrier', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const source = callable(reference)
  const other = callable(null)
  const correct = conversions.nodeFor(source, dynamic)
  assert.notEqual(correct.capability.kind, 'never')
  assert.equal(
    nativeLogicalReceiverRecipeOf(source, () => conversions.nodeFor(other, dynamic), conversions.nodeById),
    null
  )
  assert.equal(
    nativeLogicalReceiverRecipeOf(source, () => ({ ...correct, target: text })),
    null
  )
  assert.ok(nativeLogicalReceiverRecipeOf(source, conversions.nodeFor, conversions.nodeById))
})

test('a receiverless static factory adapts to the retained native constructor evaluation', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const constructor: Representation = {
    kind: 'constructor-family',
    members: ['retained-class' as never],
    abi: { receiver: null, parameters: [], result: reference, restFrom: null }
  }
  const source = callable(null)
  const target = callable(constructor)
  const node = conversions.nodeFor(source, target)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const receiver = node.capability.materializer.callableView?.logicalReceiver
  assert.ok(receiver)
  assert.equal(receiver.materializers.length, 1)
  assert.equal(receiver.materializers[0]!.source, constructor)
  const site = { conversions, printerDrift: [], owner: 'constructor-logical-receiver' } as unknown as ConversionSite
  assert.match(recipeText(site, node, 'source_factory')!, /NativeCallReceiver::primitive.*ConstructorObject/)
})
