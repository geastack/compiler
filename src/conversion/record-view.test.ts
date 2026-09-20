import assert from 'node:assert/strict'
import test from 'node:test'
import { representationKey, type Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { structuralRecordViewText } from '../targets/cpp/emit-record-view.js'
import { cppTypeOf } from '../targets/cpp/types.js'
import { structuralRecordViewPlan, type PairConvertible } from './record-view.js'

/**
 * `Object.getOwnPropertyDescriptor(strings, 'raw')!` (the shape behind
 * `template-strings-array-identity.ts`/`-structural.ts`): the call's carrier
 * is `optional(record#<per-overload PropertyDescriptor>, undefined)`, the
 * `!`-asserted binding's slot is the canonical, non-optional
 * `native-record-ref(<binding's own shape>)`, and the two shapes are
 * DIFFERENT interned records with the same fields -- so neither the
 * optional-to-optional peel nor the present-optional unwrap in
 * `targets/cpp/conversions.ts`'s `narrowing` (keyed on the payload's shape
 * already equalling the target's) has anywhere to install.
 */

const numberField = (): Representation => ({ kind: 'scalar', domain: 'number' })

const sourcePayloadRecord: Representation = {
  kind: 'record',
  shapeId: 'per-overload-property-descriptor',
  fields: [{ key: 'value', value: numberField(), required: true }],
  accessors: [],
  ownership: 'shared-refcount'
}

const source: Representation = { kind: 'optional', payload: sourcePayloadRecord, absence: 'undefined' }

const target: Representation = {
  kind: 'native-record-ref',
  shapeId: 'canonical-property-descriptor',
  ownership: 'shared-refcount',
  native: null
}

const layoutsFor = (fields: readonly { key: string; value: Representation; required: boolean }[]): RecordLayoutPolicy => ({
  forShape: (shapeId) => (shapeId === target.shapeId ? fields : null)
})

const structurallyCompatibleLayouts = layoutsFor([{ key: 'value', value: numberField(), required: true }])

/** The registry's own pair answer, stood in for by shape identity: exactly what the plan itself does not decide. */
const identityConvertible: PairConvertible = (a, b) => representationKey(a) === representationKey(b)

test('an asserted optional payload views onto a differently-shaped non-optional record target', () => {
  const plan = structuralRecordViewPlan(structurallyCompatibleLayouts, source, target, identityConvertible)
  assert.ok(plan !== null)
  assert.equal(plan?.kind, 'assert')
  if (plan?.kind !== 'assert') return
  assert.equal(plan.target, target)
  assert.equal(plan.payload.kind, 'fields')
})

test('an asserted optional payload with no structural home in the target still refuses', () => {
  const incompatibleLayouts = layoutsFor([{ key: 'value', value: { kind: 'string' }, required: true }])
  const plan = structuralRecordViewPlan(incompatibleLayouts, source, target, identityConvertible)
  assert.equal(plan, null)
})

test('an optional source viewed onto an optional target still takes the existing peeling plan, not the new one', () => {
  const optionalTarget: Representation = { kind: 'optional', payload: target, absence: 'undefined' }
  const plan = structuralRecordViewPlan(structurallyCompatibleLayouts, source, optionalTarget, identityConvertible)
  assert.equal(plan?.kind, 'optional')
})

test('the asserting unwrap renders a checked throw on absence, never a bare dereference', () => {
  const ctx = {
    layouts: structurallyCompatibleLayouts,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) }
  } as unknown as ConversionSite
  const text = structuralRecordViewText(ctx, source, target, 'gea_v0')
  assert.ok(text !== null)
  const rendered = text ?? ''
  // The presence test and the throwing fallback both name the SAME target
  // type -- `x!` is erased at runtime, so a genuinely-absent value must throw
  // exactly what a later member read of `undefined` would in JS, not fall
  // through to an unchecked `*gea_v0` (undefined behaviour on absence).
  assert.ok(rendered.includes('gea_v0.has_value()'))
  assert.ok(rendered.includes(`gea::host::throwGetPropertyOfNullish<${cppTypeOf(target)}>()`))
  assert.ok(rendered.includes('(*gea_v0)'))
})
