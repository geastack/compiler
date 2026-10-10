import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { nativeFieldViewPlansOf } from '../conversion/native-field-view.js'
import { nativeViewOriginsOf } from '../conversion/native-view-origins.js'
import type { IrValueId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type GetOperation, type SetOperation } from './model.js'
import { nativeFieldViewDomainsOf } from './native-field-view-domains.js'
import type { ProgramConversionRecipe } from './program-conversions.js'
import {
  nativeFieldViewReadOf,
  nativeFieldViewWriteOf,
  nativeFieldViewReceiptMatches,
  nativeFieldViewReadSelectionOf,
  nativeFieldViewWriteSelectionOf,
  nativeFieldViewBodyCitationsOf,
  nativeFieldViewTargetsOf,
  nativeFieldViewDocumentTargetSetOf,
  nativeFieldViewOpenDocumentRead
} from './native-field-view-facts.js'

const text: Representation = { kind: 'string' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const mixed: Representation = {
  kind: 'tagged-union',
  arms: [
    { tag: 'text', semanticType: 'text' as StructuralTypeId, value: text, runtimeDiscriminator: { kind: 'carrier' } },
    { tag: 'number', semanticType: 'number' as StructuralTypeId, value: number, runtimeDiscriminator: { kind: 'carrier' } }
  ]
}
const view: Representation = {
  kind: 'record',
  shapeId: 'view',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'shown', value: text, required: true }]
}
const receiver = 'receiver' as IrValueId
const get: GetOperation = {
  kind: 'get',
  lineage: 'get' as SemanticResultId,
  receiver: { value: receiver, representation: view },
  key: { value: 'key' as IrValueId, representation: text },
  result: { id: 'read' as IrValueId, representation: mixed }
}
const set: SetOperation = {
  kind: 'set',
  lineage: 'set' as SemanticResultId,
  strict: true,
  receiver: get.receiver,
  key: get.key,
  value: { value: 'number' as IrValueId, representation: number },
  result: null
}
const census = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const flowOf = (stored: Representation) => ({
  nativeFieldStorageValues: new Map([[receiver, new Map([['shown', [stored]]])]]),
  nativeAccessorStorageValues: new Map(),
  nativeFieldMethodValues: new Map()
})

test('a typed write can enter genuine document entries only through an installed entry-boundary route', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const typed: Representation = { kind: 'record', shapeId: 'entry-object', ownership: 'shared-refcount', fields: [], accessors: [] }
  const operation: SetOperation = { ...set, value: { value: 'entry-object' as IrValueId, representation: typed } }
  const ordinary = flowOf(dynamic)
  assert.equal(nativeFieldViewWriteOf(operation, 'shown', ordinary, census()), null)
  const entries = (declaredAnyEntry?: true) => ({
    ...ordinary,
    nativeFieldViewStorageValues: new Map([
      [receiver, new Map([['shown', [{ read: dynamic, write: dynamic, ...(declaredAnyEntry ? { declaredAnyEntry } : {}) }]]])]
    ])
  })
  assert.equal(nativeFieldViewWriteOf(operation, 'shown', entries(), census()), null)
  assert.ok(nativeFieldViewWriteOf(operation, 'shown', entries(true), census()))
})

test('tagged receivers claim only their actual sealed live field plans', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/runtime/method-with-tagged-view-parameter-into-wider-view-union-slot.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const bodies = compiled.irBodies ?? []
  const nodes = recipeClosureOf(
    bodies.flatMap(nativeFieldViewBodyCitationsOf).flatMap((id) => {
      const node = compiled.conversionCensus.nodeById(id)
      return node === null ? [] : [node]
    }),
    compiled.conversionCensus.nodeById
  )
  const plans = nativeFieldViewPlansOf(nodes.values())
  const actual = new Set(plans.map((plan) => plan.target.shapeId))
  const targets = nativeFieldViewTargetsOf(bodies, compiled.conversionCensus)
  assert.ok(actual.size > 0)
  assert.deepEqual(targets, actual)
  const ordinary = nativeViewOriginsOf(nodes.values(), compiled.conversionCensus.nodeById).filter(
    (origin) => !actual.has(origin.target.shapeId)
  )
  for (const origin of ordinary) assert.equal(targets.has(origin.target.shapeId), false)
  assert.ok(
    bodies.some((body) =>
      [...body.blocks.values()].some((block) =>
        [...allOperationsOf(block)].some(
          (operation) => operation.kind === 'get' && operation.receiver.representation.kind === 'tagged-union'
        )
      )
    )
  )
})

