import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import {
  nativePropertyPresenceAuthorityOf,
  nativePropertyPresenceStorageCandidatesOf,
  nativePropertyPrototypeAbsenceMatches
} from './native-property-presence.js'
import type { HasPropertyOperation, GetOperation, SetOperation, IrBlock, IrBlockId, IrBody, IrNonTerminatorOperation } from './model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { resultOfIrOperation } from './queries.js'
import { nativeMergeTransportOf } from './native-merge-transport.js'
import { nativeArrayViewIdentityTransportOf } from '../conversion/array-view.js'

const source: Representation = {
  kind: 'record',
  shapeId: 'ordinary-source',
  ownership: 'shared-refcount',
  fields: [{ key: '$type', value: { kind: 'string' }, required: true }],
  accessors: []
}
const text: Representation = { kind: 'string' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const receiver = { value: 'receiver' as IrValueId, representation: source }
const key = { value: 'key' as IrValueId, representation: text }
const has: HasPropertyOperation = {
  kind: 'has-property',
  lineage: 'source-has' as never,
  receiver,
  key,
  ordinaryObjectPrototypeKeyAbsent: true,
  result: { id: 'has' as never, representation: boolean }
}
const read: GetOperation = {
  kind: 'get',
  lineage: 'source-read' as never,
  receiver,
  key,
  result: { id: 'answer' as never, representation: text }
}
const keyDefinition: IrNonTerminatorOperation = {
  kind: 'constant',
  lineage: 'source-key' as never,
  literal: 'string',
  text: '$type',
  result: { id: key.value, representation: text }
}
const receiverDefinition: IrNonTerminatorOperation = {
  kind: 'parameter',
  lineage: 'source-receiver' as never,
  ordinal: 0,
  result: { id: receiver.value, representation: source }
}
const conversions = { nodeById: () => null }
const semantic: SemanticOperation = {
  id: 'source-has-operation' as never,
  caller: { kind: 'function', functionId: 'source-body' as never },
  family: 'computation',
  form: 'in',
  operator: 'in',
  ordinaryObjectPrototypeKeyAbsent: true,
  operands: [
    {
      role: 'left',
      ordinal: 0,
      type: 'string' as never,
      source: { kind: 'constant', literal: 'string', text: '$type' },
      evaluation: { kind: 'runtime' }
    },
    {
      role: 'right',
      ordinal: 0,
      type: 'source-record' as never,
      source: { kind: 'result', result: receiverDefinition.lineage },
      evaluation: { kind: 'runtime' }
    }
  ],
  results: [{ role: 'value', id: has.lineage, type: 'boolean' as never }],
  completion: normalCompletion,
  effects: pureEffects,
  evaluationOrdinal: 0
}

test('prototype absence cites the exact source HasProperty key and receiver', () => {
  const definitions = new Map([receiverDefinition, keyDefinition].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  assert.equal(nativePropertyPrototypeAbsenceMatches(has, semantic, definitionOf, conversions), true)
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      { ...has, receiver: { ...receiver, value: 'other' as never } },
      semantic,
      definitionOf,
      conversions
    ),
    false
  )
  assert.equal(
    nativePropertyPrototypeAbsenceMatches({ ...has, key: { ...key, value: receiver.value } }, semantic, definitionOf, conversions),
    false
  )
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      has,
      { ...semantic, ordinaryObjectPrototypeKeyAbsent: undefined } as unknown as SemanticOperation,
      definitionOf,
      conversions
    ),
    false
  )
})

