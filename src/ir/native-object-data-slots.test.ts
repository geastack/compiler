import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import { allOperationsOf, type IrOperation } from './model.js'
import { buildDyingArgumentIndex, dyingTransferUsesOf, ownedDyingValuesOf, receiverRenamesOf, transferOf } from './transfer.js'
import {
  nativeObjectDataSlotMatches,
  nativeObjectDataSlotAuthorityOf,
  type NativeObjectDataSlot,
  type NativeObjectDataSlotInput
} from './native-object-data-slots.js'
import { nativeObjectDataSlotSchemasOf } from '../semantics/native-object-data-slots.js'

const entry = resolve('test/runtime/typed-shared-view-preserves-primitive-sidecar-aliases.runtime.ts')
const compileSource = (source = readFileSync(entry, 'utf8')) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })
const operationsOf = (result: CompilationResult): IrOperation[] =>
  (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
const inputOf = (result: CompilationResult): NativeObjectDataSlotInput => ({
  bodies: new Map((result.irBodies ?? []).map((body) => [body.owner, body])),
  placements: result.projection.placements,
  graph: result.graph,
  deriver: result.representations.deriver,
  conversions: result.conversionCensus
})

test('standard zero-argument Object calls lower their native fresh result as an allocation', () => {
  const result = compileSource(`
    const first: Record<string, number> = Object();
    const second = new Object() as Record<string, number>;
    first.a = 1;
    second.b = 2;
    console.log(first.a, second.b, Object.keys(first).join(','), first === second);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const sources = new Set(
    [...result.graph.operations.values()].filter((one) => one.family === 'invocation' && one.freshOrdinaryObject).map((one) => one.id)
  )
  assert.equal(sources.size, 2)
  const allocations = operationsOf(result).filter(
    (one) => one.kind === 'allocate-record' && sources.has(result.graph.results.get(one.lineage)!)
  )
  assert.equal(allocations.length, 2)
  assert.ok(allocations.every((one) => one.kind === 'allocate-record' && one.result.representation.kind === 'dictionary'))
  assert.doesNotMatch(result.source!, /gea::Value::object\(\)/)
  const local = compileSource(`export {}; const Object = () => ({ known: 1 }); console.log(Object().known);`)
  assert.equal(local.diagnostics.clean, true, JSON.stringify(local.diagnostics.diagnostics))
  assert.equal(
    [...local.graph.operations.values()].some((one) => one.family === 'invocation' && one.freshOrdinaryObject),
    false
  )
})

test('Object-created dictionary entries retain finite native extension writers across loop and call aliases', () => {
  const file = resolve('test/runtime/object-constructor-called-without-a-value.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const writes = operationsOf(result).filter((operation) => operation.kind === 'set' && operation.nativeObjectDataSlot?.keyDomain)
  assert.equal(writes.length, 1)
  const receipt = writes[0]!.kind === 'set' ? writes[0]!.nativeObjectDataSlot : undefined
  assert.ok(receipt)
  assert.deepEqual([...receipt.keyDomain!].sort(), ['debug', 'error'])
  assert.ok(receipt.original, 'the actual selected entry retains its authenticated original native carrier')
  assert.equal(receipt.storage.kind, 'scalar')
  assert.ok(receipt.writers.length > 0)
  assert.doesNotMatch(result.source!, /gea::Value::object\(\)/)
})

test('an optional native extension owner retains the nullish lookup path independently of field absence', () => {
  const result = compileSource(`
    declare const present: boolean;
    const root = {};
    (root as { late: number }).late = 1;
    const selected: { late?: number } | undefined = present ? root : undefined;
    console.log(selected!.late);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const get = operationsOf(result).find(
    (operation) => operation.kind === 'get' && operation.nativeObjectDataSlot?.owner.representation.kind === 'optional'
  )
  assert.ok(get?.kind === 'get' && get.nativeObjectDataSlot)
  const receipt = get.nativeObjectDataSlot
  assert.ok(receipt.owner.representation.kind === 'optional')
  assert.ok(
    receipt.read.some((read) => read.source.kind === 'undefined'),
    'own-property absence keeps its separately certified result'
  )
  assert.equal(
    nativeObjectDataSlotMatches(receipt, {
      ...receipt,
      owner: { ...receipt.owner, representation: receipt.owner.representation.payload }
    }),
    false,
    'a receipt cannot erase the actual optional receiver carrier'
  )
  assert.match(result.source!, /Cannot access a nullish native view/)
  assert.doesNotMatch(result.source!, /gea::Value::object\(\)/)
})

test('typed alias keys use canonical native fixed slots or exact native extension receipts', () => {
  const result = compileSource()
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const authority = nativeObjectDataSlotAuthorityOf(inputOf(result))
  assert.equal(authority.required.size, authority.receipts.size, 'every required extension has a complete exact receipt')
  const operations = operationsOf(result)
  const keys = new Map(
    operations.flatMap((one) => (one.kind === 'constant' && one.literal === 'string' ? [[one.result.id, one.text] as const] : []))
  )
  const accesses = operations.filter(
    (one) => (one.kind === 'get' || one.kind === 'set') && ['extra', 'other'].includes(keys.get(one.key.value) ?? '')
  )
  assert.equal(accesses.filter((one) => one.kind === 'set').length, 3)
  assert.ok(accesses.filter((one) => one.kind === 'get').length >= 6)
  for (const operation of accesses) {
    assert.ok(operation.kind === 'get' || operation.kind === 'set')
    if (operation.kind !== 'get' && operation.kind !== 'set') continue
    const extension = operation.nativeObjectDataSlot
    const native = operation.kind === 'get' ? operation.nativeFieldViewRead : operation.nativeFieldViewWrite
    assert.ok(extension || native, 'every shared alias access cites its actual native storage route')
    if (operation.kind === 'get' && operation.nativeFieldViewRead)
      assert.ok(operation.nativeFieldViewRead.sources.every((one) => one.source.kind !== 'dynamic'))
    if (operation.kind === 'set' && operation.nativeFieldViewWrite)
      assert.ok(operation.nativeFieldViewWrite.targets.every((one) => one.target?.kind !== 'dynamic'))
  }
  assert.doesNotMatch(result.source!, /nativeSidecarGetText/)
  assert.doesNotMatch(result.source!, /nativeDynamicSet/)
  assert.doesNotMatch(result.source!, /gea::Value::box/)
  // Literal definition results and their original allocation SSA share one
  // physical Ref. The native extension owner must stay retained after the
  // original binding write, rather than moving under later receipt reads.
  const dyingArguments = buildDyingArgumentIndex(result.irBodies ?? [])
  for (const body of result.irBodies ?? []) {
    const aliases = receiverRenamesOf(body)
    const owners = new Set(
      [...body.blocks.values()]
        .flatMap(allOperationsOf)
        .flatMap((operation) =>
          (operation.kind === 'get' || operation.kind === 'set') && operation.nativeObjectDataSlot
            ? [operation.nativeObjectDataSlot.owner.value]
            : []
        )
    )
    const dyingValues = new Set([...ownedDyingValuesOf(body), ...dyingTransferUsesOf(body)])
    for (const operation of [...body.blocks.values()].flatMap(allOperationsOf)) {
      if (operation.kind !== 'binding-write') continue
      const root = aliases.get(operation.value.value) ?? operation.value.value
      if (!owners.has(root)) continue
      assert.equal(transferOf(dyingArguments, owners, dyingValues, operation.value.value, aliases), 'retain')
    }
  }
})

test('an extension receipt cannot substitute allocation, writer, carrier, absence or native RHS', () => {
  const read: NativeObjectDataSlot = {
    allocation: 'source-allocation' as never,
    owner: {
      value: 'owner' as never,
      representation: { kind: 'record', shapeId: 'owner', ownership: 'shared-refcount', fields: [], accessors: [] }
    },
    key: 'extra',
    storage: { kind: 'string' },
    writers: ['source-set' as never],
    read: [{ source: { kind: 'string' }, conversion: 'native-string-read' }],
    write: null
  }
  const write: NativeObjectDataSlot = {
    ...read,
    read: [],
    write: { value: { value: 'source-rhs' as never, representation: { kind: 'string' } }, conversion: 'native-string-write' }
  }
  for (const changed of [
    { ...read, owner: { ...read.owner, value: 'other-object' as never } },
    { ...read, allocation: 'other-allocation' as never },
    { ...read, writers: [] },
    { ...read, storage: { kind: 'scalar', domain: 'number' } as const },
    { ...read, read: [] },
    { ...read, keyDomain: ['other'] },
    { ...read, original: { kind: 'record', shapeId: 'foreign', ownership: 'shared-refcount', fields: [], accessors: [] } as const }
  ])
    assert.equal(nativeObjectDataSlotMatches(read, changed), false)
  assert.equal(
    nativeObjectDataSlotMatches(write, {
      ...write,
      write: { ...write.write!, value: { ...write.write!.value, value: 'other-rhs' as never } }
    }),
    false
  )
})

test('different typed writers can share an actual native fixed union slot', () => {
  const result = compileSource(`const original = { shown: 'initial' };
const view = original as {shown: string; extra?: string | number};
view.extra = 'one'; view.extra = 2; console.log(view.extra);`)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const rows = operationsOf(result).filter((one) => one.kind === 'set')
  assert.equal(rows.length, 2)
  assert.equal(nativeObjectDataSlotAuthorityOf(inputOf(result)).required.size, 0)
  assert.ok(rows.every((one) => one.kind === 'set' && one.value.representation.kind === 'optional'))
  assert.ok(
    rows.every(
      (one) =>
        one.kind === 'set' && one.value.representation.kind === 'optional' && one.value.representation.payload.kind === 'tagged-union'
    )
  )
  assert.doesNotMatch(result.source!, /gea::Value::box/)
  assert.doesNotMatch(result.source!, /nativeDynamicSet/)
})

test('an inherited setter does not license unsupported typed descriptor installation', () => {
  const result =
    compileSource(`Object.defineProperty(Object.prototype, 'extra', {set(value: string) { console.log(value); }, configurable: true});
const original = {shown: 'initial'}; const view = original as {shown: string; extra?: string}; view.extra = 'one';`)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.source, null)
  assert.ok(
    result.refusals.some((one) => one.key === 'call-abi:object-value-conversions'),
    JSON.stringify(result.refusals)
  )
})

test('descriptor observation of an existing native optional slot retains its typed value', () => {
  const result = compileSource(`const original = {shown: 'initial'}; const view = original as {shown: string; extra?: string};
view.extra = 'one'; console.log(Object.getOwnPropertyDescriptor(original, 'extra')?.value);`)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.equal(nativeObjectDataSlotAuthorityOf(inputOf(result)).required.size, 0)
  assert.doesNotMatch(result.source!, /gea::Value::box/)
  assert.doesNotMatch(result.source!, /nativeDynamicSet/)
})

test('existing dictionary entry protocols remain separate from native object extensions', () => {
  for (const source of [
    `const handlers: Record<string, () => number> = {read: () => 1}; console.log(handlers.read!());`,
    `const values: Record<string, number> = {}; values.extra = 2; console.log(values.extra);`
  ]) {
    const result = compileSource(source)
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.notEqual(result.source, null, JSON.stringify(result.refusals))
    const authority = nativeObjectDataSlotAuthorityOf(inputOf(result))
    assert.equal(authority.required.size, 0)
    assert.equal(authority.receipts.size, 0)
  }
})

test('a spread writes the keys its literal lacks as typed object data that a wider view reads natively', () => {
  const file = resolve('test/runtime/spread-excess-keys-into-narrower-record-keep-source-order.runtime.ts')
  const result = compile({
    rootFileNames: [file],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const census = nativeObjectDataSlotSchemasOf(result.graph)
  const spreadWriters = new Set(
    [...census.schemas.values()].flatMap((slots) =>
      [...slots.values()].flatMap((schema) => (schema.writers.some((writer) => writer.spreadSource !== undefined) ? [schema.key] : []))
    )
  )
  for (const key of ['z', 'q', 'w', 'k']) assert.ok(spreadWriters.has(key), `the copy is a writer of ${key}`)
  const copies = operationsOf(result).filter((one) => one.kind === 'spread-copy')
  assert.ok(copies.length > 0)
  for (const copy of copies) {
    assert.ok(copy.kind === 'spread-copy' && copy.spreadConversionPlan)
    const stored = copy.spreadConversionPlan.expandoKeys
    assert.deepEqual([...stored.keys()].sort(), ['b', 'k', 'q', 'w', 'z'], 'every key the narrow layout lacks keeps its carrier')
    assert.ok([...stored.values()].flat().every((value) => value.kind === 'optional'))
  }
  // The wide view of the narrow literal is one of its census aliases, so its
  // reads are the allocation's own native data reads: the copy's carrier,
  // and absence where the source lacked the key.
  const copyIds = new Set(
    [...result.graph.operations.values()].flatMap((one) => (one.family === 'protocol' && one.protocol === 'spread' ? [one.id] : []))
  )
  for (const key of ['z', 'q', 'w', 'k']) {
    const read = operationsOf(result).find((one) => one.kind === 'get' && one.nativeObjectDataSlot?.key === key)
    assert.ok(read?.kind === 'get' && read.nativeObjectDataSlot, `the view read of ${key} has a native receipt`)
    const receipt = read.nativeObjectDataSlot
    assert.equal(receipt.storage.kind, 'optional', `the read of ${key} names the carrier the copy stored`)
    assert.ok(receipt.read.some((one) => one.source.kind === 'undefined'))
    assert.ok(receipt.writers.length > 0 && receipt.writers.every((writer) => copyIds.has(writer)))
  }
  assert.match(result.source!, /gea::nativeSpreadObjectDataSet</)
  assert.doesNotMatch(result.source!, /nativeSpreadExpandoSet\([^;]*Value::box/, 'no excess key is boxed at copy time')
})

test('a typed store into a key an open bulk copy may also write shares its dynamic own-property table', () => {
  const result = compileSource(`export {}
interface Doc { [key: string]: any }
class Ref {
  name = 'todos'
  db?: string
  fields: Doc = JSON.parse('{"x":1}')
  toJSON(): { $ref: string; $db?: string } & Doc {
    const o = Object.assign({ $ref: this.name }, this.fields)
    if (this.db != null) o.$db = this.db
    return o
  }
}
const ref = new Ref()
ref.db = 'app'
const json = ref.toJSON()
console.log(Object.keys(json).join(','), json.$db, JSON.stringify(json))`)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const stores = operationsOf(result).filter((one) => one.kind === 'set' && one.nativeObjectDataSlot?.key === '$db')
  assert.equal(stores.length, 1)
  const receipt = stores[0]!.kind === 'set' ? stores[0]!.nativeObjectDataSlot : undefined
  assert.ok(receipt?.write, 'the store installs its own native carrier')
  assert.equal(receipt.storage.kind, 'string')
  assert.equal(receipt.read.length, 0, 'no reader may assume the carrier an open writer shares')
  assert.ok(receipt.materialization !== undefined, 'every descriptor in a dynamic table carries its materializer')
  const authority = nativeObjectDataSlotAuthorityOf(inputOf(result))
  assert.ok(nativeObjectDataSlotMatches(authority.receipts.get(stores[0]!), receipt))
  assert.match(result.source!, /gea::nativeObjectDataSet<[^;]*"\$db"/)
})
