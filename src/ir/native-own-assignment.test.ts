import { coreHostMembers } from '../targets/cpp/host/host-members.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import { nativeObjectDataSlotSchemasOf } from '../semantics/native-object-data-slots.js'
import { nativeObjectDataStorageOf } from '../projection/native-object-data.js'
import { allOperationsOf, type CallOperation, type ConvertOperation, type GetOperation, type IrOperation } from './model.js'
import { nativeObjectDataSlotAuthorityOf } from './native-object-data-slots.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { nativeObjectSampleEntryOf, nativeObjectSampleMatches } from './native-object-sample.js'
import {
  nativeOwnAssignmentEffectFreeInterval,
  nativeOwnAssignmentRecipeOf,
  nativeOwnAssignmentRecipesMatch,
  nativeOwnAssignmentStoredValueConversionsOf,
  type NativeOwnAssignmentInputs
} from './native-own-assignment.js'

const entry = resolve('test/runtime/object-assign-literal-target-merges-optional-options.runtime.ts')
const compileSource = (source?: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    ...(source === undefined ? {} : { sourceOverlay: new Map([[entry, source]]) })
  })
const inputOf = (result: CompilationResult): NativeOwnAssignmentInputs => {
  const definitions = new Map(
    (result.irBodies ?? []).flatMap((body) =>
      [...body.blocks.values()].flatMap((block) =>
        allOperationsOf(block).flatMap((operation) => {
          const value = resultOfIrOperation(operation)
          return value === null ? [] : [[value.id, operation] as const]
        })
      )
    )
  )
  const bodies = new Map(
    (result.irBodies ?? []).flatMap((body) =>
      [...body.blocks.values()].flatMap((block) => allOperationsOf(block).map((operation) => [operation, body] as const))
    )
  )
  return {
    graph: result.graph,
    deriver: result.representations.deriver,
    conversions: result.conversionCensus,
    placements: result.projection.placements,
    selected: result.representations.plan.selected,
    calleeRendering: {
      hostMembers: coreHostMembers,
      graph: result.graph,
      deriver: result.representations.deriver,
      placements: result.projection.placements,
      plan: result.representations.plan,
      classes: result.projection.classes,
      hostMethodAliasDeclarations: new Set()
    },
    definitionOf: (value) => definitions.get(value) ?? null,
    bodyOf: (operation) => bodies.get(operation) ?? null
  }
}
const blocksOf = (result: CompilationResult) => (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()])
const details = (result: CompilationResult) =>
  JSON.stringify({ diagnostics: result.diagnostics.diagnostics, refusals: result.refusals, emission: result.emissionRefusals })