test('prototype absence follows only a certified identity-preserving live union arm', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const union: Representation = {
    kind: 'tagged-union',
    arms: [source, { kind: 'undefined' } as Representation].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const original = { ...receiverDefinition, result: { id: receiver.value, representation: union } }
  const nativeTransport = nativeMergeTransportOf(union, source, [0], false, census)
  assert.ok(nativeTransport)
  const rebuild: IrNonTerminatorOperation = {
    kind: 'merge-live-arm-rebuild',
    lineage: 'source-narrowing' as never,
    source: { value: receiver.value, representation: union },
    result: { id: 'narrowed' as never, representation: source },
    liveArms: [0],
    sourceAbsenceLive: false,
    nativeTransport
  }
  const narrowed = { ...has, receiver: { value: rebuild.result.id, representation: source } }
  const definitions = new Map([original, keyDefinition, rebuild].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  assert.equal(nativePropertyPrototypeAbsenceMatches(narrowed, semantic, definitionOf, census), true)
  const { nativeTransport: omitted, ...unproved } = rebuild
  definitions.set(rebuild.result.id, unproved)
  assert.equal(nativePropertyPrototypeAbsenceMatches(narrowed, semantic, definitionOf, census), false)
  definitions.set(rebuild.result.id, { ...rebuild, liveArms: [1] })
  assert.equal(nativePropertyPrototypeAbsenceMatches(narrowed, semantic, definitionOf, census), false)
  definitions.set(rebuild.result.id, { ...rebuild, source: { ...rebuild.source, value: 'unrelated' as never } })
  assert.equal(nativePropertyPrototypeAbsenceMatches(narrowed, semantic, definitionOf, census), false)
})

test('a destructured read authenticates its exact key and initialized source alias', () => {
  const binding: SemanticOperation = {
    ...semantic,
    id: 'source-default-binding-operation' as never,
    family: 'binding',
    action: 'initialize',
    declaration: 'source-default-binding' as never,
    mutable: true,
    temporalDeadZone: false,
    operands: [{ ...semantic.operands[1]!, role: 'initializer' }],
    results: [{ role: 'value', id: 'source-default-binding-result' as never, type: 'source-record' as never }]
  }
  const pattern: SemanticOperation = {
    ...semantic,
    id: 'source-pattern-operation' as never,
    family: 'destructuring',
    form: 'object-pattern',
    operands: [
      { ...semantic.operands[0]!, role: 'key' },
      { ...semantic.operands[1]!, role: 'base', source: { kind: 'result', result: binding.results[0]!.id } }
    ],
    results: [{ role: 'value', id: read.lineage, type: 'string' as never }]
  }
  const definitions = new Map([receiverDefinition, keyDefinition].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  const semanticOf = (id: typeof read.lineage) => (id === binding.results[0]!.id ? binding : null)
  const absentRead: GetOperation = { ...read, ordinaryObjectPrototypeKeyAbsent: true }
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, pattern, definitionOf, conversions, semanticOf), true)
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, pattern, definitionOf, conversions), false)
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      { ...absentRead, receiver: { ...receiver, value: 'other' as never } },
      pattern,
      definitionOf,
      conversions,
      semanticOf
    ),
    false
  )
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      { ...absentRead, key: { ...key, value: receiver.value } },
      pattern,
      definitionOf,
      conversions,
      semanticOf
    ),
    false
  )
  const { ordinaryObjectPrototypeKeyAbsent: proof, ...unprovedPattern } = pattern
  assert.equal(proof, true)
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, unprovedPattern, definitionOf, conversions, semanticOf), false)
})

test('an ordinary property read authenticates its own key and receiver rather than borrowing a pattern proof', () => {
  const property: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    operands: [
      { ...semantic.operands[0]!, role: 'key' },
      { ...semantic.operands[1]!, role: 'receiver' }
    ],
    results: [{ role: 'value', id: read.lineage, type: 'string' as never }]
  }
  const definitions = new Map([receiverDefinition, keyDefinition].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  const absentRead: GetOperation = { ...read, ordinaryObjectPrototypeKeyAbsent: true }
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, conversions), true)
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      { ...absentRead, receiver: { ...receiver, value: 'other' as never } },
      property,
      definitionOf,
      conversions
    ),
    false
  )
  assert.equal(
    nativePropertyPrototypeAbsenceMatches({ ...absentRead, key: { ...key, value: receiver.value } }, property, definitionOf, conversions),
    false
  )
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, { ...property, internalMethod: 'set' }, definitionOf, conversions), false)
  const { ordinaryObjectPrototypeKeyAbsent: proof, ...unprovedProperty } = property
  assert.equal(proof, true)
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, unprovedProperty, definitionOf, conversions), false)
})

test('an optional receiver aliases its evaluated Get only with the exact always-present source result', () => {
  const short = 'receiver-short-circuit' as typeof read.lineage
  const original: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    shortCircuitAlwaysPresent: true,
    results: [
      { role: 'value', id: receiverDefinition.lineage, type: 'source-record' as never },
      { role: 'short-circuit', id: short, type: 'source-record' as never }
    ]
  }
  const property: SemanticOperation = {
    ...original,
    id: 'source-optional-receiver-read' as never,
    operands: [
      { ...semantic.operands[0]!, role: 'key' },
      { ...semantic.operands[1]!, role: 'receiver', source: { kind: 'result', result: short } }
    ],
    results: [{ role: 'value', id: read.lineage, type: 'string' as never }]
  }
  const held: GetOperation = { ...read, lineage: receiverDefinition.lineage, result: receiverDefinition.result }
  const definitions = new Map([held, keyDefinition].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  const semanticOf = (operation: SemanticOperation) => (id: typeof short) => (id === short ? operation : null)
  const absentRead: GetOperation = { ...read, ordinaryObjectPrototypeKeyAbsent: true }
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, conversions, semanticOf(original)), true)
  const { shortCircuitAlwaysPresent: proof, ...unproved } = original
  assert.equal(proof, true)
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, conversions, semanticOf(unproved)), false)
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(
      absentRead,
      property,
      definitionOf,
      conversions,
      semanticOf({ ...original, results: original.results.filter((result) => result.role !== 'value') })
    ),
    false
  )
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, conversions), false)
})

