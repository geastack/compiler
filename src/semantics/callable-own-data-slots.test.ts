import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId, OperationId, SemanticResultId } from '../identity/ids.js'
import { callableOriginsOf, callableWriteTargetsOf, callableMutationFactsOf, callableBuiltinResolution } from './callable-origins.js'
import { callableOwnDataSlotSchemasOf, refineCallableOwnDataCensus } from './callable-own-data-slots.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from './model/graph.js'
import type {
  AllocationOperation,
  BindingOperation,
  ComputationOperation,
  InvocationOperation,
  PropertyOperation,
  SemanticOperation
} from './model/operations.js'
import type { SemanticOperand, SemanticOperationBase } from './model/operands.js'
import { createStructuralTypeTable } from './model/structural-type-table.js'

const table = createStructuralTypeTable()
const any = table.intern({ kind: 'primitive', primitive: 'any' })
const string = table.intern({ kind: 'primitive', primitive: 'string' })
const boolean = table.intern({ kind: 'primitive', primitive: 'boolean' })
const object = table.intern({ kind: 'object', members: [], index: [], membersDropped: false })
const signature = table.intern({
  kind: 'signature',
  call: [{ parameters: [], minimumArity: 0, thisParameter: null, result: string }],
  construct: []
})
const types = table.seal()
const input = (role: string, result: string, type = signature, ordinal = 0): SemanticOperand => ({
  role,
  ordinal,
  type,
  source: { kind: 'result', result: result as SemanticResultId },
  evaluation: { kind: 'runtime' }
})
const key = (text: string, role = 'key', ordinal = 0): SemanticOperand => ({
  role,
  ordinal,
  type: string,
  source: { kind: 'constant', text, literal: 'string' },
  evaluation: { kind: 'runtime' }
})
type FixtureFacts =
  | Pick<AllocationOperation, 'family' | 'allocated' | 'callable' | 'shape'>
  | (Pick<PropertyOperation, 'family' | 'internalMethod' | 'descriptor'> & Partial<Pick<PropertyOperation, 'keyIsComputed' | 'strict'>>)
  | (Pick<InvocationOperation, 'family' | 'internalMethod'> &
      Partial<Pick<InvocationOperation, 'intrinsicMutation' | 'intrinsicReflection' | 'intrinsicReturnIdentity' | 'intrinsicIntegrity'>>)
  | (Omit<Pick<BindingOperation, 'family' | 'action' | 'declaration' | 'mutable' | 'temporalDeadZone'>, 'declaration'> & {
      readonly declaration: string
    })
  | Pick<ComputationOperation, 'family' | 'form' | 'operator'>
const operation = (id: string, facts: FixtureFacts, operands: readonly SemanticOperand[] = [], type = signature): SemanticOperation => {
  const base: SemanticOperationBase = {
    id: id as OperationId,
    caller: { kind: 'function', functionId: 'fixture-body' as FunctionId },
    operands,
    results: [{ id: id as SemanticResultId, role: 'value', type }],
    evaluationOrdinal: 0,
    effects: { readsMutableState: false, writesMutableState: false, allocates: false, callsUserCode: false },
    completion: { canThrow: false, canReturn: false, canBreak: false, canContinue: false, canSuspend: false }
  }
  switch (facts.family) {
    case 'allocation':
      return { ...base, ...facts }
    case 'property':
      return { ...base, strict: true, keyIsComputed: false, ...facts }
    case 'invocation':
      return {
        ...base,
        optionalChain: false,
        selectedSignature: null,
        resultDivergence: { kind: 'none' },
        target: { kind: 'open', evidence: [] },
        ...facts
      }
    case 'binding':
      return { ...base, ...facts, declaration: facts.declaration as DeclarationId }
    case 'computation':
      return { ...base, ...facts }
  }
}
const allocation = (id: string) =>
  operation(id, { family: 'allocation', allocated: 'function-object', callable: `${id}-body` as FunctionId, shape: signature })
const store = (id: string, target: string, name: string, value: string) =>
  operation(id, { family: 'property', internalMethod: 'set', descriptor: null, keyIsComputed: false, strict: true }, [
    input('receiver', target),
    key(name),
    input('value', value)
  ])
