import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { nativeFieldViewIdentityTransportOf } from '../conversion/native-field-view.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { allOperationsOf } from './model.js'
import { createIrBodyBuilder } from './build.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import type { NativeFieldStorageDomain } from './native-field-view-domains.js'
import type { NativeFieldViewRead } from './native-field-view-facts.js'

const entry: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const source: Representation = { kind: 'dictionary', key: 'string', value: entry, ownership: 'shared-refcount' }
const field: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
const target: Representation = {
  kind: 'record',
  shapeId: 'installed-entry-reader',
  ownership: 'shared-refcount',
  fields: [{ key: 'authSource', value: field, required: true }],
  accessors: []
}

test('exact installed field readers survive alias edges independently of the retained allocation layout', () => {
  const census = createConversionNodes({ nodes: new Map(), registry: createCppConversionRegistry() })
  const node = census.nodeFor(source, target)
  assert.equal(nativeFieldViewIdentityTransportOf(node), true)
  const builder = createIrBodyBuilder('module' as never, 'module' as never, null)
  const block = builder.openBlock()
  const lineage = 'installed-entry-reader' as never
  const original = builder.bindingRead(block, lineage, 'external-document' as never, source)
  const view = builder.convert(block, lineage, node.id, { value: original, representation: source }, target)
  const binding = 'held-view' as never
  builder.bindingWrite(block, lineage, binding, { value: view, representation: target })
  const alias = builder.bindingRead(block, lineage, binding, target)
  builder.return(block, null, null)
  const body = builder.seal()
  const placements = new Map([[binding, { storage: { kind: 'local' }, representation: target } as BindingPlacement]])
  const flow = nativeCallableFlowOf([body], placements, new Map(), census)
  assert.deepEqual(flow.nativeFieldViewOrigins?.get(view), [node.id])
  assert.deepEqual(flow.nativeFieldViewOrigins?.get(alias), [node.id])

  for (const missing of [null, { ...node, source: { kind: 'string' as const } }]) {
    const unselected = { ...census, nodeById: (id: string) => (id === node.id ? missing : census.nodeById(id)) }
    const rejected = nativeCallableFlowOf([body], placements, new Map(), unselected)
    assert.equal(rejected.nativeFieldViewOrigins?.has(view), false)
    assert.equal(rejected.nativeFieldViewOrigins?.has(alias), false)
  }
})

test('a retained native option allocation cannot erase its later installed Document entry reader', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/document-viewed-as-typed-options.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const bodies = result.irBodies ?? []
  const flow = nativeCallableFlowOf(
    bodies,
    result.projection.placements,
    result.projection.classes,
    result.conversionCensus,
    undefined,
    result.representations.deriver
  )
  const reads = bodies
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter(
      (operation) =>
        operation.kind === 'get' &&
        operation.nativeFieldViewRead?.key === 'authSource' &&
        representationKey(operation.result.representation) === representationKey(field)
    )
  assert.ok(reads.length > 0)
  for (const read of reads) {
    assert.ok(read.kind === 'get' && read.nativeFieldViewRead)
    // The read's routes are its guarded allocation selection when every
    // origin is an ordinary allocation; the returned options are the
    // `filterOptions` Document itself, so they are the installed view's own.
    const domains =
      flow.nativeFieldOperationStorageValues?.get(read)?.get('authSource') ??
      flow.nativeFieldViewStorageValues.get(read.receiver.value)?.get('authSource')
    assert.ok(domains?.some((domain) => representationKey(domain.read) === representationKey(field)))
    const dynamicRoute: NativeFieldStorageDomain | undefined = domains?.find(
      (domain) => representationKey(domain.read) === representationKey(entry)
    )
    assert.ok(dynamicRoute?.checkedRead)
    const selected: NativeFieldViewRead['sources'][number] | undefined = read.nativeFieldViewRead.sources.find(
      (route) => representationKey(route.source) === representationKey(entry)
    )
    assert.equal(selected?.conversion, dynamicRoute.checkedRead.id)
    assert.equal(result.certificate?.conversionNodeIds.includes(dynamicRoute.checkedRead.id), true)
    const installed = flow.nativeFieldViewOrigins?.get(read.receiver.value)
    assert.ok(installed?.length)
    for (const id of installed) assert.equal(nativeFieldViewIdentityTransportOf(result.conversionCensus.nodeById(id)), true)
  }
})