test('inline literal receivers authenticate their source spelling and physical carrier', () => {
  const literal: IrNonTerminatorOperation = {
    kind: 'constant',
    lineage: 'inline-space' as never,
    literal: 'string',
    text: ' ',
    result: { id: receiver.value, representation: text }
  }
  const property: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    operands: [
      { ...semantic.operands[0]!, role: 'key' },
      { ...semantic.operands[1]!, role: 'receiver', source: { kind: 'constant', literal: 'string', text: ' ' } }
    ],
    results: [{ role: 'value', id: read.lineage, type: 'string' as never }]
  }
  const absentRead: GetOperation = {
    ...read,
    receiver: { value: receiver.value, representation: text },
    ordinaryObjectPrototypeKeyAbsent: true
  }
  const check = (definition: IrNonTerminatorOperation, operation = absentRead, sourceOperation = property) =>
    nativePropertyPrototypeAbsenceMatches(
      operation,
      sourceOperation,
      (id) => (id === key.value ? keyDefinition : id === receiver.value ? definition : null),
      conversions
    )
  assert.equal(check(literal), true)
  assert.equal(check({ ...literal, text: 'x' }), false)
  assert.equal(check({ ...literal, literal: 'number' }), false)
  assert.equal(check({ ...literal, result: { ...literal.result, id: 'another-literal' as never } }), false)
  assert.equal(check(literal, { ...absentRead, receiver }), false)
  assert.equal(
    check(literal, absentRead, {
      ...property,
      operands: property.operands.map((operand) =>
        operand.role === 'receiver' ? { ...operand, source: { kind: 'constant', literal: 'string', text: 'x' } } : operand
      )
    }),
    false
  )
})

test('formal and implicit receiver operands cite their actual physical frame', () => {
  const property: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    operands: [
      { ...semantic.operands[0]!, role: 'key' },
      { ...semantic.operands[1]!, role: 'receiver', source: { kind: 'parameter', ordinal: 0 } }
    ],
    results: [{ role: 'value', id: read.lineage, type: 'string' as never }]
  }
  const absentRead: GetOperation = { ...read, ordinaryObjectPrototypeKeyAbsent: true }
  const check = (definition: IrNonTerminatorOperation, sourceOperation = property) =>
    nativePropertyPrototypeAbsenceMatches(
      absentRead,
      sourceOperation,
      (id) => (id === key.value ? keyDefinition : id === receiver.value ? definition : null),
      conversions
    )
  assert.equal(check(receiverDefinition), true)
  assert.equal(check({ ...receiverDefinition, ordinal: 1 }), false)
  const implicit = {
    ...property,
    operands: property.operands.map((operand) =>
      operand.role === 'receiver' ? { ...operand, source: { kind: 'receiver' as const } } : operand
    )
  }
  const actualThis: IrNonTerminatorOperation = {
    kind: 'receiver',
    lineage: 'actual-this' as never,
    result: { id: receiver.value, representation: source }
  }
  assert.equal(check(actualThis, implicit), true)
  assert.equal(check(receiverDefinition, implicit), false)
  assert.equal(check(actualThis), false)
})