test('an ownership view without the live callback contract cannot claim a native field target', () => {
  const conversions = census()
  const source = { ...view, shapeId: 'ownership-source', fields: [...view.fields, { key: 'extra', value: text, required: true }] }
  const target = { ...view, shapeId: 'ownership-target' }
  const node = conversions.nodeFor(source, target)
  assert.ok('materializer' in node.capability)
  const { nativeFieldViewProtocol: protocol, ...materializer } = node.capability.materializer
  assert.equal(protocol, 'live')
  const ordinary = { ...node, capability: { ...node.capability, materializer } }
  assert.deepEqual(
    nativeViewOriginsOf([ordinary], conversions.nodeById).map((origin) => origin.target.shapeId),
    [target.shapeId]
  )
  assert.deepEqual(nativeFieldViewPlansOf([ordinary]), [])
})

test('only selected canonical program artifacts add field-view targets outside operation bodies', () => {
  const conversions = census()
  const source = { ...view, shapeId: 'program-source', fields: [...view.fields, { key: 'extra', value: text, required: true }] }
  const target = { ...view, shapeId: 'program-target' }
  const conversion = conversions.nodeFor(source, target)
  const recipe: ProgramConversionRecipe = {
    role: 'dynamic-field-write',
    owner: 'selected-record',
    slot: 'shown',
    source,
    target,
    conversion
  }
  assert.deepEqual(nativeFieldViewTargetsOf([], conversions), new Set())
  assert.deepEqual(nativeFieldViewTargetsOf([], conversions, [recipe]), new Set([target.shapeId]))
  assert.deepEqual(nativeFieldViewTargetsOf([], conversions, [{ ...recipe, conversion: { ...conversion } }]), new Set())
  const other = { ...target, shapeId: 'unselected-target' }
  conversions.nodeFor(source, other)
  assert.deepEqual(nativeFieldViewTargetsOf([], conversions, [recipe]), new Set([target.shapeId]))
})

test('an actual wider native slot licenses the alias writer and retains the whole read carrier', () => {
  const conversions = census()
  const flow = flowOf(mixed)
  const write = nativeFieldViewWriteOf(set, 'shown', flow, conversions)
  assert.ok(write)
  assert.deepEqual(write.targets, [{ target: mixed, conversion: conversions.nodeFor(number, mixed).id }])
  const read = nativeFieldViewReadOf(get, 'shown', flow, conversions)
  assert.ok(read)
  assert.equal(read.sources[0]?.conversion, conversions.nodeFor(mixed, mixed).id)
  assert.equal(representationKey(read.sources[0]!.source), representationKey(mixed))
  assert.equal(nativeFieldViewReceiptMatches(read, { ...read, receiver: 'another-alias' as IrValueId }), false)
})

test('a wider public declaration supplies no permission to write an unchanged narrow source slot', () => {
  const conversions = census()
  assert.equal(nativeFieldViewWriteOf(set, 'shown', flowOf(text), conversions), null)
  assert.equal(nativeFieldViewWriteOf(set, 'shown', flowOf(mixed), conversions)?.targets.length, 1)
})