const graphOf = (operations: readonly SemanticOperation[]): SemanticGraph => ({
  operations: new Map(operations.map((op) => [op.id, op])),
  results: new Map(operations.flatMap((op) => op.results.map((result) => [result.id, op.id] as const))),
  regions: new Map(),
  structuralTypes: types,
  edges: [],
  coverage: new Map()
})
const schemaOf = (graph: SemanticGraph, target = 'target', name = 'call') =>
  callableOwnDataSlotSchemasOf(graph)
    .schemas.get(`${target}-body` as FunctionId)
    ?.get(name)

test('all writers remain keyed by exact Function identity rather than a shared signature', () => {
  const graph = graphOf([
    allocation('target'),
    allocation('other'),
    allocation('first'),
    allocation('second'),
    store('first-write', 'target', 'call', 'first'),
    store('second-write', 'target', 'call', 'second'),
    store('other-write', 'other', 'call', 'first')
  ])
  assert.deepEqual(
    schemaOf(graph)?.writers.map((writer) => writer.mutation.operation.id),
    ['first-write', 'second-write']
  )
  assert.deepEqual(
    schemaOf(graph, 'other')?.writers.map((writer) => writer.mutation.operation.id),
    ['other-write']
  )
  assert.equal(schemaOf(graph)?.writers[0]?.value?.callable, 'first-body')
})

test('an assertion on a writer cannot replace its actual allocation type or Function source', () => {
  const written = { ...input('value', 'first', any), asserted: true as const }
  const graph = graphOf([
    allocation('target'),
    allocation('first'),
    operation('write', { family: 'property', internalMethod: 'set', descriptor: null }, [input('receiver', 'target'), key('call'), written])
  ])
  const value = schemaOf(graph)?.writers[0]?.value
  assert.equal(value?.operand.type, any)
  assert.equal(value?.type, signature)
  assert.equal(value?.producer, graph.operations.get('first' as OperationId))
  assert.equal(value?.result?.id, 'first')
})

test('literal values and the literal wildcard name keep their actual primitive and exact key domains', () => {
  const literal = { ...key('data', 'value'), type: any }
  const graph = graphOf([
    allocation('target'),
    operation('write', { family: 'property', internalMethod: 'set', descriptor: null }, [input('receiver', 'target'), key('*'), literal])
  ])
  assert.equal(schemaOf(graph, 'target', '*')?.writers[0]?.value?.type, string)
  assert.equal(
    schemaOf(graph, 'target', '*')?.blockers.some((blocker) => blocker.kind === 'unknown-key'),
    false
  )
})

test('Reflect.set preserves its actual RHS while its boolean result never becomes a target alias', () => {
  const reflect = operation(
    'reflect',
    { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'reflect-set', intrinsicReflection: 'set' },
    [input('argument', 'target'), key('call', 'argument', 1), input('argument', 'first', signature, 2)],
    boolean
  )
  const graph = graphOf([allocation('target'), allocation('first'), reflect])
  const writer = schemaOf(graph)?.writers[0]
  assert.equal(writer?.mutation.resultContract, 'boolean')
  assert.equal(writer?.mutation.produced?.type, boolean)
  assert.equal(writer?.value?.callable, 'first-body')
  assert.equal(callableOriginsOf(graph).has('reflect' as SemanticResultId), false)
})

test('Reflect.set inventories its distinct explicit Receiver rather than installing on the lookup target', () => {
  const lookup = operation('lookup', { family: 'allocation', allocated: 'object-literal', shape: object, callable: null }, [], object)
  const arguments_ = [
    input('argument', 'lookup', object),
    key('call', 'argument', 1),
    input('argument', 'first', signature, 2),
    input('argument', 'target', signature, 3)
  ]
  const reflect = operation(
    'reflect',
    { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'reflect-set', intrinsicReflection: 'set' },
    arguments_,
    boolean
  )
  const graph = graphOf([lookup, allocation('target'), allocation('first'), reflect])
  const row = callableWriteTargetsOf(graph)[0]!
  assert.equal(row.target, arguments_[3])
  assert.equal(row.lookupTarget, arguments_[0])
  assert.equal(row.result, 'target')
  assert.equal(schemaOf(graph)?.writers[0]?.value?.callable, 'first-body')
  assert.equal(
    callableBuiltinResolution(
      callableMutationFactsOf(graph, { selected: new Map() } as unknown as SealedRepresentationPlan),
      'target-body' as FunctionId,
      'call'
    ),
    'ordinary-property'
  )
  assert.equal(row.resultContract, 'boolean')
  assert.equal(callableOriginsOf(graph).has('reflect' as SemanticResultId), false)
})