test('a finite computed Set key authenticates its actual source SSA and its own write proof', () => {
  const keyRead: IrNonTerminatorOperation = {
    kind: 'parameter',
    lineage: 'computed-source-key' as never,
    ordinal: 1,
    result: { id: key.value, representation: text }
  }
  const property: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'set',
    strict: true,
    keyIsComputed: true,
    descriptor: null,
    ordinaryObjectDataWriteAbsent: true,
    operands: [
      { ...semantic.operands[0]!, role: 'key', source: { kind: 'result', result: keyRead.lineage } },
      { ...semantic.operands[1]!, role: 'receiver' }
    ],
    results: [{ role: 'value', id: 'computed-source-write' as never, type: 'source-record' as never }]
  }
  const write: SetOperation = {
    kind: 'set',
    lineage: property.results[0]!.id,
    strict: true,
    receiver,
    key,
    value: key,
    result: null,
    ordinaryObjectDataWriteAbsent: true
  }
  const check = (definition = keyRead, operation = write, sourceOperation = property) =>
    nativePropertyPrototypeAbsenceMatches(
      operation,
      sourceOperation,
      (id) => (id === key.value ? definition : id === receiver.value ? receiverDefinition : null),
      conversions
    )
  assert.equal(check(), true)
  assert.equal(check({ ...keyRead, lineage: 'other-source-key' as never }), false)
  assert.equal(check(keyRead, { ...write, key: receiver }), false)
  const { ordinaryObjectDataWriteAbsent: irProof, ...unprovedWrite } = write
  const { ordinaryObjectDataWriteAbsent: sourceProof, ...unprovedProperty } = property
  assert.equal(irProof, true)
  assert.equal(sourceProof, true)
  assert.equal(check(keyRead, unprovedWrite), false)
  assert.equal(check(keyRead, write, unprovedProperty), false)
})

test('exact checked native object payloads preserve source identity without reading their fields', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const targets: readonly Representation[] = [
    {
      kind: 'native-record-ref',
      shapeId: 'native-error',
      ownership: 'shared-refcount',
      native: 'gea::runtime::Error'
    },
    { kind: 'class-ref', declaration: 'program-class' as never, shapeId: 'program-class', ownership: 'shared-refcount', ancestors: [] },
    { kind: 'typed-array', element: 'uint8', buffer: 'array-buffer', ownership: 'shared-refcount' },
    { kind: 'array-buffer', ownership: 'shared-refcount' },
    { kind: 'shared-array-buffer', ownership: 'shared-refcount' },
    { kind: 'data-view', ownership: 'shared-refcount' }
  ]
  for (const native of targets) {
    const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
    const node = census.nodeFor(dynamic, native)
    assert.ok(node.capability.kind === 'atom')
    assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
    assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
    const original: IrNonTerminatorOperation = {
      ...receiverDefinition,
      result: { id: receiver.value, representation: dynamic }
    }
    const converted: IrNonTerminatorOperation = {
      kind: 'convert',
      lineage: read.lineage,
      conversionUse: node.id,
      source: { value: receiver.value, representation: dynamic },
      result: { id: 'native-receiver' as never, representation: native }
    }
    const absentRead: GetOperation = {
      ...read,
      receiver: { value: converted.result.id, representation: native },
      ordinaryObjectPrototypeKeyAbsent: true
    }
    const property: SemanticOperation = {
      ...semantic,
      family: 'property',
      internalMethod: 'get',
      strict: true,
      keyIsComputed: false,
      descriptor: null,
      operands: [
        { ...semantic.operands[0]!, role: 'key' },
        { ...semantic.operands[1]!, role: 'receiver' }
      ]
    }
    const definitions = new Map([original, converted, keyDefinition].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
    const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
    assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, census), true)
    const { nativePayloadTransport: _proof, ...unproved } = node.capability.materializer
    assert.equal(_proof, 'preserved')
    assert.equal(
      nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, {
        nodeById: () => ({ ...node, capability: { ...node.capability, materializer: unproved } })
      }),
      false
    )
  }
})

test('a selected live array reader preserves the exact source property receiver through erasure', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const numbers: Representation = {
    kind: 'array-object',
    element: { kind: 'scalar', domain: 'number' },
    ownership: 'shared-refcount',
    extension: null
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(dynamic, numbers)
  assert.equal(nativeArrayViewIdentityTransportOf(node, census.nodeById), true)
  assert.ok('materializer' in node.capability && node.capability.materializer.nativeArrayView)
  const original: IrNonTerminatorOperation = {
    ...receiverDefinition,
    result: { id: receiver.value, representation: dynamic }
  }
  const converted: Extract<IrNonTerminatorOperation, { kind: 'convert' }> = {
    kind: 'convert',
    lineage: read.lineage,
    conversionUse: node.id,
    source: { value: receiver.value, representation: dynamic },
    result: { id: 'checked-array' as never, representation: numbers }
  }
  const length: IrNonTerminatorOperation = { ...keyDefinition, text: 'length' }
  const absentRead: GetOperation = {
    ...read,
    receiver: { value: converted.result.id, representation: numbers },
    ordinaryObjectPrototypeKeyAbsent: true,
    result: { ...read.result, representation: numbers.element }
  }
  const property: SemanticOperation = {
    ...semantic,
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    operands: [
      { ...semantic.operands[0]!, role: 'key', source: { kind: 'constant', literal: 'string', text: 'length' } },
      { ...semantic.operands[1]!, role: 'receiver' }
    ]
  }
  const definitions = new Map([original, converted, length].map((operation) => [resultOfIrOperation(operation)!.id, operation]))
  const definitionOf = (id: IrValueId) => definitions.get(id) ?? null
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, census), true)
  const { nativeArrayView: omitted, ...unproved } = node.capability.materializer
  assert.ok(omitted)
  const forged = { ...node, capability: { ...node.capability, materializer: unproved } }
  assert.equal(
    nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, {
      nodeById: (id) => (id === node.id ? forged : census.nodeById(id))
    }),
    false
  )
  const wrongRecipe = census.nodeFor(dynamic, { ...numbers, element: text })
  definitions.set(converted.result.id, { ...converted, conversionUse: wrongRecipe.id })
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, census), false)
  definitions.set(converted.result.id, { ...converted, source: { ...converted.source, value: 'other-source' as never } })
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, census), false)
  definitions.set(converted.result.id, converted)
  definitions.set(key.value, { ...keyDefinition, text: 'other-key' })
  assert.equal(nativePropertyPrototypeAbsenceMatches(absentRead, property, definitionOf, census), false)
})

