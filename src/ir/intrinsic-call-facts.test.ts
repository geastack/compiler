import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DeclarationId,
  FunctionId,
  IrValueId,
  OperationId,
  PhysicalBodyId,
  SemanticResultId,
  StructuralTypeId
} from '../identity/ids.js'
import { calleeRenderingOf, type CalleeRenderingInput } from '../projection/callee.js'
import { authenticatedTemplateCallEntry } from './call-entry.js'
import { coreHostMembers } from '../targets/cpp/host/host-members.js'
import { createRepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { normalCompletion, pureEffects, type SemanticOperationBase } from '../semantics/model/operands.js'
import type { BindingOperation, InvocationOperation, PropertyOperation, SemanticOperation } from '../semantics/model/operations.js'
import { createIrBodyBuilder } from './build.js'
import { allOperationsOf, type CallOperation, type IrOperation } from './model.js'
import {
  authenticatedArrayIsArrayCall,
  authenticatedNativeHostMethodReadOf,
  intrinsicCallFlagsMatch,
  nativeHostMethodReadMatches
} from './intrinsic-call-facts.js'
import { nativeHostMethodReadProofsOf, publishNativeHostMethodReads } from './native-host-method-reads.js'
import { observesNativeCarrierOnly } from './queries.js'

const intrinsicLineage = 'source-call-result' as SemanticResultId
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
}
const call = (flags: Partial<CallOperation>): CallOperation => ({
  kind: 'call',
  lineage: intrinsicLineage,
  callee: { value: 'ir-callee' as IrValueId, representation: callable },
  receiver: null,
  arguments: [],
  result: null,
  ...flags
})
const intrinsicProducer: IrOperation = {
  kind: 'binding-read',
  lineage: 'callee-result' as SemanticResultId,
  declaration: 'host-owner' as DeclarationId,
  result: { id: 'ir-callee' as IrValueId, representation: callable }
}
const intrinsicDefinition = (value: IrValueId): IrOperation | null => (value === 'ir-callee' ? intrinsicProducer : null)
const match = (operation: CallOperation, source: SemanticOperation | null, rendering?: CalleeRenderingInput): boolean =>
  intrinsicCallFlagsMatch(operation, source, rendering, intrinsicDefinition)
const semantic = (flags: object): SemanticOperation =>
  ({
    id: 'source-invocation',
    family: 'invocation',
    internalMethod: 'call',
    results: [{ role: 'value', id: intrinsicLineage }],
    operands: [{ role: 'callee', ordinal: 0, source: { kind: 'result', result: 'callee-result' } }],
    ...flags
  }) as unknown as SemanticOperation

const renderingOf = (invocation: SemanticOperation, template = true): CalleeRenderingInput =>
  ({
    graph: {
      operations: new Map<unknown, unknown>([
        [invocation.id, invocation],
        ['callee-producer', { id: 'callee-producer', family: 'binding', action: 'read', declaration: 'host-owner' }]
      ]),
      results: new Map([
        ['callee-result', 'callee-producer'],
        [intrinsicLineage, invocation.id]
      ])
    },
    placements: new Map([['host-owner', { storage: { kind: template ? 'host-singleton' : 'local' } }]]),
    hostMethodAliasDeclarations: new Set(),
    hostMembers: coreHostMembers
  }) as unknown as CalleeRenderingInput

test('intrinsic frame exclusion requires the exact semantic fact and shared template verdict', () => {
  const source = semantic({ intrinsicReflection: 'get' })
  const operation = call({ intrinsicReflection: 'get' })
  assert.equal(match(operation, source, renderingOf(source)), true)
  // The normalized standard-member fact supplies the template license; a
  // generic binding placement is not a second opinion about that member.
  assert.equal(match(operation, source, renderingOf(source, false)), true)
  assert.equal(match(operation, source), false)
  assert.equal(match(operation, null, renderingOf(source)), false)
  assert.equal(match(call({ intrinsicReflection: 'set' }), source, renderingOf(source)), false)
  assert.equal(
    intrinsicCallFlagsMatch(operation, source, renderingOf(source)),
    false,
    'an absent final callee proof cannot borrow the flag'
  )
  assert.equal(
    intrinsicCallFlagsMatch(operation, source, renderingOf(source), () => ({ ...intrinsicProducer, lineage: 'other' as SemanticResultId })),
    false
  )
  assert.equal(match({ ...operation, lineage: 'other-call' as SemanticResultId }, source, renderingOf(source)), false)
  assert.equal(
    match({ ...operation, callee: { ...operation.callee, value: 'other-callee' as IrValueId } }, source, renderingOf(source)),
    false
  )
  const ordinary = semantic({})
  assert.equal(match(operation, ordinary, renderingOf(ordinary)), false)
  assert.equal(match(operation, { ...source }, renderingOf(source)), false)
})

