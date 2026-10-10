import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { GetOperation, SetOperation } from './model.js'
import { allOperationsOf } from './model.js'
import { nativeDocumentEntryOf, nativeDocumentEntryMatches } from './native-document-entries.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { createIrBodyBuilder } from './build.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { NativeFieldViewRead } from './native-field-view-facts.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const target: Extract<Representation, { kind: 'record-with-index' }> = {
  kind: 'record-with-index',
  shapeId: 'doc-index',
  ownership: 'shared-refcount',
  fields: [{ key: 'fixed', value: { kind: 'string' }, required: true }],
  indexes: [{ key: 'string', value: dynamic }]
}
const layouts = {
  accessorsForShape: () => [],
  forShape: () => target.fields,
  plainFieldsForShape: () => target.fields,
  indexesForShape: () => target.indexes
}
const census = createConversionNodes({ nodes: new Map(), registry: createCppConversionRegistry(layouts) })
const node = census.nodeFor(dynamic, target)
const receiver = { value: 'view' as never, representation: target }
const key = { value: 'runtime-key' as never, representation: { kind: 'string' as const } }
const get: GetOperation = {
  kind: 'get',
  lineage: 'source-read' as never,
  receiver,
  key,
  result: { id: 'answer' as never, representation: { kind: 'string' } }
}
const flow = { nativeDocumentEntryValues: new Map([[receiver.value, { entry: dynamic, views: [node.id] }]]) }

test('wildcard reads cite their exact installed Document owner and future checked entry leaf', () => {
  const receipt = nativeDocumentEntryOf(get, flow, census)
  assert.ok(receipt)
  assert.equal(receipt.receiver, receiver)
  assert.equal(census.nodeById(receipt.conversion), census.dictionaryReadFor(dynamic, get.result.representation))
  assert.equal(nativeDocumentEntryMatches(receipt, { ...receipt, views: [] }), false)
  assert.equal(nativeDocumentEntryOf(get, { nativeDocumentEntryValues: new Map() }, census), null)
  assert.equal(
    nativeDocumentEntryOf(
      get,
      { nativeDocumentEntryValues: new Map([[receiver.value, { entry: dynamic, views: ['unpublished-view'] }]]) },
      census
    ),
    null
  )
  for (const representation of [{ kind: 'symbol' as const }, { kind: 'scalar' as const, domain: 'number' as const }])
    assert.equal(nativeDocumentEntryOf({ ...get, key: { ...key, representation } }, flow, census), null)
})

test('a union dynamic arm reads through its own Value, but a static symbol member and any write stay off the entry protocol', () => {
  const union: Representation = {
    kind: 'tagged-union',
    arms: [target, dynamic].map((value, ordinal) => ({
      tag: String(ordinal),
      semanticType: String(ordinal) as never,
      runtimeDiscriminator: { kind: 'carrier' as const },
      value
    }))
  }
  const viaUnion = { ...get, receiver: { ...receiver, representation: union } }
  const receipt = nativeDocumentEntryOf(viaUnion, flow, census)
  assert.ok(receipt, 'the dynamic arm answers [[Get]] itself through the same entry leaf')
  assert.equal(census.nodeById(receipt.conversion), census.dictionaryReadFor(dynamic, get.result.representation))
  assert.equal(nativeDocumentEntryOf(viaUnion, flow, census, null, 'sym(decl|kDecoratedKeys)'), null, 'a symbol member is a view field')
  assert.ok(nativeDocumentEntryOf(viaUnion, flow, census, null, 'fixed'))
  const onlyDynamic: Representation = { ...union, arms: [union.arms[1]!] } as Representation
  assert.equal(nativeDocumentEntryOf({ ...get, receiver: { ...receiver, representation: onlyDynamic } }, flow, census), null)
  const write: SetOperation = {
    kind: 'set',
    lineage: 'source-write' as never,
    receiver: { ...receiver, representation: union },
    key,
    value: { value: 'written' as never, representation: { kind: 'scalar', domain: 'number' } },
    result: null,
    strict: true
  }
  assert.equal(nativeDocumentEntryOf(write, flow, census), null)
})