test('getters and setters cite independent physical conventions and stale receipts are rejected', () => {
  const conversions = census()
  const flow = {
    nativeFieldStorageValues: new Map(),
    nativeFieldMethodValues: new Map(),
    nativeAccessorStorageValues: new Map([[receiver, new Map([['shown', [{ read: text, write: number }]]])]])
  }
  const read = nativeFieldViewReadOf({ ...get, result: { ...get.result, representation: text } }, 'shown', flow, conversions)
  const write = nativeFieldViewWriteOf(set, 'shown', flow, conversions)
  assert.ok(read)
  assert.ok(write)
  assert.deepEqual(read.sources, [{ source: text, conversion: conversions.nodeFor(text, text).id }])
  assert.deepEqual(write.targets, [{ target: number, conversion: conversions.nodeFor(number, number).id }])
  assert.equal(nativeFieldViewReceiptMatches(write, { ...write, key: 'stored' }), false)
})

test('a getter-only descriptor retains an exact false Set route without invoking its getter', () => {
  const conversions = census()
  const flow = {
    nativeFieldStorageValues: new Map(),
    nativeFieldMethodValues: new Map(),
    nativeAccessorStorageValues: new Map([[receiver, new Map([['shown', [{ read: text, write: null }]]])]])
  }
  const receipt = nativeFieldViewWriteOf(set, 'shown', flow, conversions)
  assert.ok(receipt)
  assert.deepEqual(receipt.targets, [{ target: null, conversion: null }])
  assert.equal(nativeFieldViewReceiptMatches(receipt, { ...receipt, value: 'another-rhs' as IrValueId }), false)
})

test('a dynamic sidecar writer cannot box a statically typed native object', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.ok(nativeFieldViewWriteOf(set, 'shown', flowOf(dynamic), census()))
  assert.equal(nativeFieldViewWriteOf({ ...set, value: { ...set.value, representation: view } }, 'shown', flowOf(dynamic), census()), null)
})

test('a selected checked view keeps every original primitive route and replays its check on incompatible leaves', () => {
  const conversions = census()
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const record = (shapeId: string, value: Representation): Extract<Representation, { kind: 'record' }> => ({
    kind: 'record',
    shapeId,
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'shown', value, required: true }]
  })
  const intermediate = record('intermediate', dynamic)
  const target = record('checked', text)
  const originals = [record('text', text), record('number', number), record('absent', { kind: 'undefined' })]
  const roots = [...originals.map((source) => conversions.nodeFor(source, intermediate)), conversions.nodeFor(intermediate, target)]
  const closure = recipeClosureOf(roots, conversions.nodeById)
  assert.ok(roots.every((node) => node.capability.kind !== 'never'))
  const fields = nativeFieldViewDomainsOf(closure.values(), null, () => null)(target)
  assert.ok(fields)
  const physical = fields.get('shown')!
  assert.ok(physical.some((entry) => entry.read.kind === 'scalar' && entry.checkedRead !== undefined))
  assert.ok(physical.some((entry) => entry.read.kind === 'undefined' && entry.checkedRead !== undefined))
  const operation: GetOperation = {
    ...get,
    receiver: { ...get.receiver, representation: target },
    result: { ...get.result, representation: text }
  }
  const flow = { ...flowOf(text), nativeFieldStorageValues: new Map(), nativeFieldViewStorageValues: new Map([[receiver, fields]]) }
  const receipt = nativeFieldViewReadOf(operation, 'shown', flow, conversions)
  assert.ok(receipt)
  assert.deepEqual(
    new Set(receipt.sources.map((entry) => representationKey(entry.source))),
    new Set([text, number, dynamic, { kind: 'undefined' } as Representation].map(representationKey))
  )
  const mismatch = receipt.sources.find((entry) => entry.source.kind === 'scalar')!
  const node = conversions.nodeById(mismatch.conversion)!
  assert.ok(node.capability.kind === 'static' && node.capability.materializer.checkedNativeFieldRead)
  assert.equal(conversions.nodeFor(number, text).capability.kind, 'never')
  assert.equal(
    nativeFieldViewReceiptMatches(receipt, { ...receipt, sources: receipt.sources.filter((entry) => entry.source.kind !== 'undefined') }),
    false
  )
  const unchecked = new Map([['shown', physical.map(({ read, write }) => ({ read, write }))]])
  assert.equal(
    nativeFieldViewReadOf(operation, 'shown', { ...flow, nativeFieldViewStorageValues: new Map([[receiver, unchecked]]) }, conversions),
    null
  )
})

