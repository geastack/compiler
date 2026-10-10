import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { fixedDataDefinitionCallMatches, fixedDataDefinitionRecipeOf } from './fixed-data-definition.js'
import { fixedDataDefinitionAttributesOf } from './fixed-data-definition-attributes.js'
import type { NativeDataDefinitionInput } from './native-data-definition.js'
import { allOperationsOf, type CallOperation, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { coreHostMembers } from '../targets/cpp/host/host-members.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const target: Representation = {
  kind: 'record',
  shapeId: 'target',
  fields: [{ key: 'total', value: number, required: true }],
  accessors: [],
  ownership: 'shared-refcount'
}
const descriptor: Representation = {
  kind: 'record',
  shapeId: 'descriptor',
  fields: [{ key: 'value', value: number, required: true }],
  accessors: [],
  ownership: 'owned'
}
const deriver = {} as RepresentationDeriver
const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const args = [
  { value: 'target' as never, representation: target },
  { value: 'key' as never, representation: { kind: 'string' } as Representation },
  { value: 'descriptor' as never, representation: descriptor }
]
const semantic = {
  family: 'invocation',
  intrinsicMutation: 'object-define-property',
  intrinsicDataDefinition: true,
  operands: [{ role: 'argument', ordinal: 1, source: { kind: 'constant', literal: 'string', text: 'total' } }]
} as unknown as SemanticOperation
const key = { kind: 'constant', literal: 'string', text: 'total' } as unknown as IrOperation
const recipe = fixedDataDefinitionRecipeOf(args, 'total', target, deriver, new Map(), conversions, true)!
const operation = { kind: 'call', arguments: args, fixedDataDefinition: recipe, result: null } as unknown as CallOperation

test('an ignored defineProperty result authenticates the actual target, key, descriptor and field conversion', () => {
  assert.ok(recipe)
  const matches = (call: CallOperation, source: SemanticOperation | null = semantic, actual: IrOperation | null = key) =>
    fixedDataDefinitionCallMatches(call, source, deriver, new Map(), conversions, () => actual)
  assert.equal(matches(operation), true)
  assert.equal(matches({ ...operation, result: { id: 'returned' as never, representation: target } }), true)
  assert.equal(matches({ ...operation, result: { id: 'returned' as never, representation: number } }), false)
  assert.equal(matches({ ...operation, arguments: [args[0]!, args[1]!] }), false)
  assert.equal(matches({ ...operation, argumentsAreSpread: true }), false)
  assert.equal(matches(operation, null), false)
  assert.equal(matches(operation, { ...semantic, intrinsicDataDefinition: false } as unknown as SemanticOperation), false)
  assert.equal(matches(operation, semantic, { ...key, text: 'other' } as IrOperation), false)
  assert.equal(matches(operation, semantic, null), false)
  assert.equal(matches({ ...operation, fixedDataDefinition: { ...recipe, field: { ...recipe.field, key: 'other' } } }), false)
  assert.equal(matches({ ...operation, fixedDataDefinition: { ...recipe, held: { kind: 'string' } } }), false)
})

test('closed Script native class definitions remain certified after joins and when their return values are discarded', () => {
  // Match run-emitted.mjs's explicit realm boundary; the fixture's top-level
  // aliases are not closed bindings in an open classic Script.
  const result = compile({
    rootFileNames: [resolve('test/runtime/class-arrow-field-lazy.ts')],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  const definitions = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation): operation is CallOperation => operation.kind === 'call' && operation.fixedDataDefinition !== undefined)
  assert.ok(definitions.length > 0)
  assert.ok(
    definitions.some((definition) => definition.result === null && definition.fixedDataDefinition?.nativeFieldProtocol === 'unused')
  )
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
  assert.ok(operations.some((operation) => operation.kind === 'set' && operation.nativeCallableDataWrite))
  assert.ok(operations.some((operation) => operation.kind === 'get' && operation.nativeCallableDataSlot?.optionalRead))
  assert.doesNotMatch(result.source!, /a static callable expando read/, 'the typed tag read must not observe and decode a boxed holder')
})