test('own-key facts authenticate by source identity and cannot be forged onto an ordinary call', () => {
  const source = semantic({ intrinsicOwnKeys: true })
  assert.equal(match(call({ intrinsicOwnKeys: true }), source, renderingOf(source)), true)
  const ordinary = semantic({})
  assert.equal(match(call({ intrinsicOwnKeys: true }), ordinary, renderingOf(ordinary)), false)
  assert.equal(match(call({}), ordinary), true)
  const constructor = semantic({ internalMethod: 'construct', intrinsicOwnKeys: true })
  assert.equal(match(call({ intrinsicOwnKeys: true }), constructor, renderingOf(constructor)), false)
})

test('return identity authenticates the exact evaluated argument and the sealed integrity entry', () => {
  const source = semantic({
    intrinsicReturnIdentity: 'argument0',
    intrinsicIntegrity: 'freeze',
    operands: [
      { role: 'callee', ordinal: 0, source: { kind: 'result', result: 'callee-result' } },
      { role: 'argument', ordinal: 0, source: { kind: 'result', result: 'argument-result' } }
    ]
  })
  const rendering = renderingOf(source)
  const argument = {
    ...intrinsicProducer,
    lineage: 'argument-result' as SemanticResultId,
    result: { id: 'ir-argument' as IrValueId, representation: callable }
  }
  const definitionOf = (value: IrValueId): IrOperation | null => (value === 'ir-argument' ? argument : intrinsicDefinition(value))
  const operation = call({
    intrinsicReturnIdentity: 'argument0',
    intrinsicIntegrity: 'freeze',
    arguments: [{ value: 'ir-argument' as IrValueId, representation: callable }]
  })
  assert.equal(intrinsicCallFlagsMatch(operation, source, rendering, definitionOf), true)
  assert.equal(intrinsicCallFlagsMatch({ ...operation, intrinsicIntegrity: 'seal' }, source, rendering, definitionOf), false)
  assert.equal(
    intrinsicCallFlagsMatch(operation, source, rendering, (value) =>
      value === 'ir-argument' ? { ...argument, lineage: 'unrelated-result' as SemanticResultId } : intrinsicDefinition(value)
    ),
    false
  )
  assert.equal(
    intrinsicCallFlagsMatch(
      { ...operation, arguments: [{ value: 'ir-callee' as IrValueId, representation: callable }] },
      source,
      rendering,
      definitionOf
    ),
    false,
    'an equal-shaped callee is not the evaluated target'
  )
  assert.equal(intrinsicCallFlagsMatch({ ...operation, argumentsAreSpread: true }, source, rendering, definitionOf), false)
})

