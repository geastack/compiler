import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { allOperationsOf } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { hostTemplateOfRead } from '../representation/host-templates.js'
import {
  closedCallFrameOf,
  hostConstructFrameOf,
  hostTemplateFrameOf,
  nativeArgumentsMatch,
  nativeCallFrameOf,
  objectAssignFieldPairsOf,
  publishObjectAssignFieldConversions,
  publishOmittedArgumentConversions,
  receivableArguments
} from './call-entry.js'
import { conversionNodeIdOf, createConversionNodes } from '../conversion/nodes.js'
import { transfersNativeStorage } from '../conversion/algebra.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { explicitObjectConstructEntryOf } from './construct-entry.js'
import { reflectionExposureOf } from './reflection-demand.js'
import type { CallOperation, ConstructOperation, IrBody, IrOperation } from './model.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const record: Representation = { kind: 'record', shapeId: 'entry-result', fields: [], accessors: [], ownership: 'owned' }
const functionId = 'entry-function' as never
const abi: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const identity = { kind: 'exact', functionId } as const
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })

test('omitted optional formals need a native undefined conversion and never stand in for a rest frame', () => {
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: number }
  const convention: CallableAbi = { ...abi, parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }] }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(nativeArgumentsMatch(convention, [], conversions), false)
  conversions.nodeFor({ kind: 'undefined' }, optional)
  assert.equal(nativeArgumentsMatch(convention, [], conversions), true)
  assert.equal(nativeArgumentsMatch(convention, []), false)
  assert.equal(nativeArgumentsMatch({ ...convention, restFrom: 0 }, [], conversions), false)
  assert.equal(
    nativeArgumentsMatch({ ...convention, parameters: [{ value: record, ownership: 'owned', passing: 'by-value' }] }, [], conversions),
    false
  )
  assert.equal(nativeArgumentsMatch(convention, [operand('wrong', record)], conversions), false)
})
const call = (convention = abi): CallOperation => ({
  kind: 'call',
  lineage: 'entry-lineage' as never,
  callee: operand('callee', { kind: 'function-value-dispatch', abi: convention }),
  receiver: null,
  arguments: [operand('evaluated-object', record)],
  result: { id: 'result' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
})
const construct = (result: Representation = record): ConstructOperation => {
  const convention = { ...abi, result }
  const callee = operand('constructor', { kind: 'function-value-dispatch', abi: convention })
  return {
    kind: 'construct',
    lineage: 'entry-lineage' as never,
    callee,
    newTarget: callee,
    target: { kind: 'exact', target: { kind: 'function', functionId, constructable: true }, evidence: [] },
    arguments: [],
    result: { id: 'constructed' as never, representation: result }
  }
}

test('a known fixed frame ignores extra evaluated arguments and an unobserved result', () => {
  const operation = call()
  assert.deepEqual(
    closedCallFrameOf(operation, identity, () => abi, new Set()),
    {
      abi,
      receivedArguments: 0,
      result: 'ignored'
    }
  )
  assert.equal(operation.arguments.length, 1)
  assert.deepEqual(receivableArguments(abi, operation.arguments), [])
})

test('closed call frames consume published omitted-argument conversions for exact and virtual entries', () => {
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: number }
  const convention: CallableAbi = { ...abi, parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }] }
  const operation = { ...call(convention), arguments: [] }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const identities = [identity, { kind: 'closed-family', functionIds: [functionId], nativeEntryAbi: convention }] as const
  for (const entry of identities)
    assert.equal(
      closedCallFrameOf(operation, entry, () => convention, new Set(), conversions),
      undefined
    )
  conversions.nodeFor({ kind: 'undefined' }, optional)
  for (const entry of identities) {
    assert.deepEqual(
      closedCallFrameOf(operation, entry, () => convention, new Set(), conversions),
      {
        abi: convention,
        receivedArguments: 0,
        result: 'ignored'
      }
    )
    assert.equal(
      closedCallFrameOf(operation, entry, () => convention, new Set()),
      undefined
    )
    assert.equal(
      closedCallFrameOf({ ...operation, arguments: [operand('wrong', record)] }, entry, () => convention, new Set(), conversions),
      undefined
    )
  }
})

