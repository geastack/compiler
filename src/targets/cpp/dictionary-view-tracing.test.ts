import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, SemanticResultId } from '../../identity/ids.js'
import { createRepresentationDeriver } from '../../representation/derive.js'
import type { Representation } from '../../representation/model.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import { createStructuralTypeTable } from '../../semantics/model/structural-type-table.js'
import { cppRecordDeclarations, traceLeafStructsOf } from './records.js'
import { cppClassName } from './types.js'

const string: Representation = { kind: 'string' }
const dictionary: Extract<Representation, { kind: 'dictionary' }> = {
  kind: 'dictionary',
  key: 'string',
  value: string,
  ownership: 'shared-refcount'
}

test('an older-only class cannot conceal a primitive dictionary view that retains a cyclic source', () => {
  const declaration = 'dictionary-view-owner' as DeclarationId
  const owner: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'dictionary-view-owner',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const name = cppClassName(declaration)
  const layout = (names: Representation) => ({
    fields: [
      { key: 'parent', value: owner, required: true },
      { key: 'names', value: names, required: true }
    ],
    indexes: [],
    accessors: []
  })
  const proof = (names: Representation) =>
    traceLeafStructsOf(new Map([[name, layout(names)]]), new Set(), new Map(), new Map([[name, []]]), (_owner, key) => key === 'parent')
  assert.equal(
    proof({ ...dictionary, ownership: 'owned' }).olderOnly.has(name),
    true,
    'a plain primitive owned table retains no alias source'
  )
  assert.equal(proof(dictionary).olderOnly.has(name), false, 'a retained view edge can close a cycle despite the older parent')
  assert.equal(proof(dictionary).leaves.has(name), false)
})

test('a generated record with a shared primitive-entry table preserves its physical source tracer', () => {
  const table = createStructuralTypeTable()
  const string = table.intern({ kind: 'primitive', primitive: 'string' })
  const names = table.intern({
    kind: 'object',
    members: [],
    membersDropped: false,
    index: [{ key: 'string', value: string, readonly: false }]
  })
  const holder = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'names' }, type: names, optional: false, readonly: false, accessor: null }],
    index: [],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  const carrier = deriver.derive(holder)
  const plan: SealedRepresentationPlan = {
    selected: new Map([['dictionary-holder' as SemanticResultId, carrier]]),
    evidence: new Map(),
    conflicts: []
  }
  const reactive = {
    fields: new Map(),
    cell: null,
    cellPreamble: [],
    dependencies: new Map(),
    nodeDependencies: new Map(),
    projections: new Map(),
    revisions: new Map(),
    celled: new Map(),
    boundRecordFields: new Map(),
    revisionBoundRecordFields: new Map()
  }
  const emitted = cppRecordDeclarations(
    plan,
    deriver,
    new Map(),
    reactive,
    new Map(),
    undefined,
    undefined,
    new Map(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => null
  )
  assert.deepEqual(emitted.refused, [])
  const source = emitted.declarations.join('\n')
  assert.ok(source.includes('gea::detail::traceRefs(value.names, visitor);'))
  assert.ok(source.includes('gea::Ref<gea::Dictionary<std::string>> names'))
  assert.ok(source.includes('TraceEdges<decltype(names)>::supported'))
  assert.ok(!source.includes('gea_traceLeaf = true'))
})
