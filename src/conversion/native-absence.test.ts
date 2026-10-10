import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import { NATIVE_REFERENCE_ABSENCE, nativeReferenceAbsenceOf } from './native-absence.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import type { Representation } from '../representation/model.js'

const reference: Representation = {
  kind: 'class-ref',
  declaration: 'native-absence-class' as never,
  shapeId: 'native-absence-shape' as never,
  ownership: 'shared-refcount',
  ancestors: []
}

test('a native receiver absence has an exact sentinel recipe rather than an unreachable branch', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const absence of ['undefined', 'null'] as const) {
    const node = conversions.nodeFor({ kind: absence }, reference)
    assert.ok(node.capability.kind === 'static' || node.capability.kind === 'atom')
    assert.equal(node.capability.materializer.id, NATIVE_REFERENCE_ABSENCE)
    assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
    const site = { conversions, printerDrift: [], owner: 'native-absence-test' } as unknown as ConversionSite
    const text = recipeText(site, node, 'evaluated_receiver')
    assert.ok(text)
    assert.equal(text.includes('unreachableValue'), false)
    assert.equal(text.includes('::undefined()'), absence === 'undefined')
  }
})

test('native absence admission excludes value storage and host objects without the strict sentinel lane', () => {
  assert.equal(nativeReferenceAbsenceOf({ kind: 'undefined' }, { ...reference, ownership: 'owned' }), null)
  assert.equal(nativeReferenceAbsenceOf({ kind: 'undefined' }, { kind: 'scalar', domain: 'number' }), null)
  assert.equal(
    nativeReferenceAbsenceOf(
      { kind: 'undefined' },
      { kind: 'native-record-ref', shapeId: 'host' as never, native: 'gea::Host', ownership: 'shared-refcount' }
    ),
    null
  )
  assert.equal(nativeReferenceAbsenceOf({ kind: 'scalar', domain: 'number' }, reference), null)
})
