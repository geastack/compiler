import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { IrBody, IrOperation } from './model.js'
import { reflectionExposureOf } from './reflection-demand.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { ConversionNode } from '../conversion/algebra.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'

// Same house pattern as reflection-demand.test.ts: a one-block body holding a
// flat operation list, no control flow needed for any of these proofs.
const lineage = 'named-slot-test-lineage' as never
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })
const bodyOf = (operations: readonly IrOperation[]): IrBody => {
  const id = 'named-slot-test-body' as IrBody['entry']
  return {
    owner: 'named-slot-test-owner' as IrBody['owner'],
    sourceOwner: 'named-slot-test-owner' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: id,
    blocks: new Map([[id, { id, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } as never }]]),
    blockOrder: [id],
    values: new Map(),
    tryRegions: []
  }
}
const constantKey = (id: string, text: string): IrOperation => ({
  kind: 'constant',
  lineage,
  literal: 'string',
  text,
  result: { id: id as never, representation: { kind: 'string' } }
})

const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

// ---------------------------------------------------------------------------
// declaredFieldOf: array-object.extension, once the deriver's own null answer
// no longer short-circuits the non-deriver fallback below it.
// ---------------------------------------------------------------------------

// A deriver that answers for nothing -- proving the extension lookup is what
// carries these cases, not a deriver-side coincidence.
const emptyDeriver = { layoutOf: () => ({ kind: 'unresolved', reason: 'not asked' }) as Representation } as never

const nodeArray: Representation = {
  kind: 'array-object',
  element: number,
  ownership: 'shared-refcount',
  extension: [{ key: 'pos', value: number, required: true }]
}

test('a SET into an array-object extension field is exact when the deriver is present and the carrier matches', () => {
  // Before the fix, `declaredFieldOf` returned early on `declaredRecordFieldOf`
  // (which has no `array-object` case) whenever a deriver was supplied -- which
  // is every real compilation -- so a write to `NodeArray<T>`'s own added
  // field could never take the `field !== null` branch at all. `set` has no
  // other escape (`knownNativeMemberReadOf`/`knownClassMemberReadOf` are
  // `get`-only), so this is the case the old code could never rescue.
  const write = bodyOf([
    constantKey('pos-key', 'pos'),
    {
      kind: 'set',
      lineage,
      strict: true,
      receiver: operand('list', nodeArray),
      key: operand('pos-key', { kind: 'string' }),
      value: operand('n', number),
      result: null
    } as IrOperation
  ])
  const exposure = reflectionExposureOf([write], new Map(), emptyDeriver, { representations: [nodeArray], shakeComplete: true })
  assert.equal(exposure.byRepresentation.get(representationKey(nodeArray))?.level, 'keys-only')
})

test('a SET into an array-object extension field whose carrier disagrees stays unproven', () => {
  const mismatched = operand('s', { kind: 'string' })
  const write = bodyOf([
    constantKey('pos-key', 'pos'),
    {
      kind: 'set',
      lineage,
      strict: true,
      receiver: operand('list', nodeArray),
      key: operand('pos-key', { kind: 'string' }),
      value: mismatched,
      result: null
    } as IrOperation
  ])
  const exposure = reflectionExposureOf([write], new Map(), emptyDeriver, { representations: [nodeArray], shakeComplete: true })
  assert.equal(exposure.byRepresentation.get(representationKey(nodeArray))?.level, 'full')
})

test('a SET to a key the array-object extension does not declare stays unproven', () => {
  const write = bodyOf([
    constantKey('other-key', 'other'),
    {
      kind: 'set',
      lineage,
      strict: true,
      receiver: operand('list', nodeArray),
      key: operand('other-key', { kind: 'string' }),
      value: operand('n', number),
      result: null
    } as IrOperation
  ])
  const exposure = reflectionExposureOf([write], new Map(), emptyDeriver, { representations: [nodeArray], shakeComplete: true })
  assert.equal(exposure.byRepresentation.get(representationKey(nodeArray))?.level, 'full')
})

// ---------------------------------------------------------------------------
// objectPrototypeMemberReadOf: a GET off a class-ref/record/native-record-ref
// surface for a key no field/method/accessor declares, but that
// Object.prototype guarantees every ordinary object answers.
// ---------------------------------------------------------------------------

const declaration = 'decl|f1|toString-class' as DeclarationId
const instance: Representation = {
  kind: 'class-ref',
  declaration,
  shapeId: 'shape|toString-class',
  ownership: 'shared-refcount',
  ancestors: []
}
const emptyLayout: ClassLayout = {
  declaration,
  base: null,
  nativeBase: null,
  construct: null,
  instance,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
} as never
const classes: ReadonlyMap<DeclarationId, ClassLayout> = new Map([[declaration, emptyLayout]])
// `hasClosedFixedLayout`'s class-ref case needs an actual shape behind the
// deriver to certify the struct closed at all (with no deriver it refuses
// unconditionally) -- an empty record is the closed, no-fields shape this
// class's own layout above declares.
const classShape: Representation = {
  kind: 'record',
  shapeId: 'shape|toString-class',
  fields: [],
  accessors: [],
  ownership: 'shared-refcount'
}
const classDeriver = {
  layoutOf: (shapeId: string) =>
    shapeId === 'shape|toString-class' ? classShape : ({ kind: 'unresolved', reason: 'not asked' } as Representation)
} as never