test('promise iterator results preserve the selected checked value field route at the actual read', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/runtime/iterator-result-literal-into-promise-of-union.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  assert.ok(
    (compiled.irBodies ?? []).some((body) =>
      [...body.blocks.values()].some((block) =>
        [...allOperationsOf(block)].some(
          (operation) =>
            operation.kind === 'get' &&
            operation.nativeFieldViewRead?.sources.some((entry) => {
              const node = compiled.conversionCensus.nodeById(entry.conversion)
              return node?.capability.kind === 'static' && node.capability.materializer.checkedNativeFieldRead !== undefined
            })
        )
      )
    )
  )
})

test('finite computed keys require every original slot and retain every distinct native leaf', () => {
  const conversions = census()
  const flow = {
    ...flowOf(text),
    nativeFieldStorageValues: new Map([
      [
        receiver,
        new Map<string, readonly Representation[]>([
          ['shown', [text]],
          ['count', [number]]
        ])
      ]
    ])
  }
  const read = nativeFieldViewReadSelectionOf(get, ['shown', 'count', 'shown'], flow, conversions)
  assert.ok(read)
  assert.deepEqual(read.keyDomain, ['count', 'shown'])
  assert.deepEqual(
    read.sources.map(({ source }) => representationKey(source)),
    [representationKey(number), representationKey(text)]
  )
  assert.equal(nativeFieldViewReceiptMatches(read, { ...read, keyDomain: ['count'] }), false)
  assert.equal(nativeFieldViewReadSelectionOf(get, ['shown', 'missing'], flow, conversions), null)
  assert.equal(nativeFieldViewReadSelectionOf(get, [], flow, conversions), null)

  // A public union-valued slot does not authorize writing a number into the
  // original string field selected by the other possible key.
  assert.equal(nativeFieldViewWriteSelectionOf(set, ['count', 'shown'], flow, conversions), null)
  const admitted = {
    ...flow,
    nativeFieldStorageValues: new Map([
      [
        receiver,
        new Map<string, readonly Representation[]>([
          ['shown', [mixed]],
          ['count', [number]]
        ])
      ]
    ])
  }
  const write = nativeFieldViewWriteSelectionOf(set, ['shown', 'count'], admitted, conversions)
  assert.ok(write)
  assert.deepEqual(write.keyDomain, ['count', 'shown'])
  assert.deepEqual(
    write.targets.map(({ target }) => target && representationKey(target)),
    [representationKey(number), representationKey(mixed)]
  )
})

test('a source Has edge selects actual ordinary descriptors through reciprocal live views', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/fixtures/owned-record-union.ts')],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)]))
  const keys = new Map(
    operations.flatMap((operation) =>
      operation.kind === 'constant' && operation.literal === 'string' ? [[operation.result.id, operation.text] as const] : []
    )
  )
  assert.ok(
    operations.some(
      (operation) =>
        operation.kind === 'get' &&
        operation.nativeHostMethodRead?.protocol === 'Console' &&
        operation.nativeHostMethodRead.member === 'log'
    )
  )
  assert.ok(
    operations.some(
      (operation) =>
        operation.kind === 'has-property' &&
        keys.get(operation.key.value) === '$type' &&
        operation.ordinaryObjectPrototypeKeyAbsent === true
    )
  )
  assert.ok(
    operations.some(
      (operation) =>
        operation.kind === 'set' &&
        keys.get(operation.key.value) === '$type' &&
        operation.nativeFieldViewWrite?.targets.some((entry) => entry.target?.kind === 'string')
    )
  )
  assert.ok(
    operations.some(
      (operation) =>
        operation.kind === 'get' &&
        keys.get(operation.key.value) === '$type' &&
        operation.nativeFieldViewRead?.sources.every((entry) => entry.source.kind === 'string')
    )
  )
  assert.match(compiled.source!, /hasPropertyFieldView|nativeDynamicHasProperty/)
})