const arrayPredicateFixture = (protocol = 'ArrayConstructor', member = 'isArray') => {
  const owner = 'array-predicate-owner' as FunctionId
  const declaration = 'standard-array-declaration' as DeclarationId
  const shape = 'array-predicate-shape' as StructuralTypeId
  const origin = (text: string) => text as SemanticResultId
  const dictionary: Representation = { kind: 'dictionary', key: 'string', value: { kind: 'string' }, ownership: 'shared-refcount' }
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const array: Representation = {
    kind: 'native-handle',
    protocol,
    version: 1,
    native: null,
    bases: [],
    call: null,
    construct: null
  }
  const abi: CallableAbi = {
    receiver: null,
    parameters: [{ value: dictionary, passing: 'by-value', ownership: 'shared-refcount' }],
    restFrom: null,
    result: boolean
  }
  const callable: Representation = { kind: 'function-value-dispatch', abi }
  const builder = createIrBodyBuilder('array-predicate-body' as PhysicalBodyId, owner, { ...abi, result: { kind: 'void' } })
  const block = builder.openBlock()
  const argument = builder.parameter(block, origin('argument-result'), 0, dictionary)
  const receiver = builder.bindingRead(block, origin('array-result'), declaration, array)
  const key = builder.constant(block, origin('key-result'), member, 'string', { kind: 'string' })
  const callee = builder.get(
    block,
    origin('method-result'),
    { value: receiver, representation: array },
    { value: key, representation: { kind: 'string' } },
    callable
  )
  builder.call(
    block,
    origin('call-result'),
    { value: callee, representation: callable },
    null,
    [{ value: argument, representation: dictionary }],
    boolean
  )
  builder.return(block, null, null)
  const body = builder.seal()
  const definitions = new Map<IrValueId, IrOperation>()
  let operation: CallOperation | null = null
  for (const entry of body.blocks.values())
    for (const item of entry.operations) {
      if ('result' in item && item.result !== null) definitions.set(item.result.id, item)
      if (item.kind === 'call')
        operation = protocol === 'ArrayConstructor' ? { ...item, hostTemplate: 'array-is-array', intrinsicCarrierPredicate: true } : item
    }
  assert.ok(operation)
  const base = (id: string, result: string): SemanticOperationBase => ({
    id: id as OperationId,
    caller: { kind: 'function', functionId: owner },
    operands: [],
    results: [{ id: origin(result), role: 'value', type: shape }],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: 0
  })
  const sourceReceiver: BindingOperation = {
    ...base('array-read', 'array-result'),
    family: 'binding',
    action: 'read',
    declaration,
    mutable: false,
    temporalDeadZone: false
  }
  const sourceRead: PropertyOperation = {
    ...base('method-read', 'method-result'),
    family: 'property',
    internalMethod: 'get',
    strict: true,
    keyIsComputed: false,
    descriptor: null,
    operands: [
      {
        role: 'receiver',
        ordinal: 0,
        source: { kind: 'result', result: origin('array-result') },
        type: shape,
        evaluation: { kind: 'runtime' }
      },
      {
        role: 'key',
        ordinal: 0,
        source: { kind: 'constant', literal: 'string', text: member },
        type: shape,
        evaluation: { kind: 'runtime' }
      }
    ]
  }
  const invocation: InvocationOperation = {
    ...base('array-call', 'call-result'),
    family: 'invocation',
    internalMethod: 'call',
    optionalChain: false,
    selectedSignature: null,
    resultDivergence: { kind: 'none' },
    target: { kind: 'open', evidence: [] },
    ...(protocol === 'ArrayConstructor' ? { intrinsicCarrierPredicate: true as const } : {}),
    operands: [
      {
        role: 'callee',
        ordinal: 0,
        source: { kind: 'result', result: origin('method-result') },
        type: shape,
        evaluation: { kind: 'runtime' }
      }
    ]
  }
  const graph: SemanticGraph = {
    regions: new Map(),
    structuralTypes: new Map(),
    edges: [],
    coverage: new Map(),
    operations: new Map<OperationId, SemanticOperation>([
      [sourceReceiver.id, sourceReceiver],
      [sourceRead.id, sourceRead],
      [invocation.id, invocation]
    ]),
    results: new Map([
      [origin('array-result'), sourceReceiver.id],
      [origin('method-result'), sourceRead.id],
      [origin('call-result'), invocation.id]
    ])
  }
  const rendering: CalleeRenderingInput = {
    graph,
    plan: { selected: new Map([[origin('array-result'), array]]), evidence: new Map(), conflicts: [] },
    deriver: createRepresentationDeriver(new Map()),
    placements: new Map([[declaration, { storage: { kind: 'host-singleton', linkageName: protocol }, representation: array }]]),
    hostMethodAliasDeclarations: new Set(),
    hostMembers: coreHostMembers
  }
  const definitionOf = (value: IrValueId): IrOperation | null => definitions.get(value) ?? null
  const replace =
    (value: IrValueId, definition: IrOperation) =>
    (id: IrValueId): IrOperation | null =>
      id === value ? definition : definitionOf(id)
  return {
    operation,
    invocation,
    rendering,
    body,
    definitionOf,
    replace,
    receiver: definitions.get(receiver)!,
    key: definitions.get(key)!,
    read: definitions.get(callee)!
  }
}