for (const fixture of [
  'copy-into-narrower-record-follows-layout-or-keeps-order.runtime.ts',
  'interface-family-copies-keep-undeclared-keys.runtime.ts',
  'intersection-field-reduces-absence-and-subclass.runtime.ts',
  'native-record-expando-recast.ts'
])
  test(`native copying authenticates the actual allocation and stored slots in ${fixture}`, () => {
    const result = compile({
      rootFileNames: [resolve('test/runtime', fixture)],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true,
      includeIr: true
    })
    assert.equal(result.diagnostics.clean, true, details(result))
    assert.notEqual(result.source, null, details(result))
    const copies = blocksOf(result)
      .flatMap(allOperationsOf)
      .filter((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)
    assert.ok(copies.length > 0, 'the typed copy must cite its native owner and complete stored writer family')
    for (const copy of copies) {
      const block = blocksOf(result).find((one) => one.operations.includes(copy))!
      assert.equal(
        nativeOwnAssignmentRecipesMatch(
          nativeOwnAssignmentRecipeOf(copy, allOperationsOf(block), inputOf(result)),
          copy.nativeOwnAssignment
        ),
        true
      )
    }
  })

test('optional bulk options install native source storage before a required owned sample', () => {
  const result = compileSource()
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const operations = blocksOf(result).flatMap(allOperationsOf)
  const assignment = operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeOwnAssignment !== undefined
  )
  const sample = operations.find(
    (operation): operation is ConvertOperation => operation.kind === 'convert' && operation.nativeObjectSample !== undefined
  )
  assert.ok(assignment?.nativeOwnAssignment)
  assert.ok(sample?.nativeObjectSample)
  const depth = assignment.nativeOwnAssignment.sources.flatMap((source) => source.fields).find((field) => field.key === 'depth')
  assert.equal(depth?.destination, 'extension')
  assert.equal(depth?.storage.kind, 'scalar')
  assert.equal(depth?.copiedPresent, true)
  const legacy = assignment.nativeOwnAssignment.sources
    .find((source) => source.ordinal === 1)
    ?.fields.find((field) => field.key === 'legacy')
  assert.equal(legacy?.storage.kind, 'optional', 'the source reader uses its actual contextual Optional<bool> storage')
  assert.equal(legacy?.held.kind, 'scalar', 'the complete stored bool family licenses the exact destination bool view')
  const legacyConversion = legacy === undefined ? null : result.conversionCensus.nodeById(legacy.conversion)
  assert.equal(legacyConversion?.source.kind, 'optional')
  assert.equal(legacyConversion?.target.kind, 'scalar')
  assert.equal(
    legacy?.storageFits.some((fit) => fit.source.kind === 'scalar' && fit.storage.kind === 'optional'),
    true
  )
  assert.equal(sample.nativeObjectSample.owner.value, sample.source.value, 'held reads use the recovered original allocation')
  assert.equal(sample.nativeObjectSample.fields.find((field) => field.key === 'depth')?.presence, 'proven')
  assert.equal(sample.nativeObjectSample.fields.find((field) => field.key === 'depth')?.sourceOrdinal, 2)
  assert.equal(
    operandsOfIrOperation(assignment).some((operand) => operand.value === assignment.nativeOwnAssignment!.owner.value),
    true
  )
  assert.equal(result.slotDrift.length, 0)
  assert.equal(result.printerDrift.length, 0)
  assert.match(result.source!, /nativeObjectDataSet/)
  assert.doesNotMatch(result.source!, /gea::Value::box|gea::nativeDynamicSet/)
})

