import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type GetOperation } from './model.js'
import { nativeDocumentArrayEntryOf } from './native-document-array-entries.js'
import { nativeDocumentEntryMatches, nativeDocumentEntryOf } from './native-document-entries.js'

const entry: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const target: Extract<Representation, { kind: 'record-with-index' }> = {
  kind: 'record-with-index',
  shapeId: 'indexed-array-row',
  ownership: 'shared-refcount',
  fields: [{ key: 'name', value: { kind: 'string' }, required: true }],
  indexes: [{ key: 'string', value: entry }]
}
const array: Representation = { kind: 'array-object', element: target, ownership: 'shared-refcount', extension: null }
const layouts = {
  accessorsForShape: () => [],
  forShape: () => target.fields,
  plainFieldsForShape: () => target.fields,
  indexesForShape: () => target.indexes
}
const census = createConversionNodes({ nodes: new Map(), registry: createCppConversionRegistry(layouts) })
const node = census.nodeFor(entry, array)

test('an indexed array entry retains both its canonical Document reader and ordinary physical index', () => {
  const protocol = nativeDocumentArrayEntryOf(target, [node], census.nodeById, null)
  assert.ok(protocol)
  assert.equal(protocol.ordinaryIndex, entry)
  const receiver = { value: 'array-entry' as never, representation: target }
  const operation: GetOperation = {
    kind: 'get',
    lineage: 'source-entry' as never,
    receiver,
    key: { value: 'entry-key' as never, representation: { kind: 'string' } },
    result: { id: 'entry-value' as never, representation: entry }
  }
  const flow = { nativeDocumentArrayEntryValues: new Map([[receiver.value, protocol]]) }
  const receipt = nativeDocumentEntryOf(operation, flow, census)
  assert.ok(receipt?.arrayEntry)
  assert.equal(census.nodeById(receipt.conversion), census.dictionaryReadFor(entry, entry))
  assert.equal(nativeDocumentEntryMatches(receipt, { ...receipt, arrayEntry: { ...protocol, readers: [] } }), false)
  assert.equal(nativeDocumentEntryOf({ ...operation, receiver: { ...receiver, value: 'another-owner' as never } }, flow, census), null)
  assert.equal(
    nativeDocumentEntryOf(
      operation,
      {
        nativeDocumentArrayEntryValues: new Map([[receiver.value, { ...protocol, ordinaryIndex: { kind: 'scalar', domain: 'number' } }]])
      },
      census
    ),
    null
  )
  assert.equal(
    nativeDocumentEntryOf(
      operation,
      {
        nativeDocumentArrayEntryValues: new Map([
          [receiver.value, { ...protocol, readers: [{ ...protocol.readers[0]!, element: 'uncited-reader' }] }]
        ])
      },
      census
    ),
    null
  )
  assert.equal(
    nativeDocumentEntryOf(
      operation,
      {
        nativeDocumentArrayEntryValues: new Map([
          [receiver.value, { ...protocol, readers: [{ ...protocol.readers[0]!, array: 'uncited-array' }] }]
        ])
      },
      census
    ),
    null
  )
  assert.equal(
    nativeDocumentEntryOf({ ...operation, result: { ...operation.result, representation: { kind: 'string' } } }, flow, census),
    null
  )
})

test('a typed index, missing canonical reader or unrelated outer holder cannot borrow the array entry protocol', () => {
  assert.equal(
    nativeDocumentArrayEntryOf({ ...target, indexes: [{ key: 'string', value: { kind: 'string' } }] }, [node], census.nodeById, null),
    null
  )
  assert.equal(
    nativeDocumentArrayEntryOf(target, [node], () => null, null),
    null
  )
  assert.equal(nativeDocumentArrayEntryOf(target, [], census.nodeById, null), null)
  const holder: Representation = {
    kind: 'record',
    shapeId: 'array-holder',
    ownership: 'shared-refcount',
    fields: [{ key: 'values', value: array, required: true }],
    accessors: []
  }
  assert.equal(nativeDocumentArrayEntryOf(target, [census.nodeFor(entry, holder)], census.nodeById, null), null)
})

test('the original JSON Info index reads cite the selected live reader without changing its declared-any result', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/json-parse-any-array-into-declared-record-element.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const reads = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter((op) => op.kind === 'get' && op.nativeDocumentEntry?.arrayEntry !== undefined)
  assert.ok(reads.length > 0)
  for (const read of reads) {
    assert.ok(read.kind === 'get' && read.nativeDocumentEntry?.arrayEntry)
    assert.equal(representationKey(read.result.representation), representationKey(read.nativeDocumentEntry.entry))
    for (const origin of read.nativeDocumentEntry.arrayEntry.readers) {
      assert.equal(result.certificate?.conversionNodeIds.includes(origin.array), true)
      assert.equal(result.certificate?.conversionNodeIds.includes(origin.element), true)
    }
  }
  assert.ok(result.source !== null && result.source.includes('gea::dictionary::readDocumentArrayEntry('))
})
