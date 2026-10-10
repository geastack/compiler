import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { coreHostMembers, type HostSpellings } from '../targets/cpp/host/host-members.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { hostReadIgnoresLogicalReceiver, nativeLogicalReceiverAdmitted, publishLogicalReceivers } from './logical-receivers.js'
import { authenticatedTemplateCallEntry, genericNativeLogicalReceiverOf } from './call-entry.js'
import type { CalleeRenderingInput } from '../projection/callee.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { operandOf } from '../semantics/model/operands.js'
import type { BindCallableOperation, CallOperation, GetOperation, IrBody, IrNonTerminatorOperation, IrOperation } from './model.js'

const abi: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const callable: Representation = { kind: 'function-value-dispatch', abi }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const lineage = 'logical-receivers' as never
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })
const result = (id: string, representation: Representation) => ({ id: id as never, representation })
const body = (id: string, operations: readonly IrNonTerminatorOperation[], frame: CallableAbi | null = null): IrBody => {
  const entry = `${id}-entry` as IrBody['entry']
  return {
    owner: id as never,
    sourceOwner: id as never,
    abi: frame,
    construct: null,
    entry,
    blocks: new Map([[entry, { id: entry, operations, terminator: { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const call: CallOperation = {
  kind: 'call',
  lineage,
  callee: operand('callee', callable),
  receiver: null,
  thisArgument: operand('receiver', dynamic),
  arguments: [],
  result: null
}
const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const deriver = {} as RepresentationDeriver
const hosts = { members: coreHostMembers } as HostSpellings
const rewrittenCall = (root: IrBody, extra: readonly IrBody[] = []): CallOperation => {
  const rewritten = publishLogicalReceivers(
    new Map([root, ...extra].map((value) => [value.owner, value])),
    new Map(),
    new Map(),
    census,
    deriver,
    hosts
  )
  return rewritten
    .get(root.owner)!
    .blocks.get(root.entry)!
    .operations.find((operation) => operation.kind === 'call')! as CallOperation
}

test('a complete native function origin drops only an irrelevant logical receiver', () => {
  const allocation: IrNonTerminatorOperation = {
    kind: 'allocate-callable',
    lineage,
    functionId: 'free' as never,
    captures: [],
    result: result('callee', callable)
  }
  const root = body('root', [allocation, call])
  assert.equal(rewrittenCall(root, [body('free', [], abi)]).thisArgument, undefined)
})

test('an unresolved callable preserves its logical receiver', () => {
  assert.deepEqual(rewrittenCall(body('root', [call])).thisArgument, call.thisArgument)
})

test('a public nil frame cannot admit a native Proxy receiver without an exact independent source body', () => {
  const empty: Representation = { kind: 'record', shapeId: 'proxy-target', fields: [], accessors: [], ownership: 'shared-refcount' }
  const proxy: Representation = { kind: 'proxy-object', target: empty, handler: empty }
  const proxyCall: CallOperation = { ...call, thisArgument: operand('proxy', proxy) }
  assert.equal(nativeLogicalReceiverAdmitted(proxyCall, new Set()), false)
  assert.equal(nativeLogicalReceiverAdmitted(proxyCall, new Set([proxyCall.callee.value])), true)
  assert.equal(nativeLogicalReceiverAdmitted({ ...proxyCall, thisArgument: operand('receiver', dynamic) }, new Set()), true)
  const mixed: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'proxy', semanticType: 'proxy' as never, value: proxy, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'plain', semanticType: 'plain' as never, value: empty, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  assert.equal(nativeLogicalReceiverAdmitted({ ...proxyCall, thisArgument: operand('mixed', mixed) }, new Set()), false)
})

test('a Proxy answered async arrow executes through its exact receiver-independent source protocol', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/proxy-answered-method-called-with-the-proxy-as-this-aborts-by-name.runtime.ts')],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const calls = (result.irBodies ?? []).flatMap((body) =>
    [...body.blocks.values()].flatMap((block) => block.operations.filter((operation) => operation.kind === 'call'))
  )
  assert.ok(calls.length > 0)
  const compressCalls = calls.filter((operation) => {
    const id = result.graph.results.get(operation.lineage)
    const source = id === undefined ? undefined : result.graph.operations.get(id)
    if (source?.family !== 'invocation') return false
    const callee = operandOf(source, 'callee')
    if (callee?.source.kind !== 'result') return false
    const readId = result.graph.results.get(callee.source.result)
    const read = readId === undefined ? undefined : result.graph.operations.get(readId)
    if (read?.family !== 'property') return false
    const key = operandOf(read, 'key')
    return key?.source.kind === 'constant' && key.source.text === 'compress'
  })
  assert.ok(compressCalls.length > 0)
  assert.ok(compressCalls.every((operation) => operation.thisArgument === undefined))
})

test('a Proxy answered this-dependent function refuses before introducing a non-JavaScript TypeError', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/proxy-answered-method-with-dynamic-this.runtime.ts')],
    projectFileName: null,
    closedScriptScope: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.certificate, null)
  assert.equal(result.source, null)
  assert.ok(result.refusals.some((refusal) => refusal.stage === 'certify' && refusal.key === 'call-abi:logical-receiver'))
})

test('a genuinely unknown Proxy answered function cannot borrow another source arrow receiver proof', () => {
  const entry = resolve('test/runtime/proxy-answered-unknown-method.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    sourceOverlay: new Map([
      [
        entry,
        `declare const opaque: any
        const answered = new Proxy({}, { get: () => opaque }) as { read(): string }
        console.log(answered.read())`
      ]
    ])
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.certificate, null)
  assert.equal(result.source, null)
  assert.ok(result.refusals.some((refusal) => refusal.key === 'call-abi:logical-receiver'))
})

const array: Representation = {
  kind: 'array-object',
  element: { kind: 'scalar', domain: 'number' },
  ownership: 'shared-refcount',
  extension: null
}
const dictionary: Representation = { kind: 'dictionary', key: 'string', value: { kind: 'string' }, ownership: 'shared-refcount' }

test('shared array and dictionary logical receivers retain their native payload', () => {
  for (const representation of [array, dictionary]) {
    const nativeCall: CallOperation = { ...call, thisArgument: operand('container', representation) }
    assert.equal(nativeLogicalReceiverAdmitted(nativeCall, new Set()), true)
    assert.equal(nativeLogicalReceiverAdmitted(nativeCall, new Set([nativeCall.callee.value])), true)
    const optional: Representation = { kind: 'optional', payload: representation, absence: 'undefined' }
    assert.equal(nativeLogicalReceiverAdmitted({ ...nativeCall, thisArgument: operand('optional', optional) }, new Set()), true)
  }
})

test('a shared typed-array view and a class instance in one sum are both native object receivers', () => {
  const view: Representation = { kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' }
  const instance: Representation = {
    kind: 'class-ref',
    declaration: 'decl|texture' as never,
    shapeId: 'type|texture' as never,
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const sum: Representation = {
    kind: 'tagged-union',
    arms: [
      {
        tag: '0',
        value: { kind: 'scalar', domain: 'number' },
        semanticType: 'type|number' as never,
        runtimeDiscriminator: { kind: 'carrier' }
      },
      { tag: '1', value: instance, semanticType: 'type|texture' as never, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: '2', value: view, semanticType: 'type|float32' as never, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  } as Representation
  const dynamicCallee: CallOperation = { ...call, callee: operand('callee', dynamic), receiver: null }
  for (const representation of [view, sum]) {
    assert.equal(nativeLogicalReceiverAdmitted({ ...dynamicCallee, thisArgument: operand('receiver', representation) }, new Set()), true)
  }
  const owned: Representation = { ...view, ownership: 'owned' } as Representation
  assert.equal(nativeLogicalReceiverAdmitted({ ...dynamicCallee, thisArgument: operand('receiver', owned) }, new Set()), false)
})

test('exact native physical receiver frames bypass only the erased receiver channel', () => {
  const physicalAbi: CallableAbi = { ...abi, receiver: array }
  const physical: CallOperation = {
    ...call,
    callee: operand('physical', { kind: 'function-value-dispatch', abi: physicalAbi }),
    receiver: operand('array', array),
    thisArgument: operand('array', array)
  }
  assert.equal(genericNativeLogicalReceiverOf(physical), null)
  assert.equal(nativeLogicalReceiverAdmitted(physical, new Set()), true)
  // A target annotation alone does not grant that physical convention.
  assert.equal(
    nativeLogicalReceiverAdmitted(
      {
        ...call,
        thisArgument: operand('array', { ...array, ownership: 'owned' }),
        target: { kind: 'direct', functionId: 'physical' as never }
      },
      new Set()
    ),
    false
  )
})

test('dynamic callable sum arms retain the erased logical receiver obligation', () => {
  const sum: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'dynamic', semanticType: 'dynamic' as never, value: dynamic, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'native', semanticType: 'native' as never, value: callable, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  const logical: CallOperation = { ...call, callee: operand('sum', sum), thisArgument: operand('array', { ...array, ownership: 'owned' }) }
  assert.equal(genericNativeLogicalReceiverOf(logical), logical.thisArgument)
  assert.equal(nativeLogicalReceiverAdmitted(logical, new Set()), false)
  assert.equal(nativeLogicalReceiverAdmitted({ ...logical, callee: operand('dynamic', dynamic) }, new Set()), false)
  const enteredDynamic: CallOperation = { ...logical, callee: operand('dynamic', dynamic), receiver: operand('dynamic-this', dynamic) }
  assert.equal(genericNativeLogicalReceiverOf(enteredDynamic), null)
  assert.equal(nativeLogicalReceiverAdmitted(enteredDynamic, new Set()), true)
})

test('bind captures unsupported logical receivers only for complete receiver-independent source bodies', () => {
  const bind: BindCallableOperation = {
    kind: 'bind-callable',
    lineage,
    source: call.callee,
    sourceFunctionId: null,
    sourceAbi: abi,
    thisArgument: operand('array', { ...array, ownership: 'owned' }),
    receiver: null,
    bound: [],
    result: result('bound', callable)
  }
  assert.equal(nativeLogicalReceiverAdmitted(bind, new Set()), false)
  assert.equal(nativeLogicalReceiverAdmitted(bind, new Set([bind.source.value])), true)
  assert.equal(nativeLogicalReceiverAdmitted({ ...bind, thisArgument: null }, new Set()), true)
  assert.equal(
    nativeLogicalReceiverAdmitted({ ...bind, sourceAbi: { ...abi, receiver: array }, receiver: bind.thisArgument }, new Set()),
    true
  )
})

test('a template route requires the canonical source invocation and its actual callee producer', () => {
  const source = {
    id: 'host-call',
    family: 'invocation',
    internalMethod: 'call',
    results: [{ id: lineage, role: 'value' }],
    operands: [{ role: 'callee', ordinal: 0, source: { kind: 'result', result: 'host-method-read' } }]
  } as unknown as SemanticOperation
  const input = {
    graph: {
      operations: new Map<unknown, unknown>([
        [source.id, source],
        ['host-producer', { family: 'binding', action: 'read', declaration: 'host' }]
      ]),
      results: new Map([['host-method-read', 'host-producer']])
    },
    placements: new Map([['host', { storage: { kind: 'host-singleton' } }]]),
    hostMethodAliasDeclarations: new Set()
  } as unknown as CalleeRenderingInput
  const producer: IrOperation = {
    kind: 'binding-read',
    lineage: 'host-method-read' as never,
    declaration: 'host' as never,
    result: result('callee', callable)
  }
  const definitionOf = (value: typeof call.callee.value): IrOperation | null => (value === call.callee.value ? producer : null)
  assert.equal(authenticatedTemplateCallEntry(call, source, input, definitionOf), true)
  assert.equal(authenticatedTemplateCallEntry(call, { ...source }, input, definitionOf), false)
  assert.equal(
    authenticatedTemplateCallEntry(call, source, input, () => ({ ...producer, lineage: 'unrelated' as never })),
    false
  )
  assert.equal(
    authenticatedTemplateCallEntry(call, source, input, () => null),
    false
  )
})

test('an optional template callee aliases its value only with the sealed always-present fact', () => {
  const source = {
    id: 'host-call',
    family: 'invocation',
    internalMethod: 'call',
    results: [{ id: lineage, role: 'value' }],
    operands: [{ role: 'callee', ordinal: 0, source: { kind: 'result', result: 'host-method-short-circuit' } }]
  } as unknown as SemanticOperation
  const property = {
    id: 'host-producer',
    family: 'property',
    internalMethod: 'get',
    hostMethod: { protocol: 'test::Math', member: 'abs' },
    shortCircuitAlwaysPresent: true,
    results: [
      { id: 'host-method-value', role: 'value' },
      { id: 'host-method-short-circuit', role: 'short-circuit' }
    ]
  }
  const operations = new Map<unknown, unknown>([
    [source.id, source],
    [property.id, property]
  ])
  const input = {
    graph: { operations, results: new Map([['host-method-short-circuit', property.id]]) },
    plan: { selected: new Map() },
    hostMembers: new Map([['test::Math.abs', { kind: 'method', arity: 1, emit: 'test::abs({arg0})' }]])
  } as unknown as CalleeRenderingInput
  const producer: GetOperation = {
    kind: 'get',
    lineage: 'host-method-value' as never,
    receiver: operand('math', dynamic),
    key: operand('abs', { kind: 'string' }),
    result: result('callee', callable)
  }
  const definitionOf = (value: typeof call.callee.value): IrOperation | null => (value === call.callee.value ? producer : null)
  assert.equal(authenticatedTemplateCallEntry(call, source, input, definitionOf), true)
  operations.set(property.id, { ...property, shortCircuitAlwaysPresent: undefined })
  assert.equal(authenticatedTemplateCallEntry(call, source, input, definitionOf), false)
  operations.set(property.id, { ...property, results: [property.results[1]] })
  assert.equal(authenticatedTemplateCallEntry(call, source, input, definitionOf), false)
  operations.set(property.id, property)
  assert.equal(
    authenticatedTemplateCallEntry(call, source, input, () => ({ ...producer, lineage: 'unrelated' as never })),
    false
  )
})

test('shared native containers support receiver-dependent erased call and bind routes', () => {
  const cases = [
    ['array', `const receiver = [1, 2]; console.log(read.call(receiver))`],
    ['dictionary', `const receiver: Record<string, number> = { length: 2 }; console.log(read.call(receiver))`],
    ['bound-array', `const receiver = [1, 2]; const bound = read.bind(receiver); console.log(bound())`],
    ['dictionary-member', `const handlers: Record<string, () => number> = { read }; console.log(handlers.read())`],
    ['array-element', `const handlers: (() => number)[] = [read]; console.log(handlers[0]())`]
  ]
  for (const [name, invocation] of cases) {
    const entry = resolve(`test/runtime/native-logical-receiver-${name}.ts`)
    const compiled = compile({
      rootFileNames: [entry],
      projectFileName: null,
      closedScriptScope: true,
      sourceOverlay: new Map([
        [
          entry,
          `function inspect(this: any): number { return this.length }
        const dynamic: any = inspect
        const holder: { read(): number } = { read: dynamic }
        const read = holder.read
        ${invocation}`
        ]
      ])
    })
    assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
    assert.notEqual(compiled.certificate, null, `${name}: ${JSON.stringify(compiled.refusals)}`)
    assert.notEqual(compiled.source, null, `${name}: ${JSON.stringify(compiled.emissionRefusals)}`)
  }
})

test('native physical calls and supported reference logical receivers remain executable', () => {
  const entry = resolve('test/runtime/native-physical-array-this.ts')
  const physical = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    sourceOverlay: new Map([
      [
        entry,
        `function size(this: number[]): number { return this.length }
      console.log(size.call([1, 2]))`
      ]
    ])
  })
  assert.equal(physical.diagnostics.clean, true, JSON.stringify(physical.diagnostics.diagnostics))
  assert.notEqual(physical.certificate, null, JSON.stringify(physical.refusals))
  assert.notEqual(physical.source, null, JSON.stringify(physical.emissionRefusals))
  const references = compile({
    rootFileNames: [resolve('test/runtime/dynamic-method-logical-receiver.runtime.ts')],
    projectFileName: null,
    closedScriptScope: true
  })
  assert.notEqual(references.certificate, null, JSON.stringify(references.refusals))
  assert.notEqual(references.source, null, JSON.stringify(references.emissionRefusals))
})

test('erased primitive receivers and independent container receivers retain valid source semantics', () => {
  const entry = resolve('test/runtime/native-supported-logical-receivers.ts')
  const compiled = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    sourceOverlay: new Map([
      [
        entry,
        `function observe(this: any): string { return typeof this }
      function answer(): number { return 7 }
      const dynamicObserve: any = observe
      const dynamicAnswer: any = answer
      const holder: { observe(): string; answer(): number } = { observe: dynamicObserve, answer: dynamicAnswer }
      const read = holder.observe
      console.log(read.call(42))
      console.log(read.call('text'))
      console.log(read.call(null))
      console.log(read.call(undefined))
      console.log(holder.answer.call([1, 2]))`
      ]
    ])
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  assert.notEqual(compiled.certificate, null, JSON.stringify(compiled.refusals))
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.emissionRefusals))
})

test('readonly native host Function rows state receiver irrelevance explicitly', () => {
  const read = {
    kind: 'get',
    lineage,
    hostMethod: { protocol: 'DateConstructor', member: 'now' },
    receiver: operand('receiver', dynamic),
    key: operand('key', { kind: 'string' }),
    result: result('callee', callable)
  } as GetOperation
  assert.equal(hostReadIgnoresLogicalReceiver(read, hosts), true)
  assert.equal(rewrittenCall(body('root', [read, call])).thisArgument, undefined)
  const unknown = { ...read, hostMethod: { protocol: 'UnknownConstructor', member: 'now' } }
  assert.equal(hostReadIgnoresLogicalReceiver(unknown, hosts), false)
  assert.deepEqual(rewrittenCall(body('root', [unknown, call])).thisArgument, call.thisArgument)
  for (const [protocol, member] of [
    ['Math', 'abs'],
    ['Math', 'round'],
    ['Math', 'max'],
    ['Math', 'min'],
    ['Math', 'random'],
    ['StringConstructor', 'fromCharCode'],
    ['StringConstructor', 'fromCodePoint']
  ])
    assert.equal(
      hostReadIgnoresLogicalReceiver({ ...read, hostMethod: { protocol: protocol!, member: member! } }, hosts),
      true,
      `${protocol}.${member}`
    )
})

test('verified native Math and String Function values retain their callable and numeric-rest entries', () => {
  const entry = resolve('test/runtime/readonly-host-logical-receivers.ts')
  const compiled = compile({
    rootFileNames: [entry],
    projectFileName: null,
    closedScriptScope: true,
    sourceOverlay: new Map([
      [
        entry,
        `const absolute = Math.abs
      const maximum = Math.max
      const fromCode = String.fromCharCode
      const fromPoint = String.fromCodePoint
      console.log(absolute.call([1], -2))
      console.log(maximum.call([1], 2, 3))
      console.log(fromCode.call([1], 65))
      console.log(fromPoint.call([1], 66))
      console.log(Math.abs(-3))
      console.log(Math.max(1, 2))
      console.log(String.fromCharCode(67))`
      ]
    ])
  })
  assert.equal(compiled.diagnostics.clean, true, JSON.stringify(compiled.diagnostics.diagnostics))
  assert.notEqual(compiled.certificate, null, JSON.stringify(compiled.refusals))
  assert.notEqual(compiled.source, null, JSON.stringify(compiled.emissionRefusals))
})

test('retained dormant specializations preserve exact host property receiver metadata without entering their effects', () => {
  const numeric: Representation = { kind: 'scalar', domain: 'number' }
  const math: Representation = { kind: 'native-handle', protocol: 'Math', native: null, version: 1, bases: [], call: null, construct: null }
  const entryAbi: CallableAbi = {
    receiver: null,
    parameters: [
      {
        value: { kind: 'array-object', element: numeric, extension: null, ownership: 'shared-refcount' },
        ownership: 'shared-refcount',
        passing: 'by-value'
      }
    ],
    restFrom: 0,
    result: numeric
  }
  const functionValue: Representation = { kind: 'function-value-dispatch', abi: entryAbi }
  const key: IrNonTerminatorOperation = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'min',
    result: result('math-key', { kind: 'string' })
  }
  const read: GetOperation = {
    kind: 'get',
    lineage,
    receiver: operand('math', math),
    key: operand('math-key', { kind: 'string' }),
    result: result('math-min', functionValue)
  }
  const numericCall: CallOperation = {
    ...call,
    callee: operand('math-min', functionValue),
    thisArgument: operand('math', math),
    arguments: [operand('first', numeric), operand('second', numeric)],
    numericRestHostCall: { protocol: 'Math', member: 'min' },
    result: result('minimum', numeric)
  }
  const dormant = body('dormant', [key, read, numericCall], abi)
  const allocation: IrNonTerminatorOperation = {
    kind: 'allocate-callable',
    lineage,
    functionId: 'dormant' as never,
    captures: [],
    result: result('dormant-function', callable)
  }
  const root = body('root', [allocation])
  const input = new Map([root, dormant].map((value) => [value.owner, value]))
  const rewritten = publishLogicalReceivers(input, new Map(), new Map(), census, deriver, hosts)
  const retained = rewritten.get(dormant.owner)!
  const actual = retained.blocks.get(retained.entry)!.operations.find((operation) => operation.kind === 'call')! as CallOperation
  const flow = nativeCallableFlowOf([...rewritten.values()], new Map(), new Map(), census)
  assert.equal(flow.enteredBodies.has(dormant.owner), false)
  assert.equal(flow.ignoredLogicalReceiverValues.has(read.result.id), true)
  assert.equal(actual.thisArgument, undefined)
  assert.deepEqual(actual.arguments, numericCall.arguments)
  assert.deepEqual(actual.numericRestHostCall, numericCall.numericRestHostCall)
  assert.equal(actual.result, numericCall.result)

  const unknownRead: GetOperation = { ...read, receiver: operand('unknown', dynamic) }
  const unknown = publishLogicalReceivers(
    new Map([root, body('dormant', [key, unknownRead, numericCall], abi)].map((value) => [value.owner, value])),
    new Map(),
    new Map(),
    census,
    deriver,
    hosts
  )
  const rejected = unknown
    .get(dormant.owner)!
    .blocks.get(dormant.entry)!
    .operations.find((operation) => operation.kind === 'call')!
  assert.equal(rejected.kind, 'call')
  if (rejected.kind === 'call') assert.deepEqual(rejected.thisArgument, numericCall.thisArgument)
})

test('core host reads use their authenticated receiver protocol and exact key without a plugin binding', () => {
  const receiver: Representation = {
    kind: 'native-handle',
    protocol: 'DateConstructor',
    native: null,
    version: 1,
    bases: [],
    call: null,
    construct: null
  }
  const key: IrNonTerminatorOperation = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'now',
    result: result('key', { kind: 'string' })
  }
  const read: GetOperation = {
    kind: 'get',
    lineage,
    receiver: operand('receiver', receiver),
    key: operand('key', { kind: 'string' }),
    result: result('callee', callable)
  }
  assert.equal(hostReadIgnoresLogicalReceiver(read, hosts, 'now'), true)
  assert.equal(rewrittenCall(body('root', [key, read, call])).thisArgument, undefined)
  assert.equal(hostReadIgnoresLogicalReceiver(read, hosts, 'parse'), false)
  assert.equal(hostReadIgnoresLogicalReceiver(read, hosts), false)
  assert.equal(hostReadIgnoresLogicalReceiver({ ...read, receiver: operand('receiver', dynamic) }, hosts, 'now'), false)
})