test('Document entry writes accept primitives and existing dynamic entries without boxing native aggregates', () => {
  const set: SetOperation = {
    kind: 'set',
    lineage: 'source-write' as never,
    receiver,
    key,
    value: { value: 'written' as never, representation: { kind: 'scalar', domain: 'number' } },
    result: null,
    strict: true
  }
  const receipt = nativeDocumentEntryOf(set, flow, census)
  assert.ok(receipt)
  assert.equal(census.nodeById(receipt.conversion), census.nodeFor(set.value.representation, dynamic))
  for (const representation of [
    target,
    { kind: 'dynamic' as const, reason: 'untyped-callable' as const },
    { kind: 'array-object' as const, element: { kind: 'string' as const }, extension: null, ownership: 'shared-refcount' as const }
  ])
    assert.equal(nativeDocumentEntryOf({ ...set, value: { ...set.value, representation } }, flow, census), null)
  assert.ok(
    nativeDocumentEntryOf(
      { ...set, value: { ...set.value, representation: { kind: 'dynamic', reason: 'thrown-error-carrier' } } },
      flow,
      census
    )
  )
})

test('installed Document entries follow local aliases independently of unknown allocation origins', () => {
  const build = (ordinaryWriter: boolean) => {
    const builder = createIrBodyBuilder('module' as never, 'module' as never, null)
    const block = builder.openBlock()
    const lineage = 'entry-source' as never
    const unknown = builder.bindingRead(block, lineage, 'external-document' as never, dynamic)
    const view = builder.convert(block, lineage, node.id, { value: unknown, representation: dynamic }, target)
    const cell = 'local-document' as never
    builder.bindingWrite(block, lineage, cell, { value: view, representation: target })
    if (ordinaryWriter) {
      const plain = builder.allocateRecord(block, lineage, [], target)
      builder.bindingWrite(block, lineage, cell, { value: plain, representation: target })
    }
    const alias = builder.bindingRead(block, lineage, cell, target)
    builder.return(block, null, null)
    const placements = new Map([[cell, { storage: { kind: 'local' }, representation: target } as BindingPlacement]])
    return { body: builder.seal(), alias, placements }
  }
  const closed = build(false)
  const admitted = nativeCallableFlowOf([closed.body], closed.placements, new Map(), census)
  assert.deepEqual(admitted.nativeDocumentEntryValues?.get(closed.alias), { entry: dynamic, views: [node.id] })
  const mixed = build(true)
  assert.equal(nativeCallableFlowOf([mixed.body], mixed.placements, new Map(), census).nativeDocumentEntryValues?.has(mixed.alias), false)
  const uninstalled = { ...census, nodeById: (id: string) => (id === node.id ? null : census.nodeById(id)) }
  assert.equal(
    nativeCallableFlowOf([closed.body], closed.placements, new Map(), uninstalled).nativeDocumentEntryValues?.has(closed.alias),
    false
  )
})

for (const fixture of ['open-document-adopted-into-record-key-order.runtime.ts', 'document-viewed-as-typed-options.runtime.ts'])
  test(`the original Document remains the mutable enumerable owner in ${fixture}`, () => {
    const result = compile({
      rootFileNames: [resolve('test/runtime', fixture)],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true,
      includeIr: true
    })
    const details = JSON.stringify({
      diagnostics: result.diagnostics.diagnostics,
      refusals: result.refusals,
      emission: result.emissionRefusals
    })
    assert.equal(result.diagnostics.clean, true, details)
    assert.notEqual(result.source, null, details)
    const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    const entries = operations.filter(
      (operation) => (operation.kind === 'get' || operation.kind === 'set') && operation.nativeDocumentEntry !== undefined
    )
    if (fixture === 'open-document-adopted-into-record-key-order.runtime.ts')
      assert.ok(entries.length > 0, 'runtime string observations must cite the installed original wildcard entry protocol')
    else {
      const fixed = operations.filter(
        (operation) =>
          operation.kind === 'get' &&
          operation.nativeFieldViewRead?.sources.some((source) => representationKey(source.source) === representationKey(dynamic))
      )
      assert.ok(fixed.length > 0, 'typed reads must retain the installed original declared-any entry conversion')
      for (const read of fixed) {
        assert.ok(read.kind === 'get' && read.nativeFieldViewRead)
        const route: NativeFieldViewRead['sources'][number] | undefined = read.nativeFieldViewRead.sources.find(
          (source) => representationKey(source.source) === representationKey(dynamic)
        )
        assert.ok(route)
        assert.equal(
          result.conversionCensus.nodeById(route.conversion),
          result.conversionCensus.dictionaryReadFor(dynamic, read.result.representation)
        )
        assert.equal(result.certificate?.conversionNodeIds.includes(route.conversion), true)
      }
    }
    assert.match(result.source!, /makeDocumentViewWithOrigin/)
    assert.doesNotMatch(result.source!, /gea::dictionary::adopt</)
    for (const operation of entries)
      if (operation.kind === 'get' || operation.kind === 'set') {
        const receipt = operation.nativeDocumentEntry!
        for (const id of [...receipt.views, receipt.conversion]) assert.equal(result.certificate?.conversionNodeIds.includes(id), true)
      }
  })
