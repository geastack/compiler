import { coreHostMembers } from '../targets/cpp/host/host-members.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'
import { declarationId, functionId, type IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import { abiKey, passingOf, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { allOperationsOf, type CallOperation, type IrNonTerminatorOperation, type IrOperand } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { descriptorOwnProtocolMatches } from './descriptor-own-protocol.js'
import {
  nativeAccessorHalfOf,
  nativeAccessorDefinitionOf,
  nativeAccessorDefinitionMatches,
  nativeAccessorObservationOf,
  nativeAccessorObservationMatches,
  nativeAccessorReinstallationOf,
  nativeAccessorReinstallationMatches,
  type NativeAccessorDefinitionInput
} from './native-accessor-definition.js'

const callable = functionId(declarationId('native-accessor', 0))
const receiver: Representation = {
  kind: 'class-ref',
  declaration: declarationId('native-accessor', 1),
  shapeId: 'native-accessor-owner',
  ownership: 'shared-refcount',
  ancestors: []
}
const number: Representation = { kind: 'scalar', domain: 'number' }
const array: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const sourceValue = (abi: CallableAbi): IrOperand => ({
  value: 'accessor-source' as IrValueId,
  representation: { kind: 'function-value-dispatch', abi }
})
const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const inputOf = (abi: CallableAbi) => ({ abis: new Map([[callable, abi]]), conversions })

test('native accessor invocation recipes keep this and an array result on a distinct native frame', () => {
  const abi: CallableAbi = { receiver, parameters: [], restFrom: null, result: array }
  const value = sourceValue(abi)
  const half = nativeAccessorHalfOf('get', value, callable, inputOf(abi))
  assert.ok(half)
  assert.equal(half.value, value.value)
  assert.equal(representationKey(half.source), representationKey(value.representation))
  assert.equal(representationKey(half.read!), representationKey(array))
  assert.equal(abiOfCallee(half.call)?.receiver, null)
  assert.equal(half.callable, callable)
  const node = conversions.nodeById(half.conversion)!
  assert.equal(representationKey(node.target), representationKey(half.call))
  assert.ok([...recipeClosureOf([node], conversions.nodeById).values()].every((child) => child.target.kind !== 'dynamic'))
})

test('native setter frames consume the actual typed input and discard only the body result', () => {
  const abi: CallableAbi = {
    receiver,
    parameters: [{ value: array, ownership: 'shared-refcount', passing: passingOf(array) }],
    restFrom: null,
    result: number
  }
  const half = nativeAccessorHalfOf('set', sourceValue(abi), callable, inputOf(abi))
  assert.ok(half)
  const target = abiOfCallee(half.call)!
  assert.equal(target.parameters.length, 1)
  assert.equal(representationKey(target.parameters[0]!.value), representationKey(array))
  assert.equal(target.result.kind, 'void')
  assert.equal(half.read, null)
  assert.equal(representationKey(half.write!), representationKey(array))
})

test('a void getter performs its call but publishes a native undefined read', () => {
  const abi: CallableAbi = { receiver, parameters: [], restFrom: null, result: { kind: 'void' } }
  const half = nativeAccessorHalfOf('get', sourceValue(abi), callable, inputOf(abi))
  assert.ok(half)
  assert.equal(abiOfCallee(half.call)?.result.kind, 'void')
  assert.equal(half.read?.kind, 'undefined')
})

test('accessor frame selection requires a published Function and its exact physical ABI', () => {
  const abi: CallableAbi = { receiver, parameters: [], restFrom: null, result: array }
  assert.equal(nativeAccessorHalfOf('get', sourceValue(abi), functionId(declarationId('native-accessor', 2)), inputOf(abi)), null)
  const other: CallableAbi = { ...abi, result: number }
  assert.equal(nativeAccessorHalfOf('get', sourceValue(abi), callable, inputOf(other)), null)
  assert.notEqual(abiKey(abi), abiKey(other))
})

test('a descriptor method installs its exact native Function on a genuine declared-any owner', () => {
  const entry = resolve('test/runtime/dynamic-nested-field-load-keeps-native-live-aliases.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const definitions = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter((operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined)
  assert.equal(definitions.length, 1, JSON.stringify(result.refusals))
  const definition = definitions[0]!
  assert.equal(definition.arguments[0]?.representation.kind, 'dynamic')
  assert.equal(definition.nativeAccessorDefinition!.halves.length, 1)
  const half = definition.nativeAccessorDefinition!.halves[0]!
  assert.equal(half.half, 'get')
  assert.equal(abiKey(abiOfCallee(half.source)!), abiKey(result.projection.abis.get(half.callable)!))
  assert.equal(
    definition.objectValueConversions?.some((conversion) => conversion.field === 'get'),
    false
  )
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
})

const entry = resolve('test/runtime/native-accessor-descriptor-functions.runtime.ts')
const original = readFileSync(entry, 'utf8')
const compileSource = (source = original) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })
const receiptContext = (result: CompilationResult) => {
  const bodies = new Map((result.irBodies ?? []).map((body) => [body.owner, body]))
  const operations = [...bodies.values()].flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const definitions = new Map(
    operations.flatMap((operation) => {
      const result = resultOfIrOperation(operation)
      return result ? [[result.id, operation] as const] : []
    })
  )
  const input: NativeAccessorDefinitionInput = {
    graph: result.graph,
    bodies,
    abis: result.projection.abis,
    conversions: result.conversionCensus,
    calleeRendering: {
      hostMembers: coreHostMembers,
      graph: result.graph,
      plan: result.representations.plan,
      deriver: result.representations.deriver,
      placements: result.projection.placements,
      classes: result.projection.classes,
      hostMethodAliasDeclarations: new Set()
    }
  }
  const semanticOf = (operation: CallOperation) => result.graph.operations.get(result.graph.results.get(operation.lineage)!) ?? null
  return { input, operations, definitionOf: (value: IrValueId) => definitions.get(value) ?? null, semanticOf }
}

test('native accessor installation and descriptor reflection retain the original Function identity', () => {
  const result = compileSource()
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const context = receiptContext(result)
  const query = context.operations.find(
    (operation): operation is CallOperation =>
      operation.kind === 'call' &&
      context.semanticOf(operation)?.family === 'invocation' &&
      operation.intrinsicReflection === 'getOwnPropertyDescriptor'
  )
  assert.ok(query?.result)
  const reflected = query.result.representation.kind === 'optional' ? query.result.representation.payload : query.result.representation
  const fields =
    reflected.kind === 'record'
      ? reflected.fields
      : reflected.kind === 'native-record-ref'
        ? recordFieldsOfShape(result.representations.deriver, reflected.shapeId)
        : null
  assert.ok(fields)
  assert.equal(
    fields.some((field) => field.key === 'get'),
    true,
    'the final reflected carrier must retain the getter Function'
  )
  assert.equal(
    fields.some((field) => field.key === 'set'),
    true,
    'the final reflected carrier must retain the setter Function'
  )
  assert.notEqual(
    result.source,
    null,
    JSON.stringify({ lowering: result.loweringBlockers, refusals: result.refusals, emission: result.emissionRefusals })
  )
  const definitions = context.operations.filter(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined
  )
  const observations = context.operations.filter(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorObservation !== undefined
  )
  const restored = context.operations.filter(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorReinstallation !== undefined
  )
  assert.equal(definitions.length, 1)
  assert.equal(observations.length, 1)
  assert.equal(restored.length, 1)
  const definition = definitions[0]!
  const observation = observations[0]!
  assert.equal(
    nativeAccessorDefinitionMatches(
      nativeAccessorDefinitionOf(definition, context.semanticOf(definition), context.input, context.definitionOf),
      definition.nativeAccessorDefinition!
    ),
    true
  )
  assert.equal(
    nativeAccessorObservationMatches(
      nativeAccessorObservationOf(observation, context.semanticOf(observation), context.input, context.definitionOf),
      observation.nativeAccessorObservation!
    ),
    true
  )
  assert.equal(observation.nativeAccessorObservation!.definition, definition.lineage)
  assert.equal(
    nativeAccessorReinstallationMatches(
      nativeAccessorReinstallationOf(restored[0]!, context.semanticOf(restored[0]!), context.input, context.definitionOf),
      restored[0]!.nativeAccessorReinstallation!
    ),
    true
  )
  assert.match(result.source!, /installNativeDescriptorGetter/)
  assert.match(result.source!, /installNativeDescriptorSetter/)
  assert.match(result.source!, /nativeGet\.function\.template get</)
  assert.match(result.source!, /__gea_descriptor_snapshot = gea::nativeOwnPropertyDescriptor/)
  assert.equal(
    definition.objectValueConversions?.some((conversion) => conversion.field === 'get' || conversion.field === 'set'),
    false
  )
})

test('native accessor receipts reject changed owner, key, source Function and observation citations', () => {
  const result = compileSource()
  const context = receiptContext(result)
  const definition = context.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined
  )
  const observation = context.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorObservation !== undefined
  )
  assert.ok(definition)
  assert.ok(observation)
  const recipe = definition.nativeAccessorDefinition!
  const reflection = observation.nativeAccessorObservation!
  assert.equal(nativeAccessorDefinitionMatches(recipe, { ...recipe, receiver: 'unrelated-owner' as IrValueId }), false)
  assert.equal(nativeAccessorDefinitionMatches(recipe, { ...recipe, keyText: 'other' }), false)
  assert.equal(
    nativeAccessorDefinitionMatches(recipe, {
      ...recipe,
      halves: recipe.halves.map((half) => ({ ...half, callable: functionId(declarationId('other', 0)) }))
    }),
    false
  )
  assert.equal(nativeAccessorObservationMatches(reflection, { ...reflection, definition: 'unrelated-definition' as never }), false)
  assert.equal(
    nativeAccessorObservationMatches(reflection, {
      ...reflection,
      halves: reflection.halves.map((half) => ({ ...half, conversion: conversions.nodeFor(number, number).id }))
    }),
    false
  )
  assert.equal(
    nativeAccessorObservationOf(
      {
        ...observation,
        arguments: observation.arguments.map((argument, index) =>
          index === 0 ? { ...argument, value: 'unrelated-owner' as IrValueId } : argument
        )
      },
      context.semanticOf(observation),
      context.input,
      context.definitionOf
    ),
    null
  )
})

