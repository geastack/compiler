import assert from 'node:assert/strict'
import test from 'node:test'
import { closedRecordCallablesOf } from './callable-records.js'
import { fillCallDispatchTargets } from './call-dispatch.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand, IrOperation } from './model.js'
import type { Representation, CallableAbi } from '../representation/model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const abi: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: number }
const callable: Representation = { kind: 'function-value-dispatch', abi }
const record: Representation = {
  kind: 'record',
  shapeId: 'table-shape' as never,
  fields: [{ key: 'run', value: callable, required: true }],
  accessors: [],
  ownership: 'owned'
}
const operand = (value: string, representation: Representation = record): IrOperand => ({ value: value as never, representation })
const result = (id: string, representation: Representation = record) => ({ id: id as never, representation })
const key: Extract<IrNonTerminatorOperation, { kind: 'constant' }> = {
  kind: 'constant',
  lineage: 'callable-record-test' as never,
  text: 'run',
  literal: 'string',
  result: result('key', string)
}
const allocateFunction = (id = 'fn', functionId = 'implementation'): IrNonTerminatorOperation => ({
  kind: 'allocate-callable',
  lineage: 'callable-record-test' as never,
  functionId: functionId as never,
  captures: [],
  result: result(id, callable)
})
const allocate = (id = 'table', fn = 'fn'): IrNonTerminatorOperation => ({
  kind: 'allocate-record',
  lineage: 'callable-record-test' as never,
  fields: [{ key: 'run', value: operand(fn, callable) }],
  result: result(id)
})
const read = (receiver = 'table', id = 'method', keyId = 'key'): IrNonTerminatorOperation => ({
  kind: 'get',
  lineage: 'callable-record-test' as never,
  receiver: operand(receiver),
  key: operand(keyId, string),
  result: result(id, callable)
})
const call = (
  callee = 'method',
  arguments_: IrOperand[] = [],
  receiver: IrOperand | null = null
): Extract<IrNonTerminatorOperation, { kind: 'call' }> =>
  ({
    kind: 'call',
    lineage: 'callable-record-test' as never,
    callee: operand(callee, callable),
    arguments: arguments_,
    receiver,
    result: result('called', number)
  }) as never
