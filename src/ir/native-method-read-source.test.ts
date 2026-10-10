import assert from 'node:assert/strict'
import test from 'node:test'
import type { SemanticResultId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { ConvertOperation, IrOperation } from './model.js'
import { nativeCallableSourceMatches, nativeCallableSourceOf } from './native-callable-argument.js'
import { nativeMethodReadSourceOf, type NativeMethodReadAuthority } from './native-method-read-source.js'

const receiver: Extract<Representation, { kind: 'class-ref' }> = {
  kind: 'class-ref',
  declaration: 'method-class' as never,
  shapeId: 'method-class',
  ancestors: [],
  ownership: 'shared-refcount'
}
const abi: CallableAbi = { receiver, parameters: [], restFrom: null, result: { kind: 'void' } }
const source: Representation = { kind: 'function-value-dispatch', abi }
const target: Representation = { ...source, abi: { ...abi, receiver: null } }
const origin = 'method-read' as SemanticResultId
const instance = 'method-instance' as SemanticResultId
const read = {
  family: 'property',
  internalMethod: 'get',
  caller: { kind: 'region' },
  operands: [
    { role: 'receiver', ordinal: 0, source: { kind: 'result', result: instance } },
    { role: 'key', ordinal: 0, source: { kind: 'constant', literal: 'string', text: 'run' } }
  ],
  results: [{ id: origin, role: 'value' }]
} as unknown as SemanticOperation
const layout = {
  declaration: receiver.declaration,
  base: null,
  fields: [],
  accessors: [],
  methods: [{ key: 'run', callable: null }]
} as unknown as ClassLayout
const authority: NativeMethodReadAuthority = {
  graph: { operations: new Map([['read' as never, read]]), results: new Map([[origin, 'read' as never]]) },
  classes: new Map([[receiver.declaration, layout]]),
  representations: new Map<SemanticResultId, Representation>([
    [origin, source],
    [instance, receiver]
  ]),
  abis: new Map()
}
const operand = { role: 'initializer', ordinal: 0, source: { kind: 'result', result: origin } } as SemanticOperand
const consumer = { family: 'binding', action: 'initialize', operands: [operand] } as unknown as SemanticOperation

test('a declared native method Get authenticates its exact public frame without inventing one selected body', () => {
  assert.equal(nativeMethodReadSourceOf(origin, source, authority), origin)
  assert.deepEqual(nativeCallableSourceOf(consumer, operand, source, target, new Map(), new Map(), authority), {
    origin,
    methodRead: origin,
    role: 'initializer',
    ordinal: 0
  })
  assert.equal(nativeMethodReadSourceOf('unknown-function-parameter' as never, source, authority), null)
  assert.equal(nativeMethodReadSourceOf(origin, target, authority), null)
  assert.equal(nativeMethodReadSourceOf(origin, source, { ...authority, representations: new Map([[origin, source]]) }), null)
  assert.equal(
    nativeMethodReadSourceOf(origin, source, {
      ...authority,
      classes: new Map([[receiver.declaration, { ...layout, methods: [], fields: [{ key: 'run' }] as never }]])
    }),
    null
  )
})

test('certification requires the actual originating SSA Get and the contextual recipe, not an equal callable allocation', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nativeMethodFor(source, target)!
  const proof = nativeCallableSourceOf(consumer, operand, source, target, new Map(), new Map(), authority)!
  const operation = {
    kind: 'convert',
    source: { value: 'method', representation: source },
    result: { id: 'erased', representation: target },
    conversionUse: node.id,
    nativeCallableSource: proof
  } as unknown as ConvertOperation
  const definition = { kind: 'get', lineage: origin, result: { id: 'method', representation: source } } as unknown as IrOperation
  assert.equal(
    nativeCallableSourceMatches(operation, consumer, definition, new Map(), new Map(), conversions, authority.graph, authority),
    true
  )
  assert.equal(
    nativeCallableSourceMatches(
      operation,
      consumer,
      {
        ...definition,
        kind: 'allocate-callable'
      } as IrOperation,
      new Map(),
      new Map(),
      conversions,
      authority.graph,
      authority
    ),
    false
  )
  assert.equal(
    nativeCallableSourceMatches(
      operation,
      consumer,
      {
        ...definition,
        lineage: 'other-method-read' as never
      },
      new Map(),
      new Map(),
      conversions,
      authority.graph,
      authority
    ),
    false
  )
})