test('unknown bodies, spread arguments and mismatched held conventions stay open', () => {
  assert.equal(
    closedCallFrameOf(call(), undefined, () => abi, new Set()),
    undefined
  )
  assert.equal(
    closedCallFrameOf(call(), identity, () => null, new Set()),
    undefined
  )
  assert.equal(
    closedCallFrameOf({ ...call(), argumentsAreSpread: true }, identity, () => abi, new Set()),
    undefined
  )
  assert.equal(
    closedCallFrameOf(call({ ...abi, result: number }), identity, () => abi, new Set()),
    undefined
  )
})

test('a body with rest or implicit arguments retains every supplied operand', () => {
  const restAbi = { ...abi, restFrom: 0 }
  const operation = call(restAbi)
  assert.equal(receivableArguments(restAbi, operation.arguments), operation.arguments)
  assert.equal(
    closedCallFrameOf(operation, identity, () => restAbi, new Set()),
    undefined
  )
})

test('an observed mismatched result cannot borrow the unused-result disposition', () => {
  const operation = call()
  const observedNumber = { ...operation, result: { ...operation.result!, representation: number } }
  assert.equal(
    closedCallFrameOf(observedNumber, identity, () => abi, new Set([operation.result!.id])),
    undefined
  )
  // A void convention's `undefined` is read into either spelling of it: the
  // program's own `undefined`, or `dynamic` where it typed the call `any`.
  for (const representation of [{ kind: 'undefined' } as const, operation.result!.representation]) {
    const read = { ...operation, result: { ...operation.result!, representation } }
    assert.equal(closedCallFrameOf(read, identity, () => abi, new Set([operation.result!.id]))?.result, 'undefined')
  }
})

test('a closed family must agree on its complete convention', () => {
  const family = { kind: 'closed-family', functionIds: [functionId, 'other-function' as never] } as const
  assert.equal(
    closedCallFrameOf(call(), family, (id) => (id === functionId ? abi : { ...abi, result: number }), new Set()),
    undefined
  )
})