// The predicate does not inspect what concrete carrier a prototype member
// reads back as -- only that some earlier stage already committed to one
// (not `dynamic`/`unresolved`). A bare scalar stands in for whatever the
// frontend actually produced for `.toString`/`.constructor`.
const concreteStandIn = number

test('a GET of an inherited Object.prototype member off a class-ref with no such own field, method or accessor is exact', () => {
  const read = bodyOf([
    constantKey('key', 'toString'),
    {
      kind: 'get',
      lineage,
      receiver: operand('obj', instance),
      key: operand('key', { kind: 'string' }),
      result: { id: 'r' as never, representation: concreteStandIn }
    }
  ])
  const exposure = reflectionExposureOf([read], classes, classDeriver, { representations: [instance], shakeComplete: true })
  assert.equal(exposure.classes.get(declaration)?.level, 'keys-only')
})

test('a GET of an Object.prototype member whose result is still dynamic stays unproven', () => {
  const read = bodyOf([
    constantKey('key', 'toString'),
    {
      kind: 'get',
      lineage,
      receiver: operand('obj', instance),
      key: operand('key', { kind: 'string' }),
      result: { id: 'r' as never, representation: dynamic }
    }
  ])
  const exposure = reflectionExposureOf([read], classes, classDeriver, { representations: [instance], shakeComplete: true })
  assert.equal(exposure.classes.get(declaration)?.level, 'full')
})

test('a GET of a key outside Object.prototype with no declared field stays unproven', () => {
  const read = bodyOf([
    constantKey('key', 'notARealMember'),
    {
      kind: 'get',
      lineage,
      receiver: operand('obj', instance),
      key: operand('key', { kind: 'string' }),
      result: { id: 'r' as never, representation: concreteStandIn }
    }
  ])
  const exposure = reflectionExposureOf([read], classes, classDeriver, { representations: [instance], shakeComplete: true })
  assert.equal(exposure.classes.get(declaration)?.level, 'full')
})

test('a SET (not a GET) to an Object.prototype member name is never rescued by this proof', () => {
  const write = bodyOf([
    constantKey('key', 'toString'),
    {
      kind: 'set',
      lineage,
      strict: true,
      receiver: operand('obj', instance),
      key: operand('key', { kind: 'string' }),
      value: operand('v', concreteStandIn),
      result: null
    } as IrOperation
  ])
  const exposure = reflectionExposureOf([write], classes, classDeriver, { representations: [instance], shakeComplete: true })
  assert.equal(exposure.classes.get(declaration)?.level, 'full')
})

// ---------------------------------------------------------------------------
// nativePayloadTransportMatches: `class-family` joins `atom`/`static` under
// the identical materializer proof, matching `conversion/build.ts`'s
// `narrowingCapabilityFor`, which wraps the SAME `installed.materializer` an
// ordinary narrowing `atom` would get.
// ---------------------------------------------------------------------------

const base: Representation = {
  kind: 'class-ref',
  declaration: 'decl|f1|base' as DeclarationId,
  shapeId: 'shape|base',
  ownership: 'shared-refcount',
  ancestors: []
}
const family: Representation = {
  kind: 'tagged-union',
  arms: [
    {
      tag: '0',
      value: { ...base, declaration: 'decl|f1|a' as DeclarationId },
      semanticType: 'a' as never,
      runtimeDiscriminator: { kind: 'carrier' }
    },
    {
      tag: '1',
      value: { ...base, declaration: 'decl|f1|b' as DeclarationId },
      semanticType: 'b' as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }
  ]
}
const classFamilyNode = (materializer: Record<string, unknown>): ConversionNode =>
  ({
    id: 'n' as never,
    source: base,
    target: family,
    capability: { kind: 'class-family', materializer }
  }) as never

test('a class-family narrowing whose materializer proves non-allocating, field-protocol-free, payload-preserving transport matches', () => {
  const node = classFamilyNode({
    id: 'gea::host::downcastClassRef',
    domain: 'class-descendant-union:x',
    allocates: false,
    nativeFieldProtocol: 'unused',
    nativePayloadTransport: 'preserved'
  })
  assert.equal(nativePayloadTransportMatches(base, family, node), true)
})

test('a class-family conversion that allocates does not match', () => {
  const node = classFamilyNode({
    id: 'gea::host::downcastClassRef',
    domain: 'class-descendant-union:x',
    allocates: true,
    nativeFieldProtocol: 'unused',
    nativePayloadTransport: 'preserved'
  })
  assert.equal(nativePayloadTransportMatches(base, family, node), false)
})

test('a class-family conversion with no stated payload-transport proof does not match', () => {
  const node = classFamilyNode({
    id: 'gea::host::downcastClassRef',
    domain: 'class-descendant-union:x',
    allocates: false,
    nativeFieldProtocol: 'unused'
  })
  assert.equal(nativePayloadTransportMatches(base, family, node), false)
})

test('a class-family conversion with no stated field-protocol proof does not match', () => {
  const node = classFamilyNode({
    id: 'gea::host::downcastClassRef',
    domain: 'class-descendant-union:x',
    allocates: false,
    nativePayloadTransport: 'preserved'
  })
  assert.equal(nativePayloadTransportMatches(base, family, node), false)
})