test('a property store result cannot impersonate the native method stored in its value operand', () => {
  const stored = 'property-store' as SemanticResultId
  const store = {
    family: 'property',
    internalMethod: 'set',
    operands: [
      { role: 'receiver', ordinal: 0, source: { kind: 'result', result: instance } },
      { role: 'value', ordinal: 0, source: { kind: 'result', result: origin } }
    ],
    results: [{ id: stored, role: 'value' }]
  } as unknown as SemanticOperation
  const reads = {
    ...authority,
    graph: {
      operations: new Map([...authority.graph.operations, ['store' as never, store]]),
      results: new Map([...authority.graph.results, [stored, 'store' as never]])
    }
  }
  assert.equal(nativeMethodReadSourceOf(stored, source, reads), null)
})

test('an exact immutable binding snapshot retains native Get provenance and certifies its actual SSA read', () => {
  const saved = 'saved-read' as SemanticResultId
  const declaration = 'saved-cell' as never
  const initialize = {
    family: 'binding',
    action: 'initialize',
    declaration,
    operands: [{ role: 'initializer', ordinal: 0, source: { kind: 'result', result: origin } }],
    results: [{ id: 'initialize' as SemanticResultId, role: 'value' }]
  } as unknown as SemanticOperation
  const binding = {
    family: 'binding',
    action: 'read',
    declaration,
    mutable: false,
    operands: [],
    results: [{ id: saved, role: 'value' }]
  } as unknown as SemanticOperation
  const reads: NativeMethodReadAuthority = {
    ...authority,
    graph: {
      operations: new Map([...authority.graph.operations, ['initialize' as never, initialize], ['saved' as never, binding]]),
      results: new Map([...authority.graph.results, [saved, 'saved' as never]])
    },
    representations: new Map([...authority.representations, [saved, source]])
  }
  const value = { role: 'value', ordinal: 0, source: { kind: 'result', result: saved } } as SemanticOperand
  const store = { family: 'property', internalMethod: 'set', operands: [value] } as unknown as SemanticOperation
  const proof = nativeCallableSourceOf(store, value, source, target, new Map(), new Map(), reads)!
  assert.deepEqual(proof, { origin: saved, methodRead: origin, role: 'value', ordinal: 0 })
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipe = conversions.nativeMethodFor(source, target)!
  const converted = {
    kind: 'convert',
    source: { value: 'binding-value', representation: source },
    result: { id: 'adapted', representation: target },
    conversionUse: recipe.id,
    nativeCallableSource: proof
  } as unknown as ConvertOperation
  const definition = {
    kind: 'binding-read',
    declaration,
    lineage: saved,
    result: { id: 'binding-value', representation: source }
  } as unknown as IrOperation
  assert.equal(nativeCallableSourceMatches(converted, store, definition, new Map(), new Map(), conversions, reads.graph, reads), true)
  assert.equal(
    nativeCallableSourceMatches(
      converted,
      store,
      { ...definition, declaration: 'different-cell' } as IrOperation,
      new Map(),
      new Map(),
      conversions,
      reads.graph,
      reads
    ),
    false
  )
  for (const operations of [
    new Map([...reads.graph.operations, ['saved' as never, { ...binding, mutable: true } as SemanticOperation]]),
    new Map([...reads.graph.operations].filter(([id]) => id !== 'initialize')),
    new Map([...reads.graph.operations, ['write' as never, { ...initialize, action: 'write' } as SemanticOperation]])
  ])
    assert.equal(nativeMethodReadSourceOf(saved, source, { ...reads, graph: { ...reads.graph, operations } }), null)
})