test('a dispatch-census native entry uses the root receiver while checking the held frame', () => {
  const receiver: Representation = {
    kind: 'class-ref',
    declaration: 'Base' as never,
    shapeId: 'Base',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const convention = { ...abi, receiver }
  const implementation = {
    ...convention,
    receiver: { ...receiver, declaration: 'Derived' as never, shapeId: 'Derived', ancestors: ['Base' as never] }
  }
  const operation = { ...call(convention), receiver: operand('receiver', receiver) }
  const family = { kind: 'closed-family' as const, functionIds: [functionId], nativeEntryAbi: convention }
  assert.deepEqual(
    closedCallFrameOf(operation, family, () => implementation, new Set()),
    {
      abi: convention,
      receivedArguments: 0,
      result: 'ignored'
    }
  )
  assert.equal(
    closedCallFrameOf(operation, family, () => null, new Set()),
    undefined
  )
  assert.equal(
    closedCallFrameOf(operation, { ...family, nativeEntryAbi: implementation }, () => implementation, new Set()),
    undefined
  )
  assert.equal(
    closedCallFrameOf({ ...operation, argumentsAreSpread: true }, family, () => implementation, new Set()),
    undefined
  )
})

const classRef = (name: string, ancestors: readonly string[] = []): Representation => ({
  kind: 'class-ref',
  declaration: name as never,
  shapeId: name,
  ownership: 'shared-refcount',
  ancestors: ancestors as never
})
const unionOf = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: 'object',
    value,
    semanticType: `arm-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' } as const
  }))
})

test('a union receiver publishes its native sum selection before the reflection census reads the frame', () => {
  const base = classRef('Base')
  const union = unionOf(classRef('Left', ['Base']), classRef('Right', ['Base']))
  const convention: CallableAbi = { ...abi, receiver: base }
  const operation: CallOperation = { ...call(convention), arguments: [], receiver: operand('receiver', union) }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  // Before publication the census holds no node, and the frame reads as open.
  assert.equal(conversions.nodeById(conversionNodeIdOf(union, base)), null)
  assert.equal(nativeCallFrameOf(operation, convention, new Set(), conversions, 'native-transfer'), undefined)
  publishOmittedArgumentConversions(operation, conversions)
  const node = conversions.nodeById(conversionNodeIdOf(union, base))
  assert.ok(node)
  assert.equal(transfersNativeStorage(node.capability), true)
  assert.deepEqual(nativeCallFrameOf(operation, convention, new Set(), conversions, 'native-transfer'), {
    abi: convention,
    receivedArguments: 0,
    result: 'ignored'
  })
})

test('template calls and non-union receivers publish no receiver selection; a non-native selection stays open', () => {
  const base = classRef('Base')
  const union = unionOf(classRef('Left', ['Base']), classRef('Right', ['Base']))
  const convention: CallableAbi = { ...abi, receiver: base }
  const operation: CallOperation = { ...call(convention), arguments: [], receiver: operand('receiver', union) }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  // A template spells its receiver itself; the frame's pair is never rendered.
  publishOmittedArgumentConversions({ ...operation, objectValueConversions: [] }, conversions)
  assert.equal(conversions.nodeById(conversionNodeIdOf(union, base)), null)
  // A single class receiver is converted by lowering when it converts at all.
  const left = classRef('Left', ['Base'])
  publishOmittedArgumentConversions({ ...operation, receiver: operand('receiver', left) }, conversions)
  assert.equal(conversions.nodeById(conversionNodeIdOf(left, base)), null)
  // A union with no class arm publishes a pair whose capability cannot carry
  // it natively, and the frame stays open.
  const mixed = unionOf(number, { kind: 'string' })
  const open = { ...operation, receiver: operand('receiver', mixed) }
  publishOmittedArgumentConversions(open, conversions)
  const node = conversions.nodeById(conversionNodeIdOf(mixed, base))
  assert.ok(node)
  assert.equal(transfersNativeStorage(node.capability), false)
  assert.equal(nativeCallFrameOf(open, convention, new Set(), conversions, 'native-transfer'), undefined)
})

test("a host construction publishes its selected frame's omitted formals, and only for its own new-target", () => {
  const message: Representation = { kind: 'optional', absence: 'undefined', payload: { kind: 'string' } }
  const options: Representation = { kind: 'optional', absence: 'undefined', payload: record }
  const frame: CallableAbi = {
    ...abi,
    parameters: [
      { value: message, ownership: 'owned', passing: 'by-value' },
      { value: options, ownership: 'owned', passing: 'by-value' }
    ],
    result: record
  }
  const handle: Representation = {
    kind: 'native-handle',
    protocol: 'ErrorConstructor',
    version: 1,
    native: null,
    bases: [],
    call: null,
    construct: null
  }
  const callee = operand('host-constructor', handle)
  const operation: ConstructOperation = {
    ...construct(),
    callee,
    newTarget: callee,
    arguments: [operand('message', message)],
    hostFrame: frame
  }
  const omitted = conversionNodeIdOf({ kind: 'undefined' }, options)
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(hostConstructFrameOf(operation), frame)
  // A different new-target is refused by emission; it publishes nothing.
  const redirected = { ...operation, newTarget: operand('other-constructor', handle) }
  assert.equal(hostConstructFrameOf(redirected), null)
  publishOmittedArgumentConversions(redirected, conversions)
  assert.equal(conversions.nodeById(omitted), null)
  assert.equal(nativeArgumentsMatch(frame, operation.arguments, conversions, 'native-transfer'), false)
  publishOmittedArgumentConversions(operation, conversions)
  assert.ok(conversions.nodeById(omitted))
  assert.equal(nativeArgumentsMatch(frame, operation.arguments, conversions, 'native-transfer'), true)
  // A handle whose overloads join into one convention is asked for that one.
  const joined: Representation = { ...handle, construct: { ...frame, parameters: frame.parameters.slice(0, 1) } }
  const own = operand('joined-constructor', joined)
  assert.deepEqual(hostConstructFrameOf({ ...operation, callee: own, newTarget: own }), {
    ...frame,
    parameters: frame.parameters.slice(0, 1)
  })
  // Any other callee keeps its own construct convention.
  assert.equal(hostConstructFrameOf(construct()), null)
})

test('an ordinary receiver-free object-return constructor publishes its closure call entry', () => {
  const operation = construct()
  const convention = { ...abi, result: record }
  assert.deepEqual(explicitObjectConstructEntryOf(operation, convention), {
    kind: 'explicit-object-return',
    functionId,
    abi: convention
  })
})

test('arrows, unknown constructors and a different newTarget never borrow an ordinary construct entry', () => {
  const operation = construct()
  const convention = { ...abi, result: record }
  assert.equal(
    explicitObjectConstructEntryOf(
      {
        ...operation,
        target: {
          kind: 'exact',
          target: { kind: 'function', functionId, constructable: false },
          evidence: []
        }
      },
      convention
    ),
    undefined
  )
  assert.equal(
    explicitObjectConstructEntryOf({ ...operation, newTarget: operand('other-constructor', operation.callee.representation) }, convention),
    undefined
  )
  assert.equal(explicitObjectConstructEntryOf(operation, null), undefined)
})

test('a primitive or possibly absent return cannot replace the constructed receiver', () => {
  for (const result of [
    number,
    { kind: 'optional', payload: record, absence: 'undefined' } as Representation,
    { kind: 'void' } as Representation
  ]) {
    assert.equal(explicitObjectConstructEntryOf(construct(result), { ...abi, result }), undefined)
  }
  assert.equal(explicitObjectConstructEntryOf(construct(), { ...abi, result: record, receiver: record }), undefined)
  const optionalCallable: Representation = { kind: 'function-value-family', members: [functionId], abi, optional: true }
  assert.equal(explicitObjectConstructEntryOf(construct(optionalCallable), { ...abi, result: optionalCallable }), undefined)
})

test('absent dynamic arguments publish no native payload; object boxing never inherits that contract', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const convention: CallableAbi = { ...abi, parameters: [{ value: dynamic, ownership: 'owned', passing: 'by-value' }] }
  for (const kind of ['undefined', 'null'] as const) {
    const node = conversions.nodeFor({ kind }, dynamic)
    assert.equal(node.capability.kind, 'atom')
    if (node.capability.kind !== 'atom') throw new Error('absence conversion missing')
    assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
    assert.equal(node.capability.materializer.allocates, false)
  }
  assert.equal(nativeArgumentsMatch(convention, [], conversions), true)
  const object = conversions.nodeFor(record, dynamic)
  assert.equal(object.capability.kind, 'atom')
  if (object.capability.kind !== 'atom') throw new Error('object conversion missing')
  assert.equal(object.capability.materializer.nativeFieldProtocol, undefined)
  assert.equal(object.capability.materializer.allocates, true)
})

const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const numbers: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const floats: Representation = { kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' }
const shapeOf = (shapeId: string, fields: readonly { readonly key: string; readonly value: Representation }[]): Representation => ({
  kind: 'record',
  shapeId,
  fields: fields.map((field) => ({ ...field, required: true })),
  accessors: [],
  ownership: 'shared-refcount'
})
/** A call the printer spells from `template`; its declared convention is the lib's `(arg: any) => boolean`. */
const templateCall = (
  template: CallOperation['hostTemplate'],
  args: readonly Representation[],
  result: Representation | null
): CallOperation => ({
  kind: 'call',
  lineage: 'entry-lineage' as never,
  callee: operand('template-callee', {
    kind: 'function-value-dispatch',
    abi: { ...abi, parameters: [{ value: dynamic, ownership: 'owned', passing: 'by-value' }], result: boolean }
  }),
  receiver: null,
  arguments: args.map((argument, index) => operand(`template-argument-${index}`, argument)),
  result: result === null ? null : { id: 'template-result' as never, representation: result },
  ...(template ? { hostTemplate: template } : {})
})
const templateBody = (operations: readonly IrOperation[]): IrBody => {
  const id = 'template-body' as IrBody['entry']
  return {
    owner: 'template-owner' as IrBody['owner'],
    sourceOwner: 'template-owner' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: id,
    blocks: new Map([[id, { id, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } as never }]]),
    blockOrder: [id],
    values: new Map(),
    tryRegions: []
  }
}

test('Array.isArray reads a non-dynamic argument in its own carrier and leaves a dynamic one to its convention', () => {
  const shape = shapeOf('is-array-shape', [{ key: 'x', value: number }])
  const tested = unionOf(shape, numbers)
  const frame = (operation: CallOperation) => hostTemplateFrameOf(operation, undefined, null, null)
  assert.equal(frame(templateCall('array-is-array', [tested], boolean)), true)
  assert.equal(frame(templateCall('array-is-array', [{ kind: 'optional', absence: 'undefined', payload: tested }], null)), true)
  // `isArrayText` hands a `gea::Value` to the runtime's own overload: that IS
  // the `(arg: any)` convention, which keeps deciding such a call.
  assert.equal(frame(templateCall('array-is-array', [dynamic], boolean)), undefined)
  assert.equal(frame(templateCall('array-is-array', [unionOf(shape, dynamic)], boolean)), undefined)
  assert.equal(frame(templateCall('array-is-array', [tested], dynamic)), undefined)
  assert.equal(frame(templateCall('array-is-array', [tested, tested], boolean)), undefined)
  assert.equal(frame(templateCall(undefined, [tested], boolean)), undefined)
  const level = (operations: readonly IrOperation[]) =>
    reflectionExposureOf([templateBody(operations)], new Map(), null, { representations: [shape], shakeComplete: true }).records.get(
      'is-array-shape' as never
    )?.level
  assert.equal(level([templateCall('array-is-array', [tested], boolean)]), level([]))
  assert.equal(level([templateCall(undefined, [tested], boolean)]), 'full')
  const mixed = unionOf(shape, dynamic)
  assert.equal(level([templateCall('array-is-array', [mixed], boolean)]), level([templateCall(undefined, [mixed], boolean)]))
})

test('TypedArray.prototype.set copies a typed or numeric-array source in place and refuses what its template does not print', () => {
  const set = (args: readonly Representation[], result: Representation | null = { kind: 'undefined' }) =>
    hostTemplateFrameOf(templateCall('typed-array-set', args, result), undefined, null, null)
  assert.equal(set([floats]), true)
  assert.equal(set([numbers, number]), true)
  assert.equal(set([unionOf(floats, numbers)], null), true)
  assert.equal(set([{ kind: 'array-object', element: { kind: 'string' }, ownership: 'shared-refcount', extension: null }]), false)
  assert.equal(set([unionOf(floats, dynamic)]), false)
  assert.equal(set([floats, { kind: 'optional', absence: 'undefined', payload: number }]), false)
  assert.equal(set([floats, number, number]), false)
  assert.equal(set([floats], dynamic), false)
  assert.equal(set([]), false)
})

test('Object.assign closes only the struct copies and Function-object stores its template keeps native', () => {
  // Record operands never ask the deriver: their fields are on the carrier.
  const deriver = {} as RepresentationDeriver
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const frame = (operation: CallOperation) => hostTemplateFrameOf(operation, conversions, deriver, null)
  const target = shapeOf('assign-target', [
    { key: 'x', value: number },
    { key: 'y', value: { kind: 'optional', absence: 'undefined', payload: number } }
  ])
  const assign = (args: readonly Representation[], result: Representation | null = target) => templateCall('object-assign', args, result)
  const same = shapeOf('assign-same', [{ key: 'x', value: number }])
  assert.equal(frame(assign([target, same])), true)
  assert.equal(frame(assign([target, unionOf(same, { kind: 'null' })], null)), true)
  assert.equal(frame(assign([target, { kind: 'optional', absence: 'undefined', payload: same }])), true)
  // A slot whose carrier differs closes only through a published native node.
  const widening = shapeOf('assign-widening', [{ key: 'y', value: number }])
  const operands = [operand('assign-target', target), operand('assign-widening', widening)]
  assert.equal(frame(assign([target, widening])), false)
  assert.deepEqual(
    objectAssignFieldPairsOf(operands, deriver, null)?.map((pair) => [pair.source.kind, pair.target.kind]),
    [['scalar', 'optional']]
  )
  publishObjectAssignFieldConversions(operands, deriver, null, conversions)
  assert.equal(frame(assign([target, widening])), true)
  // Everything the template does not print as a native slot copy stays open:
  // a key with no declared slot (boxed into the sidecar), the runtime-walked
  // dynamic and dictionary sources, a result that is not the target, and a
  // call the census cannot state at all.
  assert.equal(frame(assign([target, shapeOf('assign-stray', [{ key: 'z', value: number }])])), false)
  assert.equal(frame(assign([target, dynamic])), false)
  assert.equal(frame(assign([target, { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' }])), false)
  assert.equal(frame(assign([target, same], dynamic)), false)
  assert.equal(frame(assign([target])), false)
  assert.equal(frame({ ...assign([target, same]), argumentsAreSpread: true }), false)
  assert.equal(hostTemplateFrameOf(assign([target, same]), conversions, null, null), false)

  // Into a Function object every source field is stored as a `gea::Value`:
  // closed only when each cited conversion keeps that value native.
  const callable: Representation = { kind: 'function-value-dispatch', abi }
  const owner = classRef('AssignOwner')
  const boxing = conversions.nodeFor(owner, dynamic)
  assert.equal(transfersNativeStorage(boxing.capability), false)
  const cite = (field: string, value: Representation) => ({
    role: 'callable-property' as const,
    argument: 1,
    field,
    source: value,
    target: dynamic,
    conversion: conversions.nodeFor(value, dynamic).id
  })
  const intoCallable = (source: Representation, citations: CallOperation['objectValueConversions']): CallOperation => ({
    ...assign([callable, source], callable),
    ...(citations ? { objectValueConversions: citations } : {})
  })
  assert.equal(frame(intoCallable(shapeOf('assign-boxed', [{ key: 'owner', value: owner }]), [cite('owner', owner)])), false)
  const held = shapeOf('assign-held', [{ key: 'value', value: dynamic }])
  assert.equal(frame(intoCallable(held, [cite('value', dynamic)])), true)
  assert.equal(frame(intoCallable(held, undefined)), false)
})

test('lowering records the host template the printer spells Object.assign, Array.isArray and TypedArray.set from', () => {
  const entry = resolve('test/runtime/projected-method-overrides.ts')
  const source = `
class Holder { x = 1 }
const lookalike = { isArray: (value: unknown): boolean => value === null }
function run(values: Float32Array, list: number[], either: Holder | number[], holder: Holder, loose: any): boolean {
  values.set(list, 0)
  Object.assign(holder, { x: 2 })
  return Array.isArray(either) && Array.isArray(loose) && !lookalike.isArray(either)
}
console.log(run(new Float32Array(4), [1, 2], [3], new Holder(), JSON.parse('[1]')))
`
  const result = compile({ rootFileNames: [entry], projectFileName: null, sourceOverlay: new Map([[entry, source]]), includeIr: true })
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => allOperationsOf(block)))
  const producers = new Map(
    operations.flatMap((operation) => {
      const produced = resultOfIrOperation(operation)
      return produced ? [[produced.id, operation] as const] : []
    })
  )
  const calls = operations.filter((operation): operation is CallOperation => operation.kind === 'call')
  const templated = calls.filter((call) => call.hostTemplate !== undefined)
  // `lookalike.isArray` is a record's own method, whose convention is its frame.
  assert.deepEqual(templated.map((call) => call.hostTemplate).sort(), [
    'array-is-array',
    'array-is-array',
    'object-assign',
    'typed-array-set'
  ])
  // One authority: what lowering recorded is `hostTemplateOfRead` asked of the
  // very read the printer defers -- its receiver, member and read carrier.
  for (const call of calls) {
    const read = producers.get(call.callee.value)
    if (read?.kind !== 'get') continue
    const key = producers.get(read.key.value)
    if (key?.kind !== 'constant' || key.literal !== 'string') continue
    assert.equal(hostTemplateOfRead(read.receiver.representation, key.text, read.result.representation) ?? undefined, call.hostTemplate)
  }
  // And the printer spelled each call from the template whose frame the IR
  // states: in place for the typed carriers, the `gea::Value` overload only
  // for the argument the frame leaves to its convention.
  const cpp = result.source ?? ''
  assert.ok(cpp.includes('->setFromArray('), 'TypedArray.set of a number[] renders setFromArray')
  assert.equal(cpp.split('gea::host::ArrayConstructor::isArray(').length - 1, 1, 'only the dynamic argument reaches the Value overload')
  const frames = templated
    .filter((call) => call.hostTemplate !== 'object-assign')
    .map((call) => [call.arguments[0]!.representation.kind, hostTemplateFrameOf(call, undefined, null, null)])
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
  assert.deepEqual(frames, [
    ['array-object', true],
    ['dynamic', undefined],
    ['tagged-union', true]
  ])
})