test('literal accessor receipt authenticates every sibling initializer on its actual allocation SSA', () => {
  const result = compileSource()
  const context = receiptContext(result)
  const definition = context.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined
  )
  assert.ok(definition)
  const last = context.definitionOf(definition.arguments[2]!.value)
  assert.equal(last?.kind, 'define-own-property')
  assert.ok(last?.kind === 'define-own-property')
  const descriptor = definition.arguments[2]!.representation
  assert.ok(descriptor.kind === 'record')
  const rederive = (replacement: IrNonTerminatorOperation) => {
    const bodies = new Map(
      [...context.input.bodies].map(([id, body]) => [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([blockId, block]) => [
              blockId,
              {
                ...block,
                operations: block.operations.map((operation) => (operation === last ? replacement : operation))
              }
            ])
          )
        }
      ])
    )
    return nativeAccessorDefinitionOf(definition, context.semanticOf(definition), { ...context.input, bodies }, (value) =>
      value === last.result!.id ? replacement : context.definitionOf(value)
    )
  }
  assert.equal(rederive({ ...last, receiver: { ...last.receiver, value: 'unrelated-initializer-receiver' as IrValueId } }), null)
  assert.equal(rederive({ ...last, receiver: { ...last.receiver, value: definition.arguments[0]!.value } }), null)
  assert.equal(rederive({ ...last, attributes: { ...last.attributes, enumerable: false } }), null)
})