test('attribute-only fixed definitions publish exact native presence and storage recipes without reading their current values', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/native-field-descriptor.ts')],
    projectFileName: null,
    closedScriptScope: true,
    dynamicFallback: false,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const input: NativeDataDefinitionInput = {
    graph: result.graph,
    bodies: new Map((result.irBodies ?? []).map((body) => [body.owner, body])),
    deriver: result.representations.deriver,
    classes: result.projection.classes,
    conversions: result.conversionCensus,
    calleeRendering: {
      hostMembers: coreHostMembers,
      graph: result.graph,
      plan: result.representations.plan,
      deriver: result.representations.deriver,
      classes: result.projection.classes,
      placements: result.projection.placements,
      hostMethodAliasDeclarations: new Set()
    }
  }
  const expected = fixedDataDefinitionAttributesOf(input)
  assert.equal(expected.size, 5)
  const operations = [...input.bodies.values()].flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map(
    operations.flatMap((operation) => {
      const value = resultOfIrOperation(operation)
      return value === null ? [] : [[value.id, operation] as const]
    })
  )
  for (const [operation, recipe] of expected) {
    assert.equal(operation.result, null, 'discarding the return must retain the attribute effect and its receipt')
    assert.equal(recipe.value, null)
    assert.equal(recipe.conversion, null)
    assert.ok(recipe.attributesOnly)
    assert.ok(recipe.attributesOnly.initialized !== null || recipe.attributesOnly.absence !== null)
    const semantic = result.graph.operations.get(result.graph.results.get(operation.lineage)!) ?? null
    const matches = (changed: CallOperation) =>
      fixedDataDefinitionCallMatches(
        changed,
        semantic,
        input.deriver,
        input.classes,
        input.conversions,
        (value) => definitions.get(value) ?? null,
        recipe
      )
    assert.equal(matches(operation), true)
    for (const forged of [
      { ...recipe, value: { key: 'value', value: number, required: true }, conversion: conversions.nodeFor(number, number).id },
      { ...recipe, field: { ...recipe.field, key: 'foreign' } },
      { ...recipe, attributes: [] },
      { ...recipe, attributesOnly: { ...recipe.attributesOnly, allocation: 'foreign-allocation' as never } },
      { ...recipe, attributesOnly: { ...recipe.attributesOnly, initialized: 'foreign-owner' as never } },
      { ...recipe, attributesOnly: { ...recipe.attributesOnly, absence: 'foreign-absence' as never } }
    ])
      assert.equal(matches({ ...operation, fixedDataDefinition: forged }), false)
    assert.equal(matches({ ...operation, arguments: [operation.arguments[2]!, operation.arguments[1]!, operation.arguments[0]!] }), false)
  }
  assert.ok(result.source!.includes('gea::applyNativeFieldDescriptor<double, gea::NativeFieldLeafPolicy>'))
  assert.doesNotMatch(result.source!, /gea_current = gea::PropertyDescriptor::assignment\(gea::Value::box/)
  const alteredGraph = {
    ...input.graph,
    operations: new Map(
      [...input.graph.operations].map(([id, operation]) => {
        if (operation.family !== 'invocation') return [id, operation]
        const { descriptorOwnProtocol: _proof, ...unproved } = operation
        return [id, unproved as SemanticOperation]
      })
    )
  }
  assert.equal(
    fixedDataDefinitionAttributesOf({ ...input, graph: alteredGraph }).size,
    0,
    'a public descriptor layout cannot replace its independently sealed own-field and omitted-prototype proof'
  )
})

test('attribute-only presence cannot be borrowed from an annotation, prior deletion or opaque receiver publication', () => {
  const entry = resolve('test/runtime/native-field-descriptor.ts')
  for (const change of [
    'delete (owner as any).amount',
    'publish(owner)',
    'publishNative(owner)',
    'Object.defineProperty(owner, "amount", { get() { return 1 } })'
  ]) {
    const result = compile({
      rootFileNames: [entry],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      includeIr: true,
      sourceOverlay: new Map([
        [
          entry,
          `export {}\ndeclare function publish(value: unknown): void
        declare function publishNative(value: Owner): void
        class Owner { amount = 1 }
        const owner = new Owner()
        ${change}
        Object.defineProperty(owner, 'amount', { writable: false })`
        ]
      ])
    })
    const attributes = (result.irBodies ?? [])
      .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
      .filter((operation) => operation.kind === 'call' && operation.fixedDataDefinition?.attributesOnly !== undefined)
    assert.equal(attributes.length, 0, change)
    assert.equal(result.source, null, change)
  }
})