const write = (declaration: string, value: IrOperand): IrNonTerminatorOperation => ({
  kind: 'binding-write',
  lineage: 'callable-record-test' as never,
  declaration: declaration as never,
  value
})
const bindingRead = (declaration: string, id: string): IrNonTerminatorOperation => ({
  kind: 'binding-read',
  lineage: 'callable-record-test' as never,
  declaration: declaration as never,
  result: result(id)
})
const bodyOf = (operations: readonly IrNonTerminatorOperation[], owner = 'entry', returned: IrOperand | null = null): IrBody => {
  const entry = `${owner}-block` as never
  return {
    owner: owner as never,
    sourceOwner: owner as never,
    abi: returned ? { ...abi, result: returned.representation } : null,
    construct: null,
    entry,
    blocks: new Map([
      [entry, { id: entry, operations, terminator: { kind: 'return', lineage: 'callable-record-test' as never, value: returned } }]
    ]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const placements = new Map([['alias' as never, { representation: record, storage: { kind: 'local', owner: 'entry' } } as never]])
const facts = (operations: readonly IrNonTerminatorOperation[]) =>
  closedRecordCallablesOf([bodyOf(operations)], placements, new Map(), null)
const exact = { kind: 'exact', functionId: 'implementation' }
const initial = () => [key, allocateFunction(), allocate()]

test('an immutable own field carries implementation identity without direct dispatch', () => {
  const body = bodyOf([...initial(), read(), call()])
  const filled = fillCallDispatchTargets(
    new Map([[body.owner, body]]),
    placements,
    new Map(),
    () => abi,
    () => false,
    { families: [], refused: [], dispatched: new Map() }
  )
  const operations = filled.get(body.owner)!.blocks.get(body.entry)!.operations
  const get = operations.at(-2) as Extract<IrOperation, { kind: 'get' }>
  const invocation = operations.at(-1) as Extract<IrOperation, { kind: 'call' }>
  assert.deepEqual(get.closedCallable, exact)
  assert.deepEqual(invocation.closedCallee, exact)
  assert.equal(invocation.target, undefined)
})

test('record identity survives a known local alias', () => {
  assert.deepEqual(
    facts([...initial(), write('alias', operand('table')), bindingRead('alias', 'loaded'), read('loaded')]).get('method' as never),
    exact
  )
})

test('a write through an alias revokes all field identities', () => {
  const mutation: IrNonTerminatorOperation = {
    kind: 'set',
    lineage: 'callable-record-test' as never,
    receiver: operand('loaded'),
    key: operand('key', string),
    value: operand('other', callable),
    result: null
  } as never
  assert.equal(facts([...initial(), write('alias', operand('table')), bindingRead('alias', 'loaded'), mutation, read()]).size, 0)
})

test('an unknown write to the same binding revokes earlier known allocations', () => {
  assert.equal(
    facts([
      ...initial(),
      write('alias', operand('table')),
      write('alias', operand('external')),
      bindingRead('alias', 'loaded'),
      call('unknown', [operand('loaded')]),
      read()
    ]).size,
    0
  )
})

test('unknown calls and implicit receivers publish the object', () => {
  assert.equal(facts([...initial(), call('unknown', [operand('table')]), read()]).size, 0)
  assert.equal(facts([...initial(), read(), call('method', [], operand('table'))]).size, 0)
})

test('unknown and inherited property reads can invoke external accessors', () => {
  assert.equal(facts([...initial(), read('table', 'unknown-read', 'unknown-key'), read()]).size, 0)
  const inheritedKey = { ...key, text: 'inherited', result: result('inherited-key', string) }
  assert.equal(facts([...initial(), inheritedKey, read('table', 'inherited-read', 'inherited-key'), read()]).size, 0)
})

test('known record returns from a closed factory preserve field identity', () => {
  const factory = bodyOf(initial(), 'factory', operand('table'))
  const invoke = { ...call('factory-value'), result: result('factory-result') }
  const entry = bodyOf([allocateFunction('factory-value', 'factory'), invoke, read('factory-result')])
  const known = closedRecordCallablesOf([factory, entry], placements, new Map(), null)
  assert.deepEqual(known.get('method' as never), exact)
})

test('publishing a factory revokes identities of its returned allocations', () => {
  const factory = bodyOf(initial(), 'factory', operand('table'))
  const entry = bodyOf([
    allocateFunction('factory-value', 'factory'),
    call('unknown', [operand('factory-value', callable)]),
    { ...call('factory-value'), result: result('factory-result') },
    read('factory-result')
  ])
  assert.equal(closedRecordCallablesOf([factory, entry], placements, new Map(), null).size, 0)
})

test('handing a factory to an unknown constructor as newTarget publishes it', () => {
  const factory = bodyOf(initial(), 'factory', operand('table'))
  const expose: IrNonTerminatorOperation = {
    kind: 'construct',
    lineage: 'reflect-construct' as never,
    callee: operand('external', callable),
    newTarget: operand('factory-value', callable),
    arguments: [],
    target: { kind: 'unknown' },
    result: result('external-object')
  } as never
  const entry = bodyOf([
    allocateFunction('factory-value', 'factory'),
    expose,
    { ...call('factory-value'), result: result('factory-result') },
    read('factory-result')
  ])
  assert.equal(closedRecordCallablesOf([factory, entry], placements, new Map(), null).size, 0)
})

test('a factory alias outside the unique binding census is an escape', () => {
  const factory = bodyOf(initial(), 'factory', operand('table'))
  const entry = bodyOf([
    allocateFunction('factory-value', 'factory'),
    write('unproven-function-cell', operand('factory-value', callable)),
    { ...call('factory-value'), result: result('factory-result') },
    read('factory-result')
  ])
  assert.equal(closedRecordCallablesOf([factory, entry], placements, new Map(), null).size, 0)
})

const definition = (): IrNonTerminatorOperation => ({
  kind: 'define-own-property',
  lineage: 'callable-record-test' as never,
  receiver: operand('table'),
  key: operand('key', string),
  value: operand('fn', callable),
  attributes: { writable: true, enumerable: true, configurable: true },
  result: null
})
const empty = (): IrNonTerminatorOperation => ({
  kind: 'allocate-ordinary-object',
  lineage: 'callable-record-test' as never,
  result: result('table')
})
test('initial data definitions are accepted but definitions after publication revoke proof', () => {
  assert.deepEqual(facts([key, allocateFunction(), empty(), definition(), read()]).get('method' as never), exact)
  assert.equal(facts([key, allocateFunction(), empty(), write('alias', operand('table')), definition(), read()]).size, 0)
  assert.equal(facts([key, allocateFunction(), empty(), definition(), definition(), read()]).size, 0)
})

test('the final data-definition result preserves the returned object identity', () => {
  const initialized = { ...definition(), result: result('initialized') } as IrNonTerminatorOperation
  const factory = bodyOf([key, allocateFunction(), empty(), initialized], 'factory', operand('initialized'))
  const entry = bodyOf([
    allocateFunction('factory-value', 'factory'),
    { ...call('factory-value'), result: result('factory-result') },
    read('factory-result')
  ])
  assert.deepEqual(closedRecordCallablesOf([factory, entry], placements, new Map(), null).get('method' as never), exact)
  const mutation = {
    kind: 'set',
    lineage: 'mutation' as never,
    receiver: operand('initialized'),
    key: operand('key', string),
    value: operand('other', callable),
    result: null
  } as never
  assert.equal(facts([key, allocateFunction(), empty(), initialized, mutation, read()]).size, 0)
})

test('multiple proven allocations publish a closed implementation family', () => {
  const merge: IrNonTerminatorOperation = {
    kind: 'phi',
    lineage: 'callable-record-test' as never,
    incoming: [
      { predecessor: 'left', value: operand('table') },
      { predecessor: 'right', value: operand('second') }
    ],
    result: result('merged')
  } as never
  const known = facts([
    ...initial(),
    allocateFunction('other-fn', 'other-implementation'),
    allocate('second', 'other-fn'),
    merge,
    read('merged')
  ])
  assert.deepEqual(known.get('method' as never), { kind: 'closed-family', functionIds: ['implementation', 'other-implementation'] })
})

test('a constructor cannot authenticate an implicit receiver as a returned record', () => {
  const optional: Representation = { kind: 'optional', payload: record, absence: 'undefined' } as never
  const absent: IrNonTerminatorOperation = {
    kind: 'constant',
    lineage: 'callable-record-test' as never,
    text: 'undefined',
    literal: 'undefined',
    result: result('absent', optional)
  }
  const merge: IrNonTerminatorOperation = {
    kind: 'phi',
    lineage: 'optional-return' as never,
    incoming: [
      { predecessor: 'left', value: operand('table') },
      { predecessor: 'right', value: operand('absent', optional) }
    ],
    result: result('maybe-table', optional)
  } as never
  const factory = bodyOf([...initial(), absent, merge], 'factory', operand('maybe-table', optional))
  const construct: IrNonTerminatorOperation = {
    kind: 'construct',
    lineage: 'callable-record-test' as never,
    callee: operand('factory-value', callable),
    newTarget: operand('factory-value', callable),
    arguments: [],
    target: { kind: 'unknown' },
    result: result('factory-result')
  } as never
  const entry = bodyOf([allocateFunction('factory-value', 'factory'), construct, read('factory-result')])
  assert.equal(closedRecordCallablesOf([factory, entry], placements, new Map(), null).size, 0)
})

const receivingAbi: CallableAbi = {
  ...abi,
  parameters: [{ value: record, ownership: 'owned', passing: 'by-value' }]
}
const receivingCallable: Representation = { kind: 'function-value-dispatch', abi: receivingAbi }
const parameter: IrNonTerminatorOperation = {
  kind: 'parameter',
  lineage: 'record-parameter' as never,
  ordinal: 0,
  result: result('parameter')
}
const receive = (arguments_ = [operand('table')]): Extract<IrOperation, { kind: 'call' }> => ({
  ...call('consumer-value', arguments_),
  callee: operand('consumer-value', receivingCallable)
})
const consumerFunction = (): IrNonTerminatorOperation =>
  ({
    ...allocateFunction('consumer-value', 'consumer'),
    result: result('consumer-value', receivingCallable)
  }) as IrNonTerminatorOperation
const consumerBody = (operations: readonly IrNonTerminatorOperation[]): IrBody => ({
  ...bodyOf([parameter, ...operations], 'consumer'),
  abi: receivingAbi
})
const parameterFacts = (entry: readonly IrNonTerminatorOperation[] = [], consumer: readonly IrNonTerminatorOperation[] = []) =>
  closedRecordCallablesOf(
    [
      bodyOf([...initial(), consumerFunction(), receive(), ...entry, read()]),
      consumerBody([read('parameter', 'parameter-method'), ...consumer])
    ],
    placements,
    new Map(),
    null
  )

test('a record passed through a verified native entry retains allocation identity', () => {
  const known = parameterFacts()
  assert.deepEqual(known.get('method' as never), exact)
  assert.deepEqual(known.get('parameter-method' as never), exact)
})

test('mutation through a known parameter invalidates caller and callee reads', () => {
  const mutation: IrNonTerminatorOperation = {
    kind: 'set',
    lineage: 'parameter-mutation' as never,
    receiver: operand('parameter'),
    key: operand('key', string),
    value: operand('replacement', callable),
    result: null
  } as never
  assert.equal(parameterFacts([], [mutation]).size, 0)
  assert.equal(parameterFacts([], [call('unknown', [operand('parameter')])]).size, 0)
})

test('unknown incoming arguments or escaped consumers invalidate the complete parameter family', () => {
  assert.equal(parameterFacts([receive([operand('external')])]).size, 0)
  assert.equal(parameterFacts([call('unknown', [operand('consumer-value', receivingCallable)])]).size, 0)
  const badAbi = { ...receivingAbi, parameters: [{ value: number, ownership: 'owned' as const, passing: 'by-value' as const }] }
  assert.equal(
    parameterFacts([{ ...receive(), callee: operand('consumer-value', { kind: 'function-value-dispatch', abi: badAbi }) }]).size,
    0
  )
  assert.equal(parameterFacts([{ ...receive(), argumentsAreSpread: true }]).size, 0)
  assert.equal(parameterFacts([{ ...receive(), result: result('invalid-result') }, call('external', [operand('invalid-result')])]).size, 0)
})

test('closure capture transports the record while its body still revokes mutations and publications', () => {
  const closure: IrNonTerminatorOperation = {
    ...allocateFunction('closure-value', 'closure'),
    captures: [operand('table')]
  } as never
  const entry = bodyOf([...initial(), closure, call('external', [operand('closure-value', callable)]), read()])
  const inspect = bodyOf([read('table', 'captured-method')], 'closure')
  const known = closedRecordCallablesOf([entry, inspect], placements, new Map(), null)
  assert.deepEqual(known.get('method' as never), exact)
  assert.deepEqual(known.get('captured-method' as never), exact)
  const exposed = bodyOf([read('table')], 'closure', operand('table'))
  assert.equal(closedRecordCallablesOf([entry, exposed], placements, new Map(), null).size, 0)
  const unknown = bodyOf([call('external', [operand('table')])], 'closure')
  assert.equal(closedRecordCallablesOf([entry, unknown], placements, new Map(), null).size, 0)
  assert.equal(closedRecordCallablesOf([entry], placements, new Map(), null).size, 0)
})

test('ordinary constructor arguments use their construct entry and matching body formals', () => {
  const constructorAbi = { ...receivingAbi, result: record }
  const constructorValue: Representation = { kind: 'function-value-dispatch', abi: constructorAbi }
  const allocation = { ...consumerFunction(), result: result('consumer-value', constructorValue) } as IrNonTerminatorOperation
  const construct: Extract<IrOperation, { kind: 'construct' }> = {
    kind: 'construct',
    lineage: 'known-constructor' as never,
    callee: operand('consumer-value', constructorValue),
    newTarget: operand('consumer-value', constructorValue),
    target: { kind: 'exact', target: { kind: 'function', functionId: 'consumer' as never, constructable: true } },
    arguments: [operand('table')],
    result: result('constructed')
  } as never
  const consumer = { ...consumerBody([read('parameter', 'parameter-method')]), abi: constructorAbi }
  const entry = bodyOf([...initial(), allocation, construct, read()])
  const known = closedRecordCallablesOf([entry, consumer], placements, new Map(), null)
  assert.deepEqual(known.get('parameter-method' as never), exact)
  const unknown = { ...construct, target: { kind: 'open', evidence: [] } } as typeof construct
  assert.equal(
    closedRecordCallablesOf([bodyOf([...initial(), allocation, unknown, read()]), consumer], placements, new Map(), null).size,
    0
  )
})

const holder: Representation = {
  kind: 'class-ref',
  declaration: 'Holder' as never,
  shapeId: 'Holder-shape',
  ownership: 'shared-refcount',
  ancestors: []
}
const holderKey = { ...key, text: 'methods', result: result('holder-key', string) }
const holderConstructAbi = { ...abi, result: holder }
const holderConstructor: Representation = { kind: 'constructor-family', members: ['Holder' as never], abi: holderConstructAbi }
const createHolder = (): IrNonTerminatorOperation[] => [
  {
    kind: 'allocate-constructor',
    lineage: 'holder-constructor' as never,
    declaration: 'Holder' as never,
    captures: [],
    result: result('holder-constructor', holderConstructor)
  },
  {
    kind: 'construct',
    lineage: 'holder-allocation' as never,
    callee: operand('holder-constructor', holderConstructor),
    newTarget: operand('holder-constructor', holderConstructor),
    target: { kind: 'open', evidence: [] } as never,
    arguments: [],
    result: result('holder', holder)
  }
]
const holderStore = (value = 'table', resultId?: string): IrNonTerminatorOperation =>
  ({
    kind: 'set',
    lineage: 'holder-store' as never,
    receiver: operand('holder', holder),
    key: operand('holder-key', string),
    value: operand(value),
    result: resultId ? result(resultId) : null
  }) as never
const holderRead = (): IrNonTerminatorOperation => ({
  kind: 'get',
  lineage: 'holder-read' as never,
  receiver: operand('holder', holder),
  key: operand('holder-key', string),
  result: result('stored-methods')
})
const holderContext = (full = false, complete = true, initializer: string | null = null) => ({
  classes: new Map([
    [
      'Holder' as never,
      {
        declaration: 'Holder',
        base: null,
        nativeBase: null,
        constructor: null,
        construct: holderConstructAbi,
        instance: holder,
        fields: [{ key: 'methods', declaration: 'Holder.methods', representation: record, initializer }],
        nativeStorage: { fields: [{ key: 'methods', value: record, required: true }], omittedOverlays: [] },
        methods: [],
        accessors: [],
        staticFields: [],
        staticMethods: [],
        staticAccessors: [],
        fieldOwnership: []
      } as never
    ]
  ]),
  exposure: {
    complete,
    classes: new Map([
      [
        'Holder' as never,
        { level: full ? ('full' as const) : ('keys-only' as const), reasons: new Set<string>(), representations: new Set<string>() }
      ]
    ]),
    records: new Map(),
    byRepresentation: new Map()
  }
})
const holderFacts = (extra: readonly IrNonTerminatorOperation[] = [], context = holderContext()) =>
  closedRecordCallablesOf(
    [bodyOf([...initial(), ...createHolder(), holderKey, holderStore(), holderRead(), ...extra, read('stored-methods')])],
    placements,
    new Map(),
    null,
    undefined,
    context
  )

test('a closed native class field preserves its stored record identity', () => {
  assert.deepEqual(holderFacts().get('method' as never), exact)
  assert.equal(holderFacts([], holderContext(true)).size, 0)
  assert.equal(holderFacts([], holderContext(false, false)).size, 0)
})

test('native optional class references preserve field aliases through the cited wrap and presence load', () => {
  const optional: Representation = { kind: 'optional', payload: holder, absence: 'undefined' }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const wrap = conversions.nodeFor(holder, optional)
  const unwrap = conversions.nodeFor(optional, holder)
  const known = (foreign = false, mutate = false, full = false, missing = false) =>
    closedRecordCallablesOf(
      [
        bodyOf([
          ...initial(),
          ...createHolder(),
          holderKey,
          holderStore(),
          {
            kind: 'convert',
            lineage: 'optional-holder' as never,
            conversionUse: wrap.id,
            source: operand(foreign ? 'foreign-holder' : 'holder', holder),
            result: result('optional-holder', optional)
          },
          {
            kind: 'convert',
            lineage: 'present-holder' as never,
            conversionUse: unwrap.id,
            source: operand('optional-holder', optional),
            result: result('present-holder', holder)
          },
          { ...holderRead(), receiver: operand('present-holder', holder) } as IrNonTerminatorOperation,
          ...(mutate ? [call('external', [operand('stored-methods')])] : []),
          read('stored-methods')
        ])
      ],
      placements,
      new Map(),
      null,
      missing ? { nodeById: () => null } : conversions,
      holderContext(full)
    )
  assert.deepEqual(known().get('method' as never), exact)
  assert.equal(known(true).size, 0, 'a native wrapper does not establish the origin of a foreign object')
  assert.equal(known(false, true).size, 0, 'an alias obtained through the wrapper still participates in escape analysis')
  assert.equal(known(false, false, true).size, 0, 'reference transport does not waive the reflection proof')
  assert.equal(known(false, false, false, true).size, 0, 'the actual conversion citation is required')
})

test('class-field aliases retain record mutations and unknown replacement stores', () => {
  assert.equal(
    holderFacts([
      {
        kind: 'set',
        lineage: 'stored-record-mutation',
        receiver: operand('stored-methods'),
        key: operand('key', string),
        value: operand('external-function', callable),
        result: null
      } as never
    ]).size,
    0
  )
  assert.equal(holderFacts([holderStore('external-record')]).size, 0)
  assert.equal(holderFacts([call('external', [operand('stored-methods')])]).size, 0)
})

test('the result of a class-field assignment remains an observable alias', () => {
  assert.equal(holderFacts([holderStore('table', 'assigned'), call('external', [operand('assigned')])]).size, 0)
})

test('a class field initializer transports its returned record only for closed consumers', () => {
  const initializer = bodyOf(initial(), 'field-initializer', operand('table'))
  const entry = bodyOf([...createHolder(), holderKey, holderRead(), read('stored-methods')])
  for (const full of [false, true]) {
    const known = closedRecordCallablesOf(
      [entry, initializer],
      placements,
      new Map(),
      null,
      undefined,
      holderContext(full, true, 'field-initializer')
    )
    assert.equal(known.has('method' as never), !full)
  }
})

test('a typed foreign container is not allocation evidence for its callable record field', () => {
  const foreign: IrNonTerminatorOperation = {
    kind: 'parameter',
    lineage: 'foreign-input' as never,
    ordinal: 0,
    result: result('holder', holder)
  }
  const known = closedRecordCallablesOf(
    [bodyOf([...initial(), holderKey, foreign, holderStore(), holderRead(), read('stored-methods')])],
    placements,
    new Map(),
    null,
    undefined,
    holderContext()
  )
  assert.equal(known.size, 0)
})

test('a structural conversion of a class revokes untracked nested record aliases', () => {
  const view: Representation = {
    kind: 'record',
    shapeId: 'holder-view' as never,
    fields: [{ key: 'methods', value: record, required: true }],
    accessors: [],
    ownership: 'owned'
  }
  const conversion = {
    kind: 'convert',
    lineage: 'holder-view' as never,
    conversionUse: 'holder-view-conversion' as never,
    source: operand('holder', holder),
    result: result('view', view)
  } as IrNonTerminatorOperation
  assert.equal(holderFacts([conversion]).size, 0)
  const array = (element: Representation): Representation => ({
    kind: 'array-object',
    element,
    ownership: 'shared-refcount',
    extension: null
  })
  assert.equal(
    holderFacts([
      { ...conversion, source: operand('holders', array(holder)), result: result('views', array(view)) } as IrNonTerminatorOperation
    ]).size,
    0
  )
})

test('an externally callable constructor revokes initializer record transport', () => {
  const initializer = bodyOf(initial(), 'field-initializer', operand('table'))
  const entry = bodyOf([
    ...createHolder(),
    holderKey,
    call('external', [operand('holder-constructor', holderConstructor)]),
    holderRead(),
    read('stored-methods')
  ])
  assert.equal(
    closedRecordCallablesOf([entry, initializer], placements, new Map(), null, undefined, holderContext(false, true, 'field-initializer'))
      .size,
    0
  )
})

test('method receiver provenance includes every native caller, including foreign typed instances', () => {
  const methodAbi: CallableAbi = { ...abi, receiver: holder }
  const methodValue: Representation = { kind: 'function-value-dispatch', abi: methodAbi }
  const methodKey = { ...key, text: 'inspect', result: result('inspect-key', string) }
  const loadMethod: IrNonTerminatorOperation = {
    kind: 'get',
    lineage: 'inspect-load' as never,
    receiver: operand('holder', holder),
    key: operand('inspect-key', string),
    closedCallable: { kind: 'exact', functionId: 'inspect-holder' as never },
    result: result('inspect-value', methodValue)
  }
  const invoke = (receiver: string): IrNonTerminatorOperation => ({
    ...call('inspect-value', [], operand(receiver, holder)),
    callee: operand('inspect-value', methodValue),
    result: null,
    closedCallee: { kind: 'exact', functionId: 'inspect-holder' as never }
  })
  const inspect = {
    ...bodyOf(
      [
        { kind: 'receiver', lineage: 'inspect-receiver' as never, result: result('method-receiver', holder) },
        { ...holderRead(), receiver: operand('method-receiver', holder) } as IrNonTerminatorOperation,
        read('stored-methods')
      ],
      'inspect-holder'
    ),
    abi: methodAbi
  }
  const inspectFacts = (foreign: boolean, escaped: boolean) =>
    closedRecordCallablesOf(
      [
        bodyOf([
          ...initial(),
          ...createHolder(),
          holderKey,
          holderStore(),
          methodKey,
          loadMethod,
          invoke('holder'),
          ...(foreign ? [invoke('foreign-holder')] : []),
          ...(escaped ? [call('external', [operand('inspect-value', methodValue)])] : [])
        ]),
        inspect
      ],
      placements,
      new Map(),
      null,
      undefined,
      holderContext()
    )
  assert.deepEqual(inspectFacts(false, false).get('method' as never), exact)
  assert.equal(inspectFacts(true, false).size, 0)
  assert.equal(inspectFacts(false, true).size, 0)
})