test('native descriptor fields cannot borrow missing or unrelated inherited-field evidence', () => {
  const result = compileSource()
  const context = receiptContext(result)
  const definition = context.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined
  )
  assert.ok(definition)
  const semantic = context.semanticOf(definition)
  assert.ok(semantic?.family === 'invocation' && semantic.descriptorOwnProtocol)
  const names = ['get', 'set', 'configurable']
  assert.equal(descriptorOwnProtocolMatches(definition, semantic, result.graph, context.definitionOf, names), true)
  assert.equal(descriptorOwnProtocolMatches(definition, semantic, result.graph, context.definitionOf, [...names, 'value']), false)
  const { descriptorOwnProtocol: _protocol, ...without } = semantic
  const graphWithout = { ...result.graph, operations: new Map(result.graph.operations).set(semantic.id, without) }
  assert.equal(descriptorOwnProtocolMatches(definition, without, graphWithout, context.definitionOf, names), false)
  const unrelated = {
    ...semantic,
    descriptorOwnProtocol: { ...semantic.descriptorOwnProtocol, descriptor: 'unrelated-descriptor' as never }
  }
  const unrelatedGraph = { ...result.graph, operations: new Map(result.graph.operations).set(semantic.id, unrelated) }
  assert.equal(descriptorOwnProtocolMatches(definition, unrelated, unrelatedGraph, context.definitionOf, names), false)
})

