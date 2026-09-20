import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { PhysicalClassLayout } from '../projection/classes.js'
import { representationKey } from '../representation/model.js'
import type { ReflectionDemand, ReflectionExposure } from './reflection-demand.js'
import { closePhysicalClassReflection } from './physical-class-reflection.js'

const layout = (name: string, base: string | null): PhysicalClassLayout => ({
  declaration: name as DeclarationId,
  base: base as DeclarationId | null,
  nativeBase: null,
  instance: {
    kind: 'class-ref',
    declaration: name as DeclarationId,
    shapeId: name,
    ownership: 'owned',
    ancestors: base ? [base as DeclarationId] : []
  }
})
const demand = (level: 'keys-only' | 'full', fields?: ReflectionDemand['fieldOperations']): ReflectionDemand => ({
  level,
  ...(fields ? { fieldOperations: fields } : {}),
  reasons: new Set(),
  representations: new Set()
})
const exposure = (entries: readonly [string, ReflectionDemand][]): ReflectionExposure => ({
  classes: new Map(entries as readonly [DeclarationId, ReflectionDemand][]),
  records: new Map(),
  byRepresentation: new Map(),
  complete: true
})
const root = layout('root', null)
const middle = layout('middle', 'root')
const leaf = layout('leaf', 'middle')
const sibling = layout('sibling', 'root')
const layouts = new Map([root, middle, leaf, sibling].map((value) => [value.declaration, value]))

test('a full type-only derived protocol retains ancestors without exposing siblings or payloads', () => {
  const original = exposure([
    ['root', demand('keys-only')],
    ['middle', demand('keys-only')],
    ['leaf', demand('full')],
    ['sibling', demand('keys-only')]
  ])
  const result = closePhysicalClassReflection(original, layouts)
  for (const value of [root, middle, leaf]) {
    assert.equal(result.classes.get(value.declaration)?.level, 'full')
    assert.equal(result.byRepresentation.get(representationKey(value.instance))?.level, 'full')
  }
  assert.equal(result.classes.get(sibling.declaration)?.level, 'keys-only')
  assert.equal(original.classes.get(root.declaration)?.level, 'keys-only')
  assert.equal(result.records, original.records)
})

test('an uncensused physical descendant preserves the fail-closed full protocol on its bases', () => {
  const result = closePhysicalClassReflection(
    exposure([
      ['root', demand('keys-only')],
      ['middle', demand('keys-only')],
      ['sibling', demand('keys-only')]
    ]),
    layouts
  )
  assert.equal(result.classes.get(root.declaration)?.level, 'full')
  assert.equal(result.classes.get(leaf.declaration)?.level, 'full')
  assert.ok(result.classes.get(root.declaration)?.reasons.has('uncensused-physical-layout'))
})

test('restricted named-field protocol support keeps the operation set restricted', () => {
  const none = new Map()
  const result = closePhysicalClassReflection(
    exposure([
      ['root', demand('keys-only', none)],
      ['middle', demand('keys-only', none)],
      ['leaf', demand('full', new Map([['x', new Set(['read' as const])]]))],
      ['sibling', demand('keys-only', none)]
    ]),
    layouts
  )
  assert.deepEqual(result.classes.get(root.declaration)?.fieldOperations, new Map([['x', new Set(['read'])]]))
  assert.deepEqual(closePhysicalClassReflection(result, layouts), result)
})

test('closed families keep their keys-only protocol and incomplete evidence stays incomplete', () => {
  const original = exposure([...layouts.keys()].map((key) => [key, demand('keys-only')]))
  assert.ok([...closePhysicalClassReflection(original, layouts).classes.values()].every((value) => value.level === 'keys-only'))
  const incomplete = { ...original, complete: false }
  assert.equal(closePhysicalClassReflection(incomplete, layouts), incomplete)
})