test('the Array.isArray observation requires its exact normalized invocation and final callee Get', () => {
  const input = arrayPredicateFixture()
  assert.equal(authenticatedArrayIsArrayCall(input.operation, input.invocation, input.rendering, input.definitionOf), true)
  assert.equal(intrinsicCallFlagsMatch(input.operation, input.invocation, input.rendering, input.definitionOf), true)
  assert.equal(intrinsicCallFlagsMatch(input.operation, input.invocation, input.rendering), false)
  assert.equal(authenticatedArrayIsArrayCall(input.operation, { ...input.invocation }, input.rendering, input.definitionOf), false)
  assert.equal(
    authenticatedArrayIsArrayCall(
      { ...input.operation, lineage: 'different-call-result' as SemanticResultId },
      input.invocation,
      input.rendering,
      input.definitionOf
    ),
    false
  )
  assert.equal(
    authenticatedArrayIsArrayCall(input.operation, input.invocation, input.rendering, () => null),
    false
  )
})

test('ambient stock bulk frames retain native planning but cannot restore a withdrawn source member', () => {
  const input = arrayPredicateFixture('ObjectConstructor', 'assign')
  const source: InvocationOperation = { ...input.invocation, intrinsicMutation: 'object-assign' }
  const graph: SemanticGraph = {
    ...input.rendering.graph,
    operations: new Map(input.rendering.graph.operations).set(source.id, source)
  }
  const rendering: CalleeRenderingInput = { ...input.rendering, graph }
  const operation: CallOperation = { ...input.operation, hostTemplate: 'object-assign' }
  assert.equal(calleeRenderingOf(rendering, source), 'template')
  assert.equal(authenticatedTemplateCallEntry(operation, source, rendering, input.definitionOf), true)
  const proof = authenticatedNativeHostMethodReadOf(operation, source, rendering, input.definitionOf, undefined, 'object-assign')
  assert.ok(proof)
  assert.equal(intrinsicCallFlagsMatch(operation, source, rendering, input.definitionOf), true)
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      operation,
      source,
      rendering,
      input.replace(operation.callee.value, { ...input.read, key: input.operation.arguments[0]! } as IrOperation),
      undefined,
      'object-assign'
    ),
    null,
    'the stock source still needs its actual constant-key Get'
  )
  const { intrinsicMutation: _intact, ...withdrawn } = source
  const unproved: CalleeRenderingInput = {
    ...rendering,
    graph: { ...graph, operations: new Map(graph.operations).set(withdrawn.id, withdrawn) }
  }
  assert.equal(calleeRenderingOf(unproved, withdrawn), 'template', 'frame planning must not box typed arguments to reject execution')
  const { hostTemplate: _template, ...withoutTemplate } = operation
  for (const actual of [operation, withoutTemplate]) {
    assert.equal(authenticatedTemplateCallEntry(actual, withdrawn, unproved, input.definitionOf), false)
    assert.equal(authenticatedNativeHostMethodReadOf(actual, withdrawn, unproved, input.definitionOf), null)
  }
  assert.equal(intrinsicCallFlagsMatch(operation, withdrawn, unproved, input.definitionOf), false)
  assert.equal(nativeHostMethodReadProofsOf(input.body, unproved).size, 0)
})

test('an equal callable or native owner shape cannot substitute for the authenticated Array read', () => {
  const input = arrayPredicateFixture()
  assert.ok(input.read.kind === 'get' && input.receiver.kind === 'binding-read' && input.key.kind === 'constant')
  const receiver = { ...input.receiver, declaration: 'unrelated-owner-declaration' as DeclarationId }
  assert.equal(
    authenticatedArrayIsArrayCall(input.operation, input.invocation, input.rendering, input.replace(input.read.receiver.value, receiver)),
    false
  )
  const wrongRead = { ...input.read, lineage: 'another-same-shaped-method' as SemanticResultId }
  assert.equal(
    authenticatedArrayIsArrayCall(
      input.operation,
      input.invocation,
      input.rendering,
      input.replace(input.operation.callee.value, wrongRead)
    ),
    false
  )
  const wrongKey = { ...input.key, text: 'mutate' }
  assert.equal(
    authenticatedArrayIsArrayCall(input.operation, input.invocation, input.rendering, input.replace(input.read.key.value, wrongKey)),
    false
  )
  const numericKey: IrOperation = { ...input.key, literal: 'number' }
  assert.equal(
    authenticatedArrayIsArrayCall(input.operation, input.invocation, input.rendering, input.replace(input.read.key.value, numericKey)),
    false
  )
})