test('a conditional source retains the exactly authenticated target evaluated before the branch', () => {
  const result = compileSource(`
    export {};
    function copy(includeLast: boolean) {
      const target = { fixed: 'kept' };
      const result = Object.assign(target, { depth: 1 }, includeLast ? { last: 'copied' } : null);
      console.log(result.fixed, Object.keys(result).join(','));
    }
    copy(true); copy(false);
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const block = blocksOf(result).find((block) => block.operations.some((one) => one.kind === 'call' && one.nativeOwnAssignment))!
  const operation = block.operations.find((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)!
  assert.ok(operation?.nativeOwnAssignment)
  assert.equal(operation.nativeOwnAssignment.owner.value, operation.arguments[0]!.value)
  const input = inputOf(result)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), input), operation.nativeOwnAssignment),
    true
  )
  const { definitionOf: omittedDefinitions, ...localDefinitions } = input
  assert.equal(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), localDefinitions), null)
  const { bodyOf: omittedBody, ...withoutOriginal } = input
  assert.equal(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), withoutOriginal), null)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), input), {
      ...operation.nativeOwnAssignment,
      owner: { ...operation.nativeOwnAssignment.owner, value: 'different-evaluated-target' as never }
    }),
    false
  )
  assert.equal(
    nativeOwnAssignmentRecipeOf(
      {
        ...operation,
        arguments: [{ ...operation.arguments[0]!, value: operation.arguments[1]!.value }, ...operation.arguments.slice(1)]
      },
      allOperationsOf(block),
      input
    ),
    null
  )
  const body = input.bodyOf!(operation)!
  assert.equal(
    nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), {
      ...input,
      bodyOf: () => ({ ...body, blocks: new Map() })
    }),
    null
  )
})

test('a conditional source cannot use the same-body original allocation after an opaque target publication', () => {
  const result = compileSource(`
    export declare function publish(value: unknown): void;
    function copy(includeLast: boolean) {
      const target = { fixed: 'kept' };
      publish(target);
      const result = Object.assign(target, { depth: 1 }, includeLast ? { last: 'copied' } : null);
      console.log(result.fixed);
    }
    copy(true);
  `)
  assert.equal(
    result.diagnostics.diagnostics.some((diagnostic) => diagnostic.id.startsWith('checker/')),
    false,
    details(result)
  )
  assert.equal(result.source, null, details(result))
  assert.equal(
    result.refusals.some((refusal) => refusal.key === 'call-abi:native-own-assignment'),
    true,
    details(result)
  )
  const operations = blocksOf(result).flatMap(allOperationsOf)
  const planned = operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.hostTemplate === 'object-assign'
  )
  assert.ok(planned, 'source withdrawal must retain the native frame plan')
  assert.ok(planned.arguments.every((argument) => argument.representation.kind !== 'dynamic'))
  const callee = operations.find((operation) => operation.kind === 'get' && operation.result.id === planned.callee.value)
  assert.ok(callee?.kind === 'get')
  assert.equal(callee.nativeHostMethodRead, undefined, 'ambient shape cannot publish an inert Get after source integrity is withdrawn')
})

test('native bulk receipts reject substituted source SSA, store node and original allocation', () => {
  const result = compileSource()
  const block = blocksOf(result).find((block) =>
    block.operations.some((one) => one.kind === 'call' && one.nativeOwnAssignment !== undefined)
  )
  assert.ok(block)
  const operation = block.operations.find((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)
  assert.ok(operation?.nativeOwnAssignment)
  const receipt = operation.nativeOwnAssignment
  const expected = nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), inputOf(result))
  assert.equal(nativeOwnAssignmentRecipesMatch(expected, receipt), true)
  assert.equal(nativeOwnAssignmentRecipesMatch(expected, { ...receipt, allocation: 'different-allocation' as never }), false)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(expected, {
      ...receipt,
      sources: receipt.sources.map((source) => ({ ...source, receiver: { ...source.receiver, value: receipt.owner.value } }))
    }),
    false
  )
  assert.equal(
    nativeOwnAssignmentRecipesMatch(expected, {
      ...receipt,
      sources: receipt.sources.map((source) => ({
        ...source,
        fields: source.fields.map((field) => ({ ...field, conversion: 'unpublished-copy-leaf' }))
      }))
    }),
    false
  )
  const forged = { ...operation, arguments: operation.arguments.map((argument, ordinal) => (ordinal === 2 ? receipt.owner : argument)) }
  assert.equal(nativeOwnAssignmentRecipeOf(forged, allOperationsOf(block), inputOf(result)), null)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(expected, {
      ...receipt,
      sources: receipt.sources.map((source) => ({
        ...source,
        fields: source.fields.map((field) => ({ ...field, storage: { kind: 'scalar', domain: 'number' } }))
      }))
    }),
    false,
    'an exact native reader cannot borrow a different storage/policy token'
  )
  assert.equal(
    nativeOwnAssignmentRecipesMatch(expected, {
      ...receipt,
      sources: receipt.sources.map((source) => ({
        ...source,
        fields: source.fields.map((field) => ({ ...field, storageFits: [] }))
      }))
    }),
    false,
    'omitting all-writer proof citations cannot retain a native storage receipt'
  )
})

test('owned sampling requires the installing normal edge and exact owner/key/presence citations', () => {
  const result = compileSource()
  const block = blocksOf(result).find((block) =>
    block.operations.some((one) => one.kind === 'convert' && one.nativeObjectSample !== undefined)
  )
  assert.ok(block)
  const operation = block.operations.find((one): one is ConvertOperation => one.kind === 'convert' && one.nativeObjectSample !== undefined)
  assert.ok(operation?.nativeObjectSample)
  const before: readonly IrOperation[] = block.operations.slice(0, block.operations.indexOf(operation))
  const input = inputOf(result)
  assert.equal(nativeObjectSampleMatches(operation, before, input), true)
  const { nativeObjectSample: omitted, ...withoutReceipt } = operation
  assert.equal(nativeObjectSampleMatches(withoutReceipt, before, input), false)
  assert.equal(
    nativeObjectSampleMatches(
      {
        ...operation,
        nativeObjectSample: {
          ...operation.nativeObjectSample,
          owner: { ...operation.nativeObjectSample.owner, value: 'different-owner' as never }
        }
      },
      before,
      input
    ),
    false
  )
  assert.equal(
    nativeObjectSampleMatches(
      {
        ...operation,
        nativeObjectSample: {
          ...operation.nativeObjectSample,
          fields: operation.nativeObjectSample.fields.map((field) => ({ ...field, sourceOrdinal: 1 }))
        }
      },
      before,
      input
    ),
    false
  )
  assert.equal(
    nativeObjectSampleEntryOf(
      operation.nativeObjectSample.observed,
      operation.result.representation,
      before.filter((one) => one.kind !== 'call' || one.lineage !== operation.nativeObjectSample!.assignment),
      input
    ),
    null
  )
})

test('complete bulk storage includes a later native parameter-alias writer instead of hiding it behind closure', () => {
  const result = compileSource(`
    export {};
    function update(value: { depth: number | string }) { value.depth = 'later'; }
    const target = { label: 'before' };
    Object.assign(target, { depth: 1 });
    update(target as typeof target & { depth: number });
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  const census = nativeObjectDataSlotSchemasOf(result.graph)
  const schema = [...census.schemas.values()].map((slots) => slots.get('depth')).find((schema) => schema?.storedValues !== undefined)
  assert.ok(schema?.storedValues)
  assert.equal(
    schema.storedValues.some(
      (value) => value.source.kind === 'constant' && value.source.literal === 'string' && value.source.text === 'later'
    ),
    true
  )
  assert.equal(
    nativeObjectDataStorageOf(schema, result.representations.deriver),
    null,
    'differing actual writers need their own native join; a copied number cannot size this slot alone'
  )
})

test('an actual absent value writer cannot borrow the closed present bool copy proof', () => {
  const result = compileSource(`
    export {};
    function read(value: { legacy: boolean; depth: number }): string { return value.legacy + ':' + value.depth; }
    const target: { legacy?: boolean } = { legacy: false };
    const options: { legacy?: boolean } = { legacy: true };
    options.legacy = undefined;
    const merged = Object.assign(target, options, { depth: 1 });
    console.log(read(merged as { legacy: boolean; depth: number }));
  `)
  assert.equal(result.diagnostics.planClean, true, details(result))
  const assignment = blocksOf(result)
    .flatMap(allOperationsOf)
    .find((operation): operation is CallOperation => operation.kind === 'call' && operation.intrinsicReturnIdentity === 'argument0')
  assert.ok(assignment)
  assert.ok(assignment.nativeOwnAssignment, 'the physical optional slot can truthfully hold the copied undefined value')
  assert.equal(
    blocksOf(result)
      .flatMap(allOperationsOf)
      .some((operation) => operation.kind === 'convert' && operation.nativeObjectSample !== undefined),
    false,
    'a required bool sample must not borrow the optional storage proof'
  )
  assert.equal(result.source, null)
  assert.equal(
    result.refusals.some((refusal) => refusal.key.includes('conversion:')),
    true
  )
})

test('actual numeric writers fit fixed optional numeric storage through exact total recipes', () => {
  const result = compileSource(`
    export {};
    const target: { count?: number } = { count: 1 };
    const source = { count: 2 };
    Object.assign(target, source);
    console.log(target.count);
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const assignment = blocksOf(result)
    .flatMap(allOperationsOf)
    .find((operation): operation is CallOperation => operation.kind === 'call' && operation.nativeOwnAssignment !== undefined)
  assert.ok(assignment?.nativeOwnAssignment)
  const field = assignment.nativeOwnAssignment.sources.flatMap((source) => source.fields).find((field) => field.key === 'count')
  assert.equal(field?.held.kind, 'optional')
  assert.equal(
    field?.storageFits.some((fit) => fit.source.kind === 'scalar' && fit.storage.kind === 'optional'),
    true
  )
  for (const fit of field?.storageFits ?? []) {
    const node = result.conversionCensus.nodeById(fit.conversion)
    assert.equal(node !== null, true)
    assert.equal(result.certificate?.conversionNodeIds.includes(fit.conversion), true)
  }
  const semantic = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'invocation' && operation.nativeOwnAssignment !== undefined
  )
  assert.ok(semantic?.family === 'invocation' && semantic.nativeOwnAssignment)
  const stored = semantic.nativeOwnAssignment.targetSlots.flatMap((root) => root.slots).find((slot) => slot.key === 'count')?.values
  assert.ok(stored?.length && field)
  assert.equal(nativeOwnAssignmentStoredValueConversionsOf(stored, field.held, inputOf(result)) !== null, true)
})

test('a genuine declared-any source dictionary copies checked entries into native extension storage', () => {
  const result = compileSource(`
    export {};
    const target: { fixed: string } = { fixed: 'kept' };
    const source: Record<string, any> = { label: 'native', count: 2 };
    const result = Object.assign(target, source);
    console.log(result.fixed, (result as any).label, (result as any).count, Object.keys(result).join(','));
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const block = blocksOf(result).find((block) =>
    block.operations.some((operation) => operation.kind === 'call' && operation.nativeOwnAssignment !== undefined)
  )!
  assert.ok(block)
  const assignment = block.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeOwnAssignment !== undefined
  )!
  assert.ok(assignment.nativeOwnAssignment)
  const source = assignment.nativeOwnAssignment.sources[0]!
  assert.equal(source.protocol, 'dictionary-entry')
  assert.equal(source.receiver.representation.kind, 'dictionary')
  assert.deepEqual(
    source.fields.map((field) => [field.key, field.storage.kind, field.held.kind]),
    [
      ['label', 'dynamic', 'string'],
      ['count', 'dynamic', 'scalar']
    ]
  )
  for (const field of source.fields) {
    const node = result.conversionCensus.nodeById(field.conversion)
    assert.equal(node, result.conversionCensus.dictionaryReadFor(field.storage, field.held))
    assert.equal(node !== null && 'materializer' in node.capability && node.capability.materializer.dictionaryRead !== undefined, true)
    assert.equal(result.certificate?.conversionNodeIds.includes(field.conversion), true)
  }
  assert.equal(
    nativeOwnAssignmentRecipesMatch(
      nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)),
      assignment.nativeOwnAssignment
    ),
    true
  )
  assert.match(result.source!, /gea_assign_source->enumerableKeys\(\)/)
  assert.match(result.source!, /gea_assign_source->read\(gea_assign_key\.text\(\)\)/)
  assert.doesNotMatch(result.source!, /Value::box\(gea::Value::Tag::Object,\s*gea_assign_source/)
  const reads = blocksOf(result)
    .flatMap(allOperationsOf)
    .filter((operation): operation is GetOperation => operation.kind === 'get' && operation.nativeObjectDataSlot !== undefined)
  assert.equal(reads.length, 2)
  for (const read of reads) {
    const semantic = result.graph.operations.get(result.graph.results.get(read.lineage)!)
    assert.equal(semantic?.family === 'property' && semantic.sourceAnyRead, true)
    assert.equal(read.kind === 'get' && ['string', 'scalar'].includes(read.nativeObjectDataSlot!.storage.kind), true)
    if (semantic?.family === 'property') {
      const { sourceAnyRead: removed, ...ordinary } = semantic
      const graph = { ...result.graph, operations: new Map(result.graph.operations).set(semantic.id, ordinary) }
      assert.equal(
        nativeObjectDataSlotAuthorityOf({
          bodies: new Map((result.irBodies ?? []).map((body) => [body.owner, body])),
          placements: result.projection.placements,
          graph,
          deriver: result.representations.deriver,
          conversions: result.conversionCensus
        }).receipts.has(read),
        false,
        'ambient result any alone cannot observe a typed extension as Value'
      )
    }
  }

  const semanticId = result.graph.results.get(assignment.lineage)!
  const semantic = result.graph.operations.get(semanticId)!
  assert.ok(semantic.family === 'invocation' && semantic.nativeOwnAssignment)
  const changed = {
    ...semantic,
    nativeOwnAssignment: {
      ...semantic.nativeOwnAssignment,
      sources: semantic.nativeOwnAssignment.sources.map((source) => ({
        ...source,
        roots: source.roots.map((root) => ({ ...root, slots: root.slots.map((slot) => ({ ...slot, copyPresent: false })) }))
      }))
    }
  }
  const graph = { ...result.graph, operations: new Map(result.graph.operations).set(semanticId, changed) }
  assert.equal(nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), { ...inputOf(result), graph }), null)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)), {
      ...assignment.nativeOwnAssignment,
      sources: [{ ...source, protocol: 'native-record' }]
    }),
    false
  )
})

