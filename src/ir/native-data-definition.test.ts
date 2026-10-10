import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { representationKey } from '../representation/model.js'
import { allOperationsOf, type CallOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { nativeDataDefinitionOf, nativeDataDefinitionMatches, type NativeDataDefinitionInput } from './native-data-definition.js'
import { coreHostMembers } from '../targets/cpp/host/host-members.js'

const result = compile({
  rootFileNames: [resolve('test/runtime/define-property-on-class-constructor-read-through-this-constructor.runtime.ts')],
  projectFileName: resolve('test/runtime/tsconfig.json'),
  closedScriptScope: true,
  includeIr: true
})
const bodies = new Map((result.irBodies ?? []).map((body) => [body.owner, body]))
const calls = [...bodies.values()]
  .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
  .filter((operation): operation is CallOperation => operation.kind === 'call' && operation.nativeDataDefinition !== undefined)
const input: NativeDataDefinitionInput = {
  graph: result.graph,
  bodies,
  deriver: result.representations.deriver,
  classes: result.projection.classes,
  conversions: result.conversionCensus,
  calleeRendering: {
    hostMembers: coreHostMembers,
    graph: result.graph,
    plan: result.representations.plan,
    deriver: result.representations.deriver,
    placements: result.projection.placements,
    hostMethodAliasDeclarations: new Set(),
    classes: result.projection.classes
  }
}
const rederive = (operation: CallOperation) => {
  const body = [...bodies.values()].find((body) => [...body.blocks.values()].some((block) => block.operations.includes(calls[0]!)))!
  const definitions = new Map(
    [...body.blocks.values()]
      .flatMap((block) => [...allOperationsOf(block)])
      .flatMap((operation) => {
        const value = resultOfIrOperation(operation)
        return value === null ? [] : [[value.id, operation] as const]
      })
  )
  const semantic = result.graph.operations.get(result.graph.results.get(operation.lineage)!) ?? null
  return nativeDataDefinitionOf(operation, semantic, input, (value) => definitions.get(value) ?? null)
}

test('a native constructor descriptor stores Set<symbol> in its actual optional native field carrier', () => {
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.equal(calls.length, 1)
  const operation = calls[0]!
  const recipe = operation.nativeDataDefinition!
  assert.equal(nativeDataDefinitionMatches(rederive(operation), recipe), true)
  assert.equal(recipe.held.kind, 'optional')
  const node = result.conversionCensus.nodeById(recipe.conversion)
  assert.equal(representationKey(node!.source), representationKey(recipe.source))
  assert.equal(representationKey(node!.target), representationKey(recipe.held))
  assert.ok(recipe.destinations.length > 1, 'every actual union destination must state the same physical field carrier')
  assert.ok(!operation.objectValueConversions?.some((value) => value.role === 'descriptor-value' && value.field === 'value'))
  assert.match(result.source!, /__gea_descriptor\.nativeValue = gea::NativeDescriptorData::make/)
  assert.doesNotMatch(result.source!, /__gea_descriptor\.value = gea::Value::box/)
})

test('native descriptor receipts reject changed argument identities, fields and conversion citations', () => {
  assert.equal(calls.length, 1)
  const operation = calls[0]!
  const recipe = operation.nativeDataDefinition!
  assert.equal(
    nativeDataDefinitionMatches(
      rederive({
        ...operation,
        arguments: operation.arguments.map((value, index) => (index === 0 ? { ...value, value: 'substituted-owner' as never } : value))
      }),
      recipe
    ),
    false
  )
  assert.equal(
    nativeDataDefinitionMatches(
      rederive({
        ...operation,
        arguments: operation.arguments.map((value, index) => (index === 2 ? { ...value, value: 'substituted-descriptor' as never } : value))
      }),
      recipe
    ),
    false
  )
  assert.equal(nativeDataDefinitionMatches(rederive(operation), { ...recipe, destinations: recipe.destinations.slice(1) }), false)
  assert.equal(nativeDataDefinitionMatches(rederive(operation), { ...recipe, held: { kind: 'string' } }), false)
  const wrong = result.conversionCensus.nodeFor({ kind: 'string' }, { kind: 'string' })
  assert.equal(nativeDataDefinitionMatches(rederive(operation), { ...recipe, conversion: wrong.id }), false)
  assert.equal(rederive({ ...operation, argumentsAreSpread: true }), null)
})

test('a data definition through nested structural views delegates to the original native descriptor', () => {
  const compiled = compile({
    rootFileNames: [resolve('test/runtime/typed-shared-view-preserves-data-definitions.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.refusals))
  const definitions = (compiled.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation): operation is CallOperation => operation.kind === 'call' && operation.nativeDataDefinition !== undefined)
  assert.equal(definitions.length, 1)
  const definition = definitions[0]!
  assert.equal(definition.fixedDataDefinition, undefined)
  assert.equal(definition.nativeDataDefinition!.delegatesView, true)
  assert.ok(definition.nativeDataDefinition!.destinations.length >= 2)
  assert.ok(!definition.objectValueConversions?.some((value) => value.role === 'descriptor-value' && value.field === 'value'))
  assert.match(compiled.source!, /gea::record::defineLiveField/)
  assert.match(compiled.source!, /gea::record::defineFieldView/)
})