test('host template metadata cannot restore an intrinsic fact absent after shadowing or mutation', () => {
  const input = arrayPredicateFixture()
  const { intrinsicCarrierPredicate: _predicate, ...ordinary } = input.invocation
  const graph = { ...input.rendering.graph, operations: new Map(input.rendering.graph.operations).set(ordinary.id, ordinary) }
  assert.equal(authenticatedArrayIsArrayCall(input.operation, ordinary, { ...input.rendering, graph }, input.definitionOf), false)
  const rendering = { ...input.rendering, plan: { ...input.rendering.plan, selected: new Map() } }
  assert.equal(authenticatedArrayIsArrayCall(input.operation, input.invocation, rendering, input.definitionOf), false)
})

test('only the exact ambient native method read is a deferred lookup, never a host property or getter', () => {
  const input = arrayPredicateFixture('Console', 'log')
  const proof = authenticatedNativeHostMethodReadOf(input.operation, input.invocation, input.rendering, input.definitionOf)
  assert.ok(proof)
  assert.equal(proof.read, input.read)
  assert.equal(proof.receiver, input.receiver)
  assert.equal(proof.key, input.key)
  assert.equal(proof.receipt.protocol, 'Console')
  assert.equal(proof.receipt.member, 'log')
  const getterRows = new Map(coreHostMembers)
  getterRows.set('Console.log', {
    kind: 'property',
    emit: 'hostGetter()',
    store: null
  })
  assert.equal(
    authenticatedNativeHostMethodReadOf(input.operation, input.invocation, input.rendering, input.definitionOf, getterRows),
    null
  )
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      input.operation,
      input.invocation,
      { ...input.rendering, placements: new Map() },
      input.definitionOf
    ),
    null
  )
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      { ...input.operation, lineage: 'other-invocation' as SemanticResultId },
      input.invocation,
      input.rendering,
      input.definitionOf
    ),
    null
  )
  assert.ok(input.receiver.kind === 'binding-read' && input.read.kind === 'get' && input.key.kind === 'constant')
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      input.operation,
      input.invocation,
      input.rendering,
      input.replace(input.read.receiver.value, { ...input.receiver, declaration: 'local-console' as DeclarationId })
    ),
    null
  )
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      input.operation,
      input.invocation,
      input.rendering,
      input.replace(input.read.key.value, { ...input.key, text: 'error' })
    ),
    null
  )
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: input.read.receiver.representation }
  assert.equal(
    authenticatedNativeHostMethodReadOf(
      input.operation,
      input.invocation,
      {
        ...input.rendering,
        plan: { ...input.rendering.plan, selected: new Map([[input.receiver.lineage, optional]]) }
      },
      input.definitionOf
    ),
    null
  )
})

test('deferred native method receipts are republished from final source calls and independently matched', () => {
  const input = arrayPredicateFixture('Console', 'log')
  const published = publishNativeHostMethodReads(new Map([[input.body.owner, input.body]]), input.rendering).get(input.body.owner)!
  const read = [...published.blocks.values()].flatMap((block) => [...allOperationsOf(block)]).find((operation) => operation.kind === 'get')
  assert.ok(read?.kind === 'get')
  assert.equal(read.nativeHostMethodRead?.member, 'log')
  assert.equal(observesNativeCarrierOnly(input.read), false)
  assert.equal(observesNativeCarrierOnly(read), true)
  const independent = nativeHostMethodReadProofsOf(published, input.rendering)
  assert.equal(nativeHostMethodReadMatches(read, independent.get(read) ?? null), true)
  assert.equal(
    nativeHostMethodReadMatches(
      { ...read, nativeHostMethodRead: { ...read.nativeHostMethodRead!, member: 'error' } },
      independent.get(read) ?? null
    ),
    false
  )
  const withdrawn = publishNativeHostMethodReads(new Map([[published.owner, published]]), undefined).get(published.owner)!
  const withdrawnRead = [...withdrawn.blocks.values()]
    .flatMap((block) => [...allOperationsOf(block)])
    .find((operation) => operation.kind === 'get')
  assert.ok(withdrawnRead?.kind === 'get')
  assert.equal(withdrawnRead.nativeHostMethodRead, undefined)
  assert.equal(observesNativeCarrierOnly(withdrawnRead), false)
})