test('a live public view copies hidden and grown keys through its certified original native reader', () => {
  const result = compileSource(`
    export {};
    interface Original { visible: string; hidden: string }
    interface First { visible: string; absent?: string }
    interface Public { visible: string }
    const original: Original = { hidden: 'initial', visible: 'seen' };
    const first: First = original;
    const view: Public = first;
    original.hidden = 'changed';
    (original as Original & { grown: number }).grown = 3;
    const copied = Object.assign({ fixed: 'kept' }, view);
    console.log(JSON.stringify(copied));
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const block = blocksOf(result).find((block) =>
    block.operations.some((one) => one.kind === 'call' && one.nativeOwnAssignment !== undefined)
  )!
  assert.ok(block)
  const assignment = block.operations.find((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)!
  assert.ok(assignment.nativeOwnAssignment)
  const source = assignment.nativeOwnAssignment.sources[0]!
  assert.equal(source.ordinal, 1)
  assert.equal(source.protocol, 'native-record')
  assert.deepEqual(
    source.fields.map((field) => field.key),
    ['hidden', 'visible', 'grown']
  )
  const root = source.roots[0]!
  assert.equal(source.roots.length, 1)
  const reader = root.readers.find((reader) => reader.conversion !== null)
  assert.ok(reader, 'the narrowed public view must authenticate native origin recovery')
  assert.notEqual(reader.surface, root.carrier)
  const node = result.conversionCensus.nodeById(reader.conversion!)
  assert.ok(node)
  assert.equal(node, result.conversionCensus.nodeFor(root.carrier, reader.surface))
  assert.equal(result.certificate?.conversionNodeIds.includes(reader.conversion!), true)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(
      nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)),
      assignment.nativeOwnAssignment
    ),
    true
  )
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)), {
      ...assignment.nativeOwnAssignment,
      sources: [{ ...source, roots: [{ ...root, readers: [] }] }]
    }),
    false,
    'source storage cannot remain certified after its original reader proof is removed'
  )
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)), {
      ...assignment.nativeOwnAssignment,
      sources: [{ ...source, roots: [{ ...root, readers: [{ ...reader, conversion: 'unpublished-origin-reader' }] }] }]
    }),
    false
  )
  assert.match(result.source!, /gea::record::viewOrigin\(gea_assign_public\)/)
  assert.match(result.source!, /refPayloadIdentity\(gea_assign_origin\)/)
  assert.match(result.source!, /gea_assign_origin\.template staticCast/)
  assert.match(result.source!, /nativeEnumerableStringKeys\(gea_assign_source\)/)
  assert.doesNotMatch(result.source!, /nativeEnumerableStringKeys\(gea_assign_public\)|Value::box\(gea::Value::Tag::Object,\s*gea_assign/)
})

test('original native source recovery does not close descriptor replacement or opaque publication', () => {
  for (const effect of [
    "Object.defineProperty(original, 'hidden', { get() { return 'observed'; }, enumerable: true });",
    'declare function publish(value: unknown): void; publish(original);'
  ]) {
    const result = compileSource(`
      export {};
      const original = { visible: 'seen', hidden: 'initial' };
      const view: { visible: string } = original;
      ${effect}
      const copied = Object.assign({ fixed: 'kept' }, view);
      console.log(copied.fixed);
    `)
    assert.equal(
      result.diagnostics.diagnostics.some((diagnostic) => diagnostic.id.startsWith('checker/')),
      false,
      details(result)
    )
    assert.equal(result.source, null, details(result))
    assert.equal(
      result.refusals.some((refusal) => refusal.key === 'call-abi:native-own-assignment'),
      true,
      details(result)
    )
  }
})

test('a dictionary source copy still refuses an unproved later-added entry', () => {
  for (const source of ["const source: Record<string, any> = { label: 'initial' }; source.later = 2;"]) {
    const result = compileSource(`
      export {};
      const target: { fixed: string } = { fixed: 'kept' };
      ${source}
      Object.assign(target, source);
      console.log(target.fixed);
    `)
    assert.equal(
      result.diagnostics.diagnostics.some((diagnostic) => diagnostic.id.startsWith('checker/')),
      false,
      details(result)
    )
    assert.equal(result.source, null, details(result))
    assert.equal(
      result.refusals.some((refusal) => refusal.key === 'call-abi:native-own-assignment'),
      true,
      details(result)
    )
  }
})

test('an unbound ambient dictionary fails at its actual name read before the copy can run', () => {
  const result = compileSource(`
    export {};
    declare const source: Record<string, any>;
    const target = { fixed: 'kept' };
    Object.assign(target, source);
    console.log(target.fixed);
  `)
  assert.equal(
    result.diagnostics.diagnostics.some((diagnostic) => diagnostic.id.startsWith('checker/')),
    false,
    details(result)
  )
  assert.notEqual(result.source, null, details(result))
  assert.match(result.source!, /ReferenceError/)
  assert.equal(
    blocksOf(result)
      .flatMap(allOperationsOf)
      .some((operation) => operation.kind === 'call' && operation.nativeOwnAssignment !== undefined),
    false
  )
})

test('a previous installing copy proves only its exact allocation and uninterrupted normal path', () => {
  const result = compileSource(`
    export {};
    function read(value: { depth: number }): number { return value.depth; }
    const second = {};
    const first = {};
    Object.assign(first, { depth: 1 });
    const merged = Object.assign(second, first);
    console.log(read(merged as { depth: number }));
  `)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const block = blocksOf(result).find((block) =>
    block.operations.some(
      (operation) =>
        operation.kind === 'call' &&
        operation.nativeOwnAssignment?.sources.some((source) => source.fields.some((field) => field.installations.length !== 0))
    )
  )
  assert.ok(block)
  const assignment = block.operations.find(
    (operation): operation is CallOperation =>
      operation.kind === 'call' &&
      operation.nativeOwnAssignment?.sources.some((source) => source.fields.some((field) => field.installations.length !== 0)) === true
  )
  assert.ok(assignment?.nativeOwnAssignment)
  const depth = assignment.nativeOwnAssignment.sources.flatMap((source) => source.fields).find((field) => field.key === 'depth')
  assert.equal(depth?.copiedPresent, true)
  assert.equal(depth?.installations.length, 1)
  const installation = depth!.installations[0]!
  assert.notEqual(installation.allocation, assignment.nativeOwnAssignment.allocation)
  const before = block.operations.filter((operation) => operation.lineage !== installation.assignment)
  assert.equal(nativeOwnAssignmentRecipeOf(assignment, before, inputOf(result))?.sources[0]?.fields[0]?.copiedPresent, false)
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(assignment, allOperationsOf(block), inputOf(result)), {
      ...assignment.nativeOwnAssignment,
      sources: assignment.nativeOwnAssignment.sources.map((source) => ({
        ...source,
        fields: source.fields.map((field) => ({
          ...field,
          installations: field.installations.map((entry) => ({ ...entry, allocation: assignment.nativeOwnAssignment!.allocation }))
        }))
      }))
    }),
    false
  )
})

test('effect-free intervals reject calls and nonidentity total conversions', () => {
  const result = compileSource(`export {}; const value: number | undefined = 1; console.log(value);`)
  const input = inputOf(result)
  const call = blocksOf(result)
    .flatMap(allOperationsOf)
    .find((operation) => operation.kind === 'call')
  assert.ok(call)
  assert.equal(nativeOwnAssignmentEffectFreeInterval([call], input), false)
  const conversion = result.conversionCensus.nodeFor(
    { kind: 'scalar', domain: 'number' },
    { kind: 'optional', payload: { kind: 'scalar', domain: 'number' }, absence: 'undefined' }
  )
  const operation: ConvertOperation = {
    kind: 'convert',
    lineage: call.lineage,
    source: { value: 'present-number' as never, representation: conversion.source },
    result: { id: 'optional-number' as never, representation: conversion.target },
    conversionUse: conversion.id
  }
  assert.equal(nativeOwnAssignmentEffectFreeInterval([operation], input), false)
})

const describedSource = `
  export {};
  interface Source { a?: number; flag?: boolean }
  interface Narrow { x: number; a?: number }
  const load = (document: any): Source => document as Source;
  const source = load(JSON.parse('{"flag":true,"a":2}'));
  const target: Narrow = { x: 0 };
  Object.assign(target, source);
  console.log(Object.keys(target).join(','));
`

test('a source no closed family describes is described by its own carrier', () => {
  const result = compileSource(describedSource)
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const fact = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'invocation' && operation.intrinsicMutation === 'object-assign'
  )
  assert.ok(fact?.family === 'invocation' && fact.nativeOwnAssignment)
  assert.deepEqual(fact.nativeOwnAssignment.targets, [], 'the session names no target: the IR identity spine is its proof')
  assert.deepEqual(fact.nativeOwnAssignment.sources[0]?.roots, [])
  assert.deepEqual([...(fact.nativeOwnAssignment.sources[0]?.described?.keys ?? [])].sort(), ['a', 'flag'])
  const block = blocksOf(result).find((one) => one.operations.some((op) => op.kind === 'call' && op.nativeOwnAssignment !== undefined))!
  const operation = block.operations.find((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)!
  const receipt = operation.nativeOwnAssignment!
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), inputOf(result)), receipt),
    true
  )
  const source = receipt.sources[0]!
  assert.equal(source.described, true)
  assert.deepEqual(source.roots, [])
  const flag = source.fields.find((field) => field.key === 'flag')
  assert.equal(flag?.destination, 'extension', 'a typed key the target layout lacks owes native object data')
  assert.equal(representationKeyOf(flag?.held), representationKeyOf(flag?.storage), 'the extension holds the source carrier field')
  assert.notEqual(flag?.materialization, undefined, 'the open table every described copy writes carries its Value materializer')
  assert.notEqual(flag?.documentRead, undefined, 'a Document view entry has its exact live read')
  assert.equal(source.fields.find((field) => field.key === 'a')?.destination, 'held')
  assert.match(result.source!, /nativeObjectDataSet/)
  assert.match(result.source!, /gea::nativeDynamicSet\(/, 'a run-time key outside the layout crosses as the Value it is')
  assert.match(
    result.source!,
    /nativeObjectDataSet<.*?>\(v\d+, gea::PropertyKey::string\("flag"\), gea_assign_stored, \+\[\]\(const gea::Optional<bool>&/,
    'the typed key keeps its native carrier, with a Value materializer only for a dynamic observer'
  )
  // The receipt binds the evaluated source and the target's original allocation.
  assert.equal(
    nativeOwnAssignmentRecipesMatch(nativeOwnAssignmentRecipeOf(operation, allOperationsOf(block), inputOf(result)), {
      ...receipt,
      sources: receipt.sources.map((one) => ({ ...one, receiver: { ...one.receiver, value: receipt.owner.value } }))
    }),
    false
  )
  const forged = {
    ...operation,
    arguments: [{ ...operation.arguments[0]!, value: operation.arguments[1]!.value }, ...operation.arguments.slice(1)]
  }
  assert.equal(nativeOwnAssignmentRecipeOf(forged, allOperationsOf(block), inputOf(result)), null)
})

test('a described source whose typed keys all have a target field keeps the open copy', () => {
  const result = compileSource(
    describedSource.replace('interface Narrow { x: number; a?: number }', 'interface Narrow { x: number; a?: number; flag?: boolean }')
  )
  assert.equal(result.diagnostics.clean, true, details(result))
  assert.notEqual(result.source, null, details(result))
  const copies = blocksOf(result)
    .flatMap(allOperationsOf)
    .filter((one): one is CallOperation => one.kind === 'call' && one.nativeOwnAssignment !== undefined)
  assert.equal(copies.length, 0)
})

const representationKeyOf = (value: unknown): string => JSON.stringify(value)