const bodyOf = (between: readonly IrNonTerminatorOperation[] = [], independentEntry = false): IrBody => {
  const entry = 'entry' as IrBlockId
  const selected = 'selected' as IrBlockId
  const other = 'other' as IrBlockId
  const blocks: IrBlock[] = [
    {
      id: entry,
      operations: [receiverDefinition, keyDefinition, has],
      terminator: {
        kind: 'branch',
        lineage: has.lineage,
        condition: { value: has.result.id, representation: boolean },
        whenTrue: selected,
        whenFalse: other
      }
    },
    { id: selected, operations: [...between, read], terminator: { kind: 'return', lineage: null, value: null } },
    {
      id: other,
      operations: [],
      terminator: independentEntry ? { kind: 'jump', lineage: null, target: selected } : { kind: 'return', lineage: null, value: null }
    }
  ]
  return {
    owner: 'physical-body' as never,
    sourceOwner: 'source-body' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map(blocks.map((block) => [block.id, block])),
    blockOrder: blocks.map((block) => block.id),
    values: new Map(
      blocks.flatMap((block) =>
        block.operations.flatMap((operation) => {
          const result = resultOfIrOperation(operation)
          return result ? [[result.id, result.representation] as const] : []
        })
      )
    ),
    tryRegions: []
  }
}

test('only the dominating selected Has edge can refine an ordinary allocation descriptor', () => {
  const authority = nativePropertyPresenceAuthorityOf(bodyOf(), conversions)
  assert.equal(authority(receiver, '$type', read, () => false)?.present, true)
  assert.equal(
    authority(receiver, 'different', read, () => false),
    null
  )
  assert.equal(
    authority({ ...receiver, value: 'different-object' as never }, '$type', read, () => false),
    null
  )
  assert.equal(
    nativePropertyPresenceAuthorityOf(bodyOf([], true), conversions)(receiver, '$type', read, () => false),
    null
  )
})

test('an intervening opaque call cannot preserve the earlier native property guard', () => {
  const call: IrNonTerminatorOperation = {
    kind: 'call',
    lineage: 'mutate' as never,
    callee: {
      value: 'unknown-function' as never,
      representation: { kind: 'function-value-dispatch', abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } } }
    },
    receiver: null,
    arguments: [],
    result: null
  }
  assert.equal(
    nativePropertyPresenceAuthorityOf(bodyOf([call]), conversions)(receiver, '$type', read, () => false),
    null
  )
})

test('a false Has edge retains an allocation with a physically present optional slot', () => {
  const optional: Extract<Representation, { kind: 'record' }> = {
    ...source,
    shapeId: 'optional-slot',
    fields: [{ key: '$type', value: { kind: 'optional', payload: text, absence: 'undefined' }, required: false }]
  }
  const absent: Extract<Representation, { kind: 'record' }> = { ...source, shapeId: 'without-slot', fields: [] }
  const candidates = [optional, absent]
  const hasSlot = (candidate: Representation, name: string) =>
    candidate.kind === 'record' && candidate.fields.some((field) => field.key === name)
  assert.deepEqual(nativePropertyPresenceStorageCandidatesOf({ has, key: '$type', present: false }, candidates, hasSlot), candidates)
  assert.deepEqual(nativePropertyPresenceStorageCandidatesOf({ has, key: '$type', present: true }, candidates, hasSlot), [optional])
})
