import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { classFieldOwnershipOf, propertyReadResultRepresentationOf } from './fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { publishClassFieldOwnership, type ClassField, type ClassLayout } from './classes.js'

const declaration = (value: string): DeclarationId => value as DeclarationId

const field = (owner: string, key: string, representation: Representation | null, syntheticSubclassMemberOverlay = false): ClassField => ({
  declaration: declaration(`${owner}:${key}`),
  key,
  initializer: null as FunctionId | null,
  representation,
  syntheticSubclassMemberOverlay
})

const scalar = (domain: 'number' | 'string'): Representation => (domain === 'number' ? { kind: 'scalar', domain } : { kind: 'string' })

const layout = (
  name: string,
  base: string | null,
  fields: readonly ClassField[],
  accessors: ClassLayout['accessors'] = []
): ClassLayout => ({
  declaration: declaration(name),
  base: base === null ? null : declaration(base),
  nativeBase: null,
  construct: null,
  instance: null,
  constructor: null,
  fields,
  fieldOwnership: [],
  methods: [],
  accessors,
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
})

test('overlay ownership keeps evidence on the base and physical fields on descendants', () => {
  const source = new Map<DeclarationId, ClassLayout>([
    [
      declaration('Root'),
      layout('Root', null, [field('Root', 'leftOnly', scalar('number'), true), field('Root', 'rightOnly', scalar('string'), true)])
    ],
    [declaration('Left'), layout('Left', 'Root', [field('Left', 'leftOnly', scalar('number'))])],
    [declaration('Right'), layout('Right', 'Root', [field('Right', 'rightOnly', scalar('string'))])],
    [declaration('Unrelated'), layout('Unrelated', null, [field('Unrelated', 'leftOnly', scalar('number'))])]
  ])
  const projected = publishClassFieldOwnership(source)
  const left = classFieldOwnershipOf(projected, 'leftOnly')
  const right = classFieldOwnershipOf(projected, 'rightOnly')
  assert.equal(left.length, 1)
  assert.equal(left[0]?.evidenceOwner, declaration('Root'))
  assert.deepEqual(
    left[0]?.physicalOwners.map((owner) => owner.declaration),
    [declaration('Left')]
  )
  assert.equal(right.length, 1)
  assert.deepEqual(
    right[0]?.physicalOwners.map((owner) => owner.declaration),
    [declaration('Right')]
  )
  assert.equal(projected.get(declaration('Root'))?.fields.filter((entry) => entry.key === 'leftOnly').length, 1)
})

test('ownership is conservative for sibling carrier differences and accessor shadowing', () => {
  const source = new Map<DeclarationId, ClassLayout>([
    [declaration('Root'), layout('Root', null, [field('Root', 'value', scalar('number'), true)])],
    [declaration('StringChild'), layout('StringChild', 'Root', [field('StringChild', 'value', scalar('string'))])],
    [declaration('AccessorChild'), layout('AccessorChild', 'Root', [], [{ key: 'value', getter: null, setter: null }])]
  ])
  const projected = publishClassFieldOwnership(source)
  const ownership = classFieldOwnershipOf(projected, 'value')
  assert.equal(ownership.length, 1)
  const entry = ownership[0]
  assert.ok(entry)
  assert.deepEqual(
    entry.physicalOwners.map((owner) => owner.declaration),
    [declaration('StringChild')]
  )
  const physical = entry.physicalOwners[0]
  assert.ok(physical)
  assert.deepEqual(physical.field.representation, { kind: 'string' })
})

test('empty descendant ownership records an actual base-only overlay without inventing storage', () => {
  const source = new Map<DeclarationId, ClassLayout>([
    [declaration('Root'), layout('Root', null, [field('Root', 'value', scalar('number'), true)])]
  ])
  const projected = publishClassFieldOwnership(source)
  const ownership = classFieldOwnershipOf(projected, 'value')
  assert.equal(ownership.length, 1)
  assert.deepEqual(ownership[0]?.physicalOwners, [])
})

test('cyclic malformed heritage terminates the ownership census', () => {
  const source = new Map<DeclarationId, ClassLayout>([
    [declaration('A'), layout('A', 'B', [field('A', 'value', scalar('number'), true)])],
    [declaration('B'), layout('B', 'A', [field('B', 'value', scalar('number'))])]
  ])
  const projected = publishClassFieldOwnership(source)
  assert.deepEqual(
    classFieldOwnershipOf(projected, 'value')[0]?.physicalOwners.map((owner) => owner.declaration),
    [declaration('B')]
  )
})

test('an inherited overlay slot does not replace a descendant method read', () => {
  const value: Representation = { kind: 'optional', payload: { kind: 'scalar', domain: 'boolean' }, absence: 'undefined' }
  const instance: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: declaration('Root'),
    shapeId: 'root-shape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const root = { ...layout('Root', null, [field('Root', 'update', value, true)]), instance }
  const child = {
    ...layout('Child', 'Root', []),
    instance: { ...instance, declaration: declaration('Child'), ancestors: [declaration('Root')] },
    methods: [{ key: 'update', callable: 'child-update' as FunctionId }]
  }
  const classes = new Map<DeclarationId, ClassLayout>([
    [root.declaration, root],
    [child.declaration, child]
  ])
  const deriver = {
    layoutOf: () => ({ kind: 'record', fields: [{ key: 'update', value, required: false }], accessors: [] })
  } as unknown as RepresentationDeriver
  assert.equal(propertyReadResultRepresentationOf(deriver, classes, new Map(), child.instance, 'update'), null)
  assert.deepEqual(propertyReadResultRepresentationOf(deriver, classes, new Map(), root.instance, 'update'), value)
})

test('a tagged native field reads its complete absence-preserving storage carrier', () => {
  const representation: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: declaration('Cell'),
    shapeId: 'cell-shape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const value: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'absent', semanticType: 'absent' as never, runtimeDiscriminator: { kind: 'carrier' }, value: { kind: 'undefined' } },
      { tag: 'null', semanticType: 'null' as never, runtimeDiscriminator: { kind: 'carrier' }, value: { kind: 'null' } },
      { tag: 'present', semanticType: 'number' as never, runtimeDiscriminator: { kind: 'carrier' }, value: scalar('number') }
    ]
  }
  const cell = { ...layout('Cell', null, [field('Cell', 'value', value)]), instance: representation }
  const classes = new Map([[cell.declaration, cell]])
  const deriver = {
    layoutOf: () => ({ kind: 'record', fields: [{ key: 'value', value, required: false }], accessors: [] })
  } as unknown as RepresentationDeriver
  assert.equal(propertyReadResultRepresentationOf(deriver, classes, new Map(), representation, 'value'), value)
  assert.equal(
    propertyReadResultRepresentationOf(
      deriver,
      classes,
      new Map(),
      { kind: 'native-record-ref', shapeId: 'cell-shape', ownership: 'shared-refcount', native: 'HostCell' },
      'value'
    ),
    null
  )
})
