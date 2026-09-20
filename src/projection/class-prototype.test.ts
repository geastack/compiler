import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { ClassLayout } from './classes.js'
import { classPrototypeReadOf } from './class-prototype.js'

const base = 'prototype-base' as DeclarationId
const child = 'prototype-child' as DeclarationId
const ref = (declaration: DeclarationId): Representation => ({
  kind: 'class-ref',
  declaration,
  shapeId: 'prototype-shape',
  ownership: 'shared-refcount',
  ancestors: []
})
const constructor = (members: readonly DeclarationId[]): Representation => ({
  kind: 'constructor-family',
  members,
  abi: { receiver: null, parameters: [], restFrom: null, result: ref(members[0]!) }
})
const layout = (declaration: DeclarationId, overrides: Partial<Omit<ClassLayout, 'constructor'>> = {}): ClassLayout => ({
  declaration,
  base: null,
  nativeBase: null,
  construct: null,
  instance: ref(declaration),
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [{ key: 'hook', callable: 'prototype-hook' as never }],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null,
  ...overrides
})

test('native method-only prototype reads preserve exact class identity across ordinary inheritance', () => {
  const parent = layout(base)
  const derived = layout(child, { base })
  const classes = new Map([
    [base, parent],
    [child, derived]
  ])
  assert.equal(classPrototypeReadOf(classes, constructor([base]), 'prototype', ref(base)), parent)
  assert.equal(classPrototypeReadOf(classes, constructor([child]), 'prototype', ref(child)), derived)
})

test('prototype admission rejects wrong keys, carriers, ambiguous families and incompatible result identities', () => {
  const classes = new Map([[base, layout(base)]])
  for (const [receiver, key, value] of [
    [constructor([base]), 'constructor', ref(base)],
    [ref(base), 'prototype', ref(base)],
    [constructor([]), 'prototype', ref(base)],
    [constructor([base, child]), 'prototype', ref(base)],
    [constructor([base]), 'prototype', ref(child)],
    [constructor([base]), 'prototype', { kind: 'undefined' }]
  ] as const)
    assert.equal(classPrototypeReadOf(classes, receiver, key, value), null)
})

test('prototype admission rejects unsupported uses, missing ancestors, native bases and cycles', () => {
  for (const classes of [
    new Map([[base, layout(base, { prototypeUnsupportedUses: ['instance field read'] })]]),
    new Map([[base, layout(base, { base: child })]]),
    new Map([[base, layout(base, { nativeBase: { protocol: 'Error', instance: { kind: 'undefined' } } as never })]]),
    new Map([
      [base, layout(base, { base: child })],
      [child, layout(child, { base })]
    ])
  ])
    assert.equal(classPrototypeReadOf(classes, constructor([base]), 'prototype', ref(base)), null)
})
