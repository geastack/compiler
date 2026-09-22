import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { DeclarationId, IrValueId, StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { publishEmissionRepresentationsOf } from './emission-representations.js'

const number = { kind: 'scalar', domain: 'number' } as const
const string = { kind: 'string' } as const
const lineage = 'emission-representations-test-lineage' as never

const record = (shapeId: string, fields: readonly { key: string; value: Representation }[]): Representation => ({
  kind: 'record',
  shapeId,
  fields: fields.map((field) => ({ ...field, required: true })),
  accessors: [],
  ownership: 'owned'
})

const bodyOf = (operations: readonly IrOperation[], values: ReadonlyMap<string, Representation> = new Map()): IrBody => {
  const blockId = 'emission-representations-test-block' as IrBody['entry']
  return {
    owner: 'emission-representations-test-body' as IrBody['owner'],
    sourceOwner: 'emission-representations-test-owner' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: blockId,
    blocks: new Map([
      [blockId, { id: blockId, operations: operations as never, terminator: { kind: 'return', lineage, value: null } as never }]
    ]),
    blockOrder: [blockId],
    values: values as ReadonlyMap<IrValueId, Representation>,
    tryRegions: []
  }
}

const emptyConversions = (nodes = new Map<string, ConversionNode>()): ConversionCensus => ({
  nodeFor: () => {
    throw new Error('nodeFor is not used by emission reachability')
  },
  coercionFor: () => {
    throw new Error('coercionFor is not used by emission reachability')
  },
  exactArmFor: () => null,
  nodeById: (id) => nodes.get(id) ?? null,
  minted: nodes
})

const deriverOf = (layouts: ReadonlyMap<string, Representation> = new Map()): RepresentationDeriver =>
  ({ layoutOf: (type: StructuralTypeId) => layouts.get(String(type)) ?? ({ kind: 'unresolved', reason: String(type) } as const) }) as never

const inputOf = (body: IrBody, overrides: Partial<Parameters<typeof publishEmissionRepresentationsOf>[0]> = {}) => ({
  bodies: new Map([[body.owner, body]]),
  placements: new Map<DeclarationId, BindingPlacement>(),
  classes: new Map<DeclarationId, ClassLayout>(),
  deriver: deriverOf(),
  conversions: emptyConversions(),
  complete: true,
  ...overrides
})

test('collects only final IR carriers and does not consult fallback roots while complete', () => {
  const live = record('live-record', [{ key: 'value', value: number }])
  const dead = record('dead-record', [{ key: 'dead', value: string }])
  const publication = publishEmissionRepresentationsOf(inputOf(bodyOf([], new Map([['live', live]])), { fallbackRoots: [dead] }))
  const keys = publication.representations.map((representation) =>
    representation.kind === 'record' ? representation.shapeId : representation.kind
  )
  assert.equal(publication.complete, true)
  assert.equal(keys.includes('live-record'), true)
  assert.equal(keys.includes('dead-record'), false)
})

test('expands compiler-owned native nominal layouts and retains no unrelated layout', () => {
  const reference: Representation = { kind: 'native-record-ref', shapeId: 'inner' as never, ownership: 'owned', native: null }
  const inner = record('inner-layout', [{ key: 'value', value: number }])
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['reference', reference]])), {
      deriver: deriverOf(new Map([['inner', inner]]))
    })
  )
  const keys = publication.representations.map((representation) =>
    representation.kind === 'record' ? representation.shapeId : representation.kind
  )
  // A nominal layout is structural evidence used to discover child carriers;
  // it is not an additional emitted record beside the nominal reference.
  assert.equal(keys.includes('inner-layout'), false)
  assert.equal(keys.includes('scalar'), true)
  assert.equal(
    [...publication.reasons.values()].some((reasons) => reasons.some((reason) => reason.kind === 'native-layout')),
    true
  )
})