test('an unsupported host descriptor replacement cannot borrow a deferred lookup receipt to compile', () => {
  const file = resolve('test/fixtures/owned-record-union.ts')
  const compiled = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([
      [file, `Object.defineProperty(console, 'log', { get() { return function() {} } })\n${readFileSync(file, 'utf8')}`]
    ]),
    closedScriptScope: true,
    includeIr: true
  })
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  assert.ok(operations.some((operation) => operation.kind === 'get'))
  assert.equal(compiled.source, null)
})

test('a same-shaped application ambient binding cannot claim the standard singleton lookup', () => {
  const file = resolve('test/fixtures/owned-record-union.ts')
  const compiled = compile({
    rootFileNames: [file],
    projectFileName: null,
    sourceOverlay: new Map([[file, `export declare const console: Console\n${readFileSync(file, 'utf8')}`]]),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const owners = operations.filter(
    (operation) =>
      operation.kind === 'binding-read' &&
      operation.result.representation.kind === 'native-handle' &&
      operation.result.representation.protocol === 'Console'
  )
  assert.ok(owners.length > 0)
  for (const owner of owners) {
    assert.ok(owner.kind === 'binding-read')
    assert.equal(compiled.projection.placements.get(owner.declaration)?.storage.kind, 'external')
  }
  assert.equal(
    operations.some((operation) => operation.kind === 'get' && operation.nativeHostMethodRead?.protocol === 'Console'),
    false
  )
  assert.ok(compiled.source)
  assert.match(compiled.source, /extern gea::NativeHandle<gea_native_protocol_Console_v1> console;/)
})

test('generator parameter binding reads an original absent descriptor before entering its suspended body', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/runtime/generator-parameter-binding-at-call.runtime.js')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const reads = operations.filter((operation) => operation.kind === 'get' && operation.nativeFieldViewRead?.originalAbsent === true)
  assert.ok(reads.length > 0)
  for (const operation of reads) {
    assert.ok(operation.kind === 'get')
    assert.equal(operation.ordinaryObjectPrototypeKeyAbsent, true)
    const receipt = operation.nativeFieldViewRead!
    assert.ok(receipt.sources.some(({ source }) => source.kind === 'undefined'))
    const { originalAbsent: proof, ...unproved } = receipt
    assert.equal(proof, true)
    assert.equal(nativeFieldViewReceiptMatches(receipt, unproved), false)
  }
})

test('a live fixed-field view preserves original absence and refuses to borrow mutated prototype absence', () => {
  const file = resolve('test/runtime/fixed-field-assignment-widening.runtime.js')
  const request = {
    rootFileNames: [file],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  }
  const compiled = compile(request)
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const keys = new Map(
    operations.flatMap((operation) =>
      operation.kind === 'constant' && operation.literal === 'string' ? [[operation.result.id, operation.text] as const] : []
    )
  )
  assert.ok(
    operations.some(
      (operation) => operation.kind === 'get' && keys.get(operation.key.value) === 'depth' && operation.nativeFieldViewRead?.originalAbsent
    )
  )
  const reparented = compile({
    ...request,
    sourceOverlay: new Map([
      [
        file,
        readFileSync(file, 'utf8').replace(
          'fixedSource.data = requiredImage',
          'Object.setPrototypeOf(requiredImage, { depth: 9 });\nfixedSource.data = requiredImage'
        )
      ]
    ])
  })
  const changedOperations = (reparented.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const changedKeys = new Map(
    changedOperations.flatMap((operation) =>
      operation.kind === 'constant' && operation.literal === 'string' ? [[operation.result.id, operation.text] as const] : []
    )
  )
  const changedReads = changedOperations.filter((operation) => operation.kind === 'get' && changedKeys.get(operation.key.value) === 'depth')
  assert.ok(changedReads.length > 0)
  for (const read of changedReads) {
    assert.ok(read.kind === 'get')
    assert.notEqual(
      read.nativeFieldViewRead?.originalAbsent,
      true,
      'an altered allocation prototype cannot borrow standard prototype absence'
    )
  }
  const mutated = compile({
    ...request,
    sourceOverlay: new Map([[file, `Reflect.set(Object.prototype, 'depth', 9)\n${readFileSync(file, 'utf8')}`]])
  })
  const reads = [...mutated.graph.operations.values()].filter(
    (operation) =>
      operation.family === 'property' &&
      operation.internalMethod === 'get' &&
      operation.operands.some((operand) => operand.role === 'key' && operand.source.kind === 'constant' && operand.source.text === 'depth')
  )
  assert.ok(reads.length > 0)
  for (const read of reads) assert.equal('ordinaryObjectPrototypeKeyAbsent' in read && read.ordinaryObjectPrototypeKeyAbsent, false)
})

test('Document marker cleanup retains the operation identity of dominating native presence receipts', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/fixtures/owned-record-union.ts')],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const operations = (compiled.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const keys = new Map(
    operations.flatMap((operation) =>
      operation.kind === 'constant' && operation.literal === 'string' ? [[operation.result.id, operation.text] as const] : []
    )
  )
  const writes = operations.filter((operation) => operation.kind === 'set' && keys.get(operation.key.value) === '$type')
  const reads = operations.filter((operation) => operation.kind === 'get' && keys.get(operation.key.value) === '$type')
  assert.equal(writes.length, 1)
  assert.equal(reads.length, 1)
  for (const write of writes) assert.ok(write.kind === 'set' && write.nativeFieldViewWrite)
  for (const read of reads) assert.ok(read.kind === 'get' && read.nativeFieldViewRead && !read.nativeFieldViewRead.originalAbsent)
})

