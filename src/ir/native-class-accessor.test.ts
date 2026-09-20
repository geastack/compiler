import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { nativeClassAccessorEntryOf } from './native-class-accessor.js'

const texture: Extract<Representation, { kind: 'class-ref' }> = {
  kind: 'class-ref',
  declaration: 'texture' as never,
  shapeId: 'texture-shape',
  ancestors: [],
  ownership: 'shared-refcount'
}
const number: Representation = { kind: 'scalar', domain: 'number' }
const images: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const image: Representation = {
  kind: 'optional',
  absence: 'undefined',
  payload: {
    kind: 'tagged-union',
    arms: [texture, images].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' as const }
    }))
  }
}

const layout = {
  declaration: texture.declaration,
  base: null,
  nativeBase: null,
  construct: null,
  instance: texture,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [{ key: 'image', getter: null, setter: 'set-image' as FunctionId }]
} as unknown as ClassLayout
const classes = new Map<DeclarationId, ClassLayout>([[texture.declaration, layout]])
const setterAbi = (formal: Representation): CallableAbi => ({
  receiver: texture,
  parameters: [{ value: formal, passing: 'by-value', ownership: 'owned' }],
  result: { kind: 'void' },
  restFrom: null
})
const bodyOf = (formal: Representation) => (): IrBody => ({ abi: setterAbi(formal) }) as unknown as IrBody
const store = (written: Representation): IrOperation =>
  ({
    kind: 'set',
    lineage: 'lineage',
    receiver: { value: 'receiver', representation: texture },
    key: { value: 'key', representation: { kind: 'string' } },
    value: { value: 'written', representation: written },
    result: null
  }) as unknown as IrOperation

test('a setter argument enters its formal exactly or through a certified payload-preserving native transfer', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const exact = nativeClassAccessorEntryOf(store(image), 'image', classes, bodyOf(image))
  assert.equal(exact?.functionId, 'set-image')
  // Before the census has minted the argument's node there is nothing to certify.
  assert.equal(nativeClassAccessorEntryOf(store(images), 'image', classes, bodyOf(image), conversions), null)
  const injected = conversions.nodeFor(images, image)
  assert.ok(injected.capability.kind === 'atom')
  assert.equal(injected.capability.materializer.nativePayloadTransport, 'preserved')
  const entry = nativeClassAccessorEntryOf(store(images), 'image', classes, bodyOf(image), conversions)
  assert.equal(entry?.functionId, 'set-image')
  assert.deepEqual(
    entry?.arguments.map((argument) => argument.value),
    ['written']
  )
  assert.equal(nativeClassAccessorEntryOf(store(images), 'image', classes, bodyOf(image)), null, 'no census, no conversion')
})

test('a boxing or reconstructing setter argument keeps the unproven accessor path', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const boxed = conversions.nodeFor(number, dynamic)
  assert.ok(boxed.capability.kind === 'atom' && boxed.capability.materializer.allocates)
  assert.equal(nativeClassAccessorEntryOf(store(number), 'image', classes, bodyOf(dynamic), conversions), null)
  assert.equal(nativeClassAccessorEntryOf(store(images), 'other', classes, bodyOf(image), conversions), null)
})