test('physical ancestor resolution retains the base and its nested storage dependencies', () => {
  const base: Extract<Representation, { readonly kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: 'physical-base' as DeclarationId,
    shapeId: 'base-layout',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const derived: Representation = {
    ...base,
    declaration: 'physical-derived' as DeclarationId,
    shapeId: 'derived-layout',
    ancestors: [base.declaration]
  }
  const payload = record('base-payload', [{ key: 'value', value: number }])
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['derived', derived]])), {
      resolveClassRef: (declaration) => (declaration === base.declaration ? base : null),
      deriver: deriverOf(
        new Map([
          ['base-layout', record('base-layout', [{ key: 'payload', value: payload }])],
          ['derived-layout', record('derived-layout', [])]
        ])
      )
    })
  )
  assert.ok(publication.representations.includes(base))
  assert.ok(publication.representations.includes(payload))
  assert.equal(
    publication.representations.some((value) => value.kind === 'record' && value.shapeId === 'base-layout'),
    false
  )
})

test('retains a placement only when final IR or capture facts name it, respecting omitted globals', () => {
  const declaration = 'emission-placement' as DeclarationId
  const placement: BindingPlacement = {
    storage: { kind: 'local', owner: 'emission-placement-owner' as never },
    representation: record('placed', [{ key: 'x', value: number }])
  }
  const read = {
    kind: 'binding-read',
    lineage,
    declaration,
    result: { id: 'binding-result', representation: number }
  } as never
  const retained = publishEmissionRepresentationsOf(inputOf(bodyOf([read]), { placements: new Map([[declaration, placement]]) }))
  assert.equal(retained.retainedPlacements.has(declaration), true)

  const omitted = publishEmissionRepresentationsOf(
    inputOf(bodyOf([read]), { placements: new Map([[declaration, placement]]), omitGlobals: new Set([declaration]) })
  )
  assert.equal(omitted.retainedPlacements.has(declaration), false)
  assert.equal(
    [...omitted.representations].some((representation) => representation.kind === 'record' && representation.shapeId === 'placed'),
    false
  )
})

test('missing retained conversion fails closed and restores fallback roots', () => {
  const fallback = record('fallback', [{ key: 'x', value: number }])
  const source = record('conversion-source', [{ key: 'x', value: number }])
  const convert = {
    kind: 'convert',
    lineage,
    conversionUse: 'missing-conversion',
    source: { value: 'source', representation: source },
    result: { id: 'converted', representation: number }
  } as never
  const publication = publishEmissionRepresentationsOf(inputOf(bodyOf([convert]), { fallbackRoots: [fallback] }))
  assert.equal(publication.complete, false)
  assert.deepEqual(publication.missingConversions, ['missing-conversion'])
  assert.equal(
    [...publication.representations].some((representation) => representation.kind === 'record' && representation.shapeId === 'fallback'),
    true
  )
})

test('class roots expand only retained class layouts and their base layouts', () => {
  const classDeclaration = 'emission-class' as DeclarationId
  const baseDeclaration = 'emission-base' as DeclarationId
  const classReference: Representation = {
    kind: 'class-ref',
    declaration: classDeclaration,
    shapeId: 'class-shape',
    ownership: 'owned',
    ancestors: [baseDeclaration]
  }
  const classLayout: ClassLayout = {
    declaration: classDeclaration,
    base: baseDeclaration,
    nativeBase: null,
    construct: null,
    instance: classReference,
    constructor: null,
    fields: [
      {
        declaration: 'class-field' as never,
        key: 'value',
        initializer: null,
        representation: record('class-field-value', [{ key: 'x', value: number }]),
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  }
  const baseLayout: ClassLayout = { ...classLayout, declaration: baseDeclaration, base: null, instance: null, fields: [] }
  const unrelated: ClassLayout = { ...baseLayout, declaration: 'unrelated-class' as DeclarationId }
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['class', classReference]])), {
      classes: new Map([
        [classDeclaration, classLayout],
        [baseDeclaration, baseLayout],
        [unrelated.declaration, unrelated]
      ])
    })
  )
  assert.equal(publication.retainedClasses.has(classDeclaration), true)
  assert.equal(publication.retainedClasses.has(baseDeclaration), true)
  assert.equal(publication.retainedClasses.has(unrelated.declaration), true)
  assert.equal(
    [...publication.representations].some(
      (representation) => representation.kind === 'record' && representation.shapeId === 'class-field-value'
    ),
    true
  )
})