test('an open runtime key needs no fixed-key receipt only over Document-only live views', () => {
  const entry: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const document = { kind: 'dictionary', key: 'string', ownership: 'shared-refcount', value: entry } as const
  const documentPlan = {
    source: document,
    target: view as Extract<Representation, { kind: 'record' }>,
    fields: [{ key: 'shown', read: entry, write: entry, declaredAnyEntry: true as const }]
  }
  const recordPlan = {
    source: view as Extract<Representation, { kind: 'record' }>,
    target: view as Extract<Representation, { kind: 'record' }>,
    fields: [{ key: 'shown', read: text, write: text }]
  }
  const targets = new Set(['view'])
  const documents = nativeFieldViewDocumentTargetSetOf([documentPlan])
  assert.deepEqual([...documents], ['view'])
  const open: GetOperation = { ...get, result: { id: 'read' as IrValueId, representation: entry } }
  assert.equal(nativeFieldViewOpenDocumentRead(open, undefined, targets, documents), true)
  // A finite proven key set keeps its exact per-key receipt; so does a constant key.
  assert.equal(nativeFieldViewOpenDocumentRead({ ...open, provenKeyTexts: ['shown'] }, undefined, targets, documents), false)
  assert.equal(nativeFieldViewOpenDocumentRead(open, 'shown', targets, documents), false)
  // Writes always need their exact target route.
  assert.equal(nativeFieldViewOpenDocumentRead(set, undefined, targets, documents), false)
  // One fixed-field record view beside the Document view has placeholder slots an open key would read.
  const mixedDocuments = nativeFieldViewDocumentTargetSetOf([documentPlan, recordPlan])
  assert.equal(mixedDocuments.size, 0)
  assert.equal(nativeFieldViewOpenDocumentRead(open, undefined, targets, mixedDocuments), false)
})