test('an explicit same Function Receiver keeps lookup and mutation operands distinct', () => {
  const arguments_ = [
    input('argument', 'target'),
    key('call', 'argument', 1),
    input('argument', 'first', signature, 2),
    input('argument', 'target', signature, 3)
  ]
  const reflect = operation(
    'reflect',
    { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'reflect-set', intrinsicReflection: 'set' },
    arguments_,
    boolean
  )
  const graph = graphOf([allocation('target'), allocation('first'), reflect])
  const row = callableWriteTargetsOf(graph)[0]!
  assert.equal(row.target, arguments_[3])
  assert.equal(row.lookupTarget, arguments_[0])
  assert.equal(schemaOf(graph)?.writers.length, 1)
})

test('an unknown explicit Reflect.set Receiver remains an anonymous Function mutation obligation', () => {
  const unknown: SemanticOperand = {
    role: 'argument',
    ordinal: 3,
    type: any,
    source: { kind: 'parameter', ordinal: 0 },
    evaluation: { kind: 'runtime' }
  }
  const reflect = operation(
    'reflect',
    { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'reflect-set', intrinsicReflection: 'set' },
    [input('argument', 'target'), key('call', 'argument', 1), input('argument', 'first', signature, 2), unknown],
    boolean
  )
  const graph = graphOf([
    allocation('target'),
    allocation('first'),
    allocation('other'),
    store('write', 'target', 'call', 'first'),
    reflect
  ])
  const row = callableWriteTargetsOf(graph).find((entry) => entry.operation === reflect)!
  assert.equal(row.result, null)
  assert.equal(row.target, unknown)
  assert.equal(
    schemaOf(graph)?.blockers.some((entry) => entry.kind === 'unknown-target' && entry.operation === reflect),
    true
  )
  const facts = callableMutationFactsOf(graph, { selected: new Map() } as unknown as SealedRepresentationPlan)
  assert.equal(facts.anonymousProperties.has('call'), true)
  assert.equal(facts.boxedOnlyProperties.has('call'), false)
  assert.equal(callableBuiltinResolution(facts, 'other-body' as FunctionId, 'call'), 'ordinary-property')
})

test('computed mutation, direct formals, deletes and opaque definitions remain explicit obligations', () => {
  const parameter: SemanticOperand = {
    role: 'receiver',
    ordinal: 0,
    type: any,
    source: { kind: 'parameter', ordinal: 0 },
    evaluation: { kind: 'runtime' }
  }
  const unknown = operation('parameter-write', { family: 'property', internalMethod: 'set', descriptor: null }, [
    parameter,
    key('call'),
    input('value', 'first')
  ])
  const computed = operation('computed-write', { family: 'property', internalMethod: 'set', descriptor: null }, [
    input('receiver', 'target'),
    input('key', 'runtime-key', string),
    input('value', 'first')
  ])
  const deletion = operation(
    'delete',
    { family: 'invocation', internalMethod: 'call', intrinsicReflection: 'deleteProperty' },
    [input('argument', 'target'), key('call', 'argument', 1)],
    boolean
  )
  const definition = operation('define', { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'object-define-property' }, [
    input('argument', 'target'),
    key('call', 'argument', 1),
    input('argument', 'descriptor', any, 2)
  ])
  const runtimeKey = operation(
    'runtime-key',
    { family: 'binding', action: 'read', declaration: 'key-parameter', mutable: false, temporalDeadZone: false },
    [],
    string
  )
  const descriptor = operation(
    'descriptor',
    { family: 'binding', action: 'read', declaration: 'descriptor-parameter', mutable: false, temporalDeadZone: false },
    [],
    any
  )
  const graph = graphOf([
    allocation('target'),
    allocation('first'),
    runtimeKey,
    descriptor,
    store('write', 'target', 'call', 'first'),
    unknown,
    computed,
    deletion,
    definition
  ])
  assert.equal(callableWriteTargetsOf(graph).find((row) => row.operation === unknown)?.result, null)
  assert.deepEqual(
    new Set(schemaOf(graph)?.blockers.map((row) => row.kind)),
    new Set(['unknown-target', 'unknown-key', 'delete', 'opaque-definition'])
  )
  const facts = callableMutationFactsOf(graph, { selected: new Map() } as unknown as SealedRepresentationPlan)
  assert.equal(callableBuiltinResolution(facts, 'target-body' as FunctionId, 'call'), 'ordinary-property')
})