test('recovers a recursive definition for a live reference-only carrier', () => {
  const recursiveType = 'recursive-type' as never
  const reference: Representation = {
    kind: 'native-record-ref',
    shapeId: recursiveType,
    ownership: 'owned',
    native: 'recursive-container:recursive-type',
    recursive: { type: recursiveType, container: 'dictionary', role: 'reference' }
  }
  const definition: Representation = {
    kind: 'dictionary',
    key: 'string',
    value: reference,
    ownership: 'owned',
    recursive: { type: recursiveType, container: 'dictionary', role: 'definition' }
  }
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['reference', reference]])), {
      deriver: deriverOf(new Map([[String(recursiveType), definition]])),
      fallbackRoots: [definition]
    })
  )
  assert.equal(publication.complete, true)
  assert.equal(
    publication.representations.some((representation) => representation === definition),
    true
  )
  assert.equal(
    publication.representations.some((representation) => representation === reference),
    true
  )
  assert.equal(publication.missingDefinitions.length, 0)
})

test('fails closed when a live recursive reference has no recoverable definition', () => {
  const recursiveType = 'unresolved-recursive-type' as never
  const reference: Representation = {
    kind: 'native-record-ref',
    shapeId: recursiveType,
    ownership: 'owned',
    native: 'recursive-container:unresolved-recursive-type',
    recursive: { type: recursiveType, container: 'array-object', role: 'reference' }
  }
  const definition: Representation = {
    kind: 'array-object',
    element: reference,
    extension: null,
    ownership: 'owned',
    recursive: { type: recursiveType, container: 'array-object', role: 'definition' }
  }
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['reference', reference]])), { fallbackRoots: [definition] })
  )
  assert.equal(publication.complete, false)
  assert.deepEqual(publication.missingDefinitions, [String(recursiveType)])
  assert.equal(
    [...publication.reasons.values()].some((reasons) => reasons.some((reason) => reason.kind === 'fallback-plan-root')),
    true
  )
})

test('expands class references found inside a compiler-owned nominal layout', () => {
  const nestedDeclaration = 'nested-emission-class' as DeclarationId
  const nestedReference: Representation = {
    kind: 'class-ref',
    declaration: nestedDeclaration,
    shapeId: 'nested-class-shape',
    ownership: 'owned',
    ancestors: []
  }
  const nestedLayout: ClassLayout = {
    declaration: nestedDeclaration,
    base: null,
    nativeBase: null,
    construct: null,
    instance: nestedReference,
    constructor: null,
    fields: [
      {
        declaration: 'nested-field' as never,
        key: 'payload',
        initializer: null,
        representation: record('nested-payload', [{ key: 'value', value: number }]),
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  }
  const outer = {
    kind: 'native-record-ref',
    shapeId: 'outer-layout' as never,
    ownership: 'owned',
    native: null
  } as const
  const outerLayout = record('outer-layout-body', [{ key: 'nested', value: nestedReference }])
  const publication = publishEmissionRepresentationsOf(
    inputOf(bodyOf([], new Map([['outer', outer]])), {
      classes: new Map([[nestedDeclaration, nestedLayout]]),
      deriver: deriverOf(new Map([['outer-layout', outerLayout]]))
    })
  )
  assert.equal(publication.retainedClasses.has(nestedDeclaration), true)
  assert.equal(
    [...publication.representations].some(
      (representation) => representation.kind === 'record' && representation.shapeId === 'nested-payload'
    ),
    true
  )
})