test('an additional descriptor writer or intervening unknown effect cannot borrow the original installation', () => {
  const replaced = compileSource(
    original.replace(
      "Object.defineProperty(owner, 'entry', { get: getter, set: setter, configurable: true })",
      "const halves = { get: getter, set: setter, configurable: true }; halves.get = function (): any { return 19 }; Object.defineProperty(owner, 'entry', halves)"
    )
  )
  assert.equal(
    receiptContext(replaced).operations.some((operation) => operation.kind === 'call' && operation.nativeAccessorDefinition !== undefined),
    false
  )
  const exposed = compileSource(
    original.replace(
      'const descriptor = Object.getOwnPropertyDescriptor',
      'declare function escape(value: object): void; escape(owner); const descriptor = Object.getOwnPropertyDescriptor'
    )
  )
  assert.equal(
    receiptContext(exposed).operations.some((operation) => operation.kind === 'call' && operation.nativeAccessorObservation !== undefined),
    false
  )
})

test('reinstallation refuses changed descriptor fields and unrelated snapshot source citations', () => {
  const result = compileSource()
  const context = receiptContext(result)
  const restored = context.operations.find(
    (operation): operation is CallOperation => operation.kind === 'call' && operation.nativeAccessorReinstallation !== undefined
  )
  assert.ok(restored)
  const receipt = restored.nativeAccessorReinstallation!
  assert.equal(
    nativeAccessorReinstallationMatches(receipt, { ...receipt, snapshotKey: { ...receipt.snapshotKey, value: 'other-key' as IrValueId } }),
    false
  )
  assert.equal(
    nativeAccessorReinstallationMatches(receipt, {
      ...receipt,
      snapshotReceiver: { ...receipt.snapshotReceiver, value: 'other-owner' as IrValueId }
    }),
    false
  )
  const changed = compileSource(
    original.replace(
      "Object.defineProperty(restored, 'copy', descriptor)",
      "descriptor.configurable = false; Object.defineProperty(restored, 'copy', descriptor)"
    )
  )
  assert.equal(
    receiptContext(changed).operations.some(
      (operation) => operation.kind === 'call' && operation.nativeAccessorReinstallation !== undefined
    ),
    false
  )
})