test('typed data definitions retain flags, all RHS sources and the ordinary receiver result', () => {
  const descriptor = { writable: false, enumerable: true, configurable: true }
  const define = operation('define', { family: 'property', internalMethod: 'define-own-property', descriptor }, [
    input('receiver', 'target'),
    key('call'),
    input('value', 'first')
  ])
  const graph = graphOf([allocation('target'), allocation('first'), define])
  assert.equal(schemaOf(graph)?.writers[0]?.mutation.resultContract, 'receiver')
  assert.equal(schemaOf(graph)?.writers[0]?.mutation.operation, define)
  assert.equal(schemaOf(graph)?.writers[0]?.value?.type, signature)
})

test('ordinary and Reflect __proto__ sets retain the inherited-chain obligation for other owner slots', () => {
  const alias = operation(
    'alias',
    { family: 'binding', action: 'initialize', declaration: 'owner-alias', mutable: false, temporalDeadZone: true },
    [input('value', 'target')]
  )
  const reflected = operation(
    'reflect-prototype',
    { family: 'invocation', internalMethod: 'call', intrinsicMutation: 'reflect-set', intrinsicReflection: 'set' },
    [input('argument', 'alias'), key('__proto__', 'argument', 1), input('argument', 'first', signature, 2)],
    boolean
  )
  for (const mutation of [store('direct-prototype', 'alias', '__proto__', 'first'), reflected]) {
    const graph = graphOf([allocation('target'), allocation('first'), alias, store('write', 'target', 'call', 'first'), mutation])
    assert.ok(schemaOf(graph)?.blockers.some((blocker) => blocker.operation === mutation && blocker.kind === 'inherited-chain'))
  }
})

test('anonymous __proto__ Set cannot be discarded as an unrelated owner key', () => {
  const unknown: SemanticOperand = {
    role: 'receiver',
    ordinal: 0,
    type: any,
    source: { kind: 'parameter', ordinal: 0 },
    evaluation: { kind: 'runtime' }
  }
  const mutation = operation('unknown-prototype', { family: 'property', internalMethod: 'set', descriptor: null }, [
    unknown,
    key('__proto__'),
    input('value', 'first')
  ])
  const graph = graphOf([allocation('target'), allocation('first'), store('write', 'target', 'call', 'first'), mutation])
  assert.ok(schemaOf(graph)?.blockers.some((blocker) => blocker.operation === mutation && blocker.kind === 'inherited-chain'))
})

test('own __proto__ data definitions and deletion do not imply an owner prototype change', () => {
  const definition = operation(
    'define-prototype-key',
    { family: 'property', internalMethod: 'define-own-property', descriptor: { writable: true, enumerable: true, configurable: true } },
    [input('receiver', 'target'), key('__proto__'), input('value', 'first')]
  )
  const deletion = operation(
    'delete-prototype-key',
    { family: 'property', internalMethod: 'delete', descriptor: null },
    [input('receiver', 'target'), key('__proto__')],
    boolean
  )
  const graph = graphOf([allocation('target'), allocation('first'), store('write', 'target', 'call', 'first'), definition, deletion])
  assert.equal(schemaOf(graph)?.blockers.length, 0)
  assert.equal(schemaOf(graph, 'target', '__proto__')?.writers[0]?.mutation.operation, definition)
  const laterSet = store('unproved-after-define', 'target', '__proto__', 'first')
  const laterGraph = graphOf([allocation('target'), allocation('first'), store('write', 'target', 'call', 'first'), definition, laterSet])
  assert.ok(schemaOf(laterGraph)?.blockers.some((blocker) => blocker.operation === laterSet && blocker.kind === 'inherited-chain'))
})

test('strict identity and typeof are native observations while genuine dynamic reads and publication are retained', () => {
  const read = operation(
    'read',
    { family: 'property', internalMethod: 'get', descriptor: null },
    [input('receiver', 'target'), key('call')],
    any
  )
  const equality = operation(
    'same',
    { family: 'computation', form: 'equality', operator: '===' },
    [input('left', 'target'), input('right', 'first')],
    boolean
  )
  const typeOf = operation('type', { family: 'computation', form: 'typeof', operator: 'typeof' }, [input('value', 'target')], string)
  const exposed = operation('publish', { family: 'invocation', internalMethod: 'call' }, [input('argument', 'target')])
  const graph = graphOf([
    allocation('target'),
    allocation('first'),
    store('write', 'target', 'call', 'first'),
    read,
    equality,
    typeOf,
    exposed
  ])
  assert.deepEqual(
    schemaOf(graph)?.reads.map((row) => row.operation.id),
    ['read']
  )
  assert.deepEqual(
    schemaOf(graph)?.dynamicObservations.map((row) => row.operation.id),
    ['read', 'publish']
  )
  assert.deepEqual(
    schemaOf(graph)?.blockers.map((row) => row.operation.id),
    ['publish']
  )
})

test('intact return identity retains the owner while integrity and prototype observations remain obligations', () => {
  const frozen = operation(
    'frozen',
    { family: 'invocation', internalMethod: 'call', intrinsicReturnIdentity: 'argument0', intrinsicIntegrity: 'freeze' },
    [input('argument', 'target')]
  )
  const read = operation('read', { family: 'property', internalMethod: 'get', descriptor: null }, [
    input('receiver', 'frozen'),
    key('call')
  ])
  const prototype = operation('prototype', { family: 'property', internalMethod: 'get', descriptor: null }, [
    input('receiver', 'target'),
    key('prototype')
  ])
  const graph = graphOf([allocation('target'), allocation('first'), store('write', 'target', 'call', 'first'), frozen, read, prototype])
  assert.equal(callableOriginsOf(graph).get('frozen' as SemanticResultId), 'target-body')
  assert.deepEqual(
    schemaOf(graph)?.blockers.map((row) => row.kind),
    ['integrity', 'exposure']
  )
  assert.equal(schemaOf(graph)?.reads[0]?.operation, read)
})

test('a native origin family resolves writes the published inventory could not name, and keeps their blockers', () => {
  const read = operation('method-read', { family: 'property', internalMethod: 'get', descriptor: null }, [
    input('receiver', 'instance'),
    key('method')
  ])
  const written = store('method-note', 'method-read', 'note', 'first')
  const changedChain = store('changed-chain', 'method-read', '__proto__', 'first')
  const graph = graphOf([allocation('first'), allocation('second'), read, written, changedChain])
  const canonical = callableOwnDataSlotSchemasOf(graph)
  const refined = refineCallableOwnDataCensus(canonical, graph, {
    origins: new Map([['method-read' as SemanticResultId, ['first-body' as FunctionId, 'second-body' as FunctionId]]]),
    closedReturns: new Set(),
    disjointTargets: new Set()
  })
  for (const id of ['first-body', 'second-body'] as FunctionId[]) {
    // The published census routed no storage through these owners, so the
    // native inventory is theirs: it names the write and the chain change.
    assert.deepEqual(canonical.owners.get(id)?.writes, [])
    assert.ok(refined.owners.get(id)?.writes.some((write) => write.operation === written))
    assert.ok(refined.owners.get(id)?.blockers.some((blocker) => blocker.operation === changedChain && blocker.kind === 'inherited-chain'))
  }
  assert.equal(canonical.schemas.get('first-body' as FunctionId)?.has('note'), undefined)
})

test('only an authenticated native class method installation discharges its Function publication', () => {
  const root = allocation('method')
  const installed: SemanticOperation = {
    ...root,
    id: 'install-method' as OperationId,
    family: 'class-lifecycle',
    event: 'define-method',
    declaration: 'method-declaration' as DeclarationId,
    classDeclaration: 'class-declaration' as DeclarationId,
    descriptor: { writable: true, enumerable: false, configurable: true },
    placement: 'prototype',
    operands: [input('method', 'method'), key('read')],
    results: []
  }
  const written = store('note', 'method', 'note', 'value')
  const graph = graphOf([root, allocation('value'), installed, written])
  assert.ok(
    callableOwnDataSlotSchemasOf(graph)
      .owners.get('method-body' as FunctionId)
      ?.blockers.some((row) => row.operation === installed)
  )
  const flow = { origins: new Map(), closedReturns: new Set<OperationId>(), disjointTargets: new Set<OperationId>() }
  const canonical = callableOwnDataSlotSchemasOf(graph)
  const closed = refineCallableOwnDataCensus(canonical, graph, { ...flow, closedInstallations: new Set([installed.id]) })
  assert.equal(
    closed.owners.get('method-body' as FunctionId)?.blockers.some((row) => row.operation === installed),
    false
  )
  const unrelated = refineCallableOwnDataCensus(canonical, graph, { ...flow, closedInstallations: new Set([written.id]) })
  assert.ok(unrelated.owners.get('method-body' as FunctionId)?.blockers.some((row) => row.operation === installed))
})
