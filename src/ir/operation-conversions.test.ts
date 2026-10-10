import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import { declarationId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { ClassLayout } from '../projection/classes.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { cppRegExpNativeTypes } from '../targets/cpp/regexp-types.js'
import type { CallOperation, IrOperation } from './model.js'
import { thrownValueCarrier } from './lower-exceptions.js'
import { operationConversionInputsOf, operationConversionsMatch, operationConversionsOf } from './operation-conversions.js'
import { nativeUnionMethodTargetMatches } from './native-union-method-targets.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const operand = (representation: Representation) => ({ value: 'operand' as never, representation })
const result = (representation: Representation) => ({ id: 'result' as never, representation })
const deriver = {
  layoutOf: (shapeId: string): Representation => ({ kind: 'record', shapeId, ownership: 'shared-refcount', fields: [], accessors: [] })
} as unknown as RepresentationDeriver

test('a string length selected from a primitive union cites its physical number result', () => {
  const published: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'native-length' as never,
    receiver: operand(sum(string, number)),
    key: operand(string),
    result: result(published)
  }
  const inputs = operationConversionInputsOf(operation, 'length', deriver, new Map())
  assert.deepEqual(inputs, [{ role: 'field-read', source: number, target: published }])
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
})

test('a guarded bind seals its lazy native owner materializer and the dynamic answer adapter', () => {
  const source: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      restFrom: 0,
      parameters: [
        {
          value: { kind: 'array-object', element: string, extension: null, ownership: 'shared-refcount' },
          passing: 'by-value',
          ownership: 'owned'
        }
      ],
      result: string
    }
  }
  const bound = source
  const operation: IrOperation = {
    kind: 'bind-callable',
    lineage: 'guarded-bind' as never,
    source: operand(source),
    sourceFunctionId: null,
    sourceAbi: source.abi,
    thisArgument: null,
    receiver: null,
    bound: [],
    builtinShadowGuard: 'bind',
    result: result(bound)
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.deepEqual(inputs, [
    { role: 'dynamic-write', source, target: dynamic },
    { role: 'call-result', source: dynamic, target: bound }
  ])
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
  assert.equal(
    operationConversionsMatch(
      inputs,
      recipes.filter((recipe) => recipe.role !== 'call-result'),
      census
    ),
    false
  )
})

test('binary tag reads cite the native string for optional and genuinely dynamic results', () => {
  const declaration = declarationId('tag-property-test', 0)
  const symbols = new Map([[declaration, 'toStringTag']])
  const receiver = sum(
    { kind: 'array-buffer', ownership: 'shared-refcount' },
    { kind: 'typed-array', element: 'uint8', buffer: 'array-buffer', ownership: 'shared-refcount' }
  )
  for (const published of [{ kind: 'optional', payload: string, absence: 'undefined' } as Representation, dynamic]) {
    const operation: IrOperation = {
      kind: 'get',
      lineage: 'native-tag' as never,
      receiver: operand(receiver),
      key: operand(string),
      result: result(published)
    }
    const inputs = operationConversionInputsOf(
      operation,
      `sym(${declaration})`,
      deriver,
      new Map(),
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      symbols
    )
    assert.deepEqual(inputs, [{ role: 'field-read', source: string, target: published }])
    const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
    const recipes = operationConversionsOf(inputs, census)
    assert.equal(operationConversionsMatch(inputs, recipes, census), true)
  }
})

test('authenticated Reflect writes enter native fixed storage without an ambient or boxed value frame', () => {
  const stored: Representation = {
    kind: 'class-ref',
    declaration: declarationId('native-reflect-entry', 0),
    shapeId: 'entry',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const receiver: Representation = {
    kind: 'record',
    shapeId: 'reflected-fixed-field',
    ownership: 'shared-refcount',
    fields: [{ key: 'value', value: stored, required: true }],
    accessors: []
  }
  const ambientObject: Representation = {
    kind: 'record',
    shapeId: 'ambient-object',
    ownership: 'shared-refcount',
    fields: [],
    accessors: []
  }
  const operation: IrOperation = {
    kind: 'call',
    lineage: 'reflect-set-native' as never,
    intrinsicReflection: 'set',
    callee: {
      value: 'reflect-set' as never,
      representation: {
        kind: 'function-value-dispatch',
        abi: {
          receiver: null,
          restFrom: null,
          result: { kind: 'scalar', domain: 'boolean' },
          parameters: [ambientObject, string, dynamic].map((value) => ({ value, passing: 'by-value', ownership: 'owned' }))
        }
      }
    },
    receiver: null,
    arguments: [operand(receiver), { value: 'field-key' as never, representation: string }, operand(stored)],
    result: result({ kind: 'scalar', domain: 'boolean' })
  }
  const definitionOf = (value: unknown): IrOperation | null =>
    value === 'field-key' ? { kind: 'constant', lineage: 'key' as never, literal: 'string', text: 'value', result: result(string) } : null
  assert.deepEqual(operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, definitionOf), [])
  const unknownKey = operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, () => null)
  assert.deepEqual(unknownKey, [{ role: 'dynamic-write', source: stored, target: dynamic }])
})

test('a native receiver union cites the selected class arm as well as the whole frame', () => {
  const base: Representation = {
    kind: 'class-ref',
    declaration: declarationId('union-call-frame', 0),
    shapeId: 'base',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const child: Representation = {
    ...base,
    declaration: declarationId('union-call-frame', 1),
    shapeId: 'child',
    ancestors: [base.declaration]
  }
  const receiver = sum(base, child)
  const call: IrOperation = {
    kind: 'call',
    lineage: 'union-native-call' as never,
    callee: operand({ kind: 'function-value-dispatch', abi: { receiver: base, parameters: [], restFrom: null, result: { kind: 'void' } } }),
    receiver: operand(receiver),
    arguments: [],
    result: result({ kind: 'void' })
  }
  assert.deepEqual(operationConversionInputsOf(call, null, deriver, new Map()), [
    { role: 'call-argument', source: receiver, target: base },
    { role: 'call-argument', source: child, target: base }
  ])
})

test('a possibly-absent method cites only the receiver arms that can have supplied it', () => {
  const texture: Representation = {
    kind: 'class-ref',
    declaration: declarationId('absent-method-frame', 0),
    shapeId: 'texture',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const color: Representation = { ...texture, declaration: declarationId('absent-method-frame', 1), shapeId: 'color' }
  const receiver = sum(number, color, texture)
  const method: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: texture, parameters: [], restFrom: null, result: { kind: 'void' } }
  }
  const call: IrOperation = {
    kind: 'call',
    lineage: 'absent-method-call' as never,
    callee: operand({ kind: 'optional', payload: method, absence: 'undefined' }),
    receiver: operand(receiver),
    arguments: [],
    result: result({ kind: 'void' })
  }
  // Color has no such method: on that arm the callee is undefined and the call
  // throws before its receiver is converted, so Color -> Texture is never cited.
  assert.deepEqual(operationConversionInputsOf(call, null, deriver, new Map()), [
    { role: 'call-argument', source: receiver, target: texture }
  ])
})

test('a union method call keeps each selected Function paired with its own receiver path', () => {
  const left: Representation = {
    kind: 'class-ref',
    declaration: declarationId('selected-union-call', 0),
    shapeId: 'left',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const right: Representation = { ...left, declaration: declarationId('selected-union-call', 1), shapeId: 'right' }
  const receiver = sum(left, right)
  const held = { receiver, parameters: [], restFrom: null, result: { kind: 'void' } } as const
  const read: IrOperation = {
    kind: 'get',
    lineage: 'union-method-read' as never,
    receiver: { value: 'receiver-snapshot' as never, representation: receiver },
    key: operand(string),
    result: { id: 'selected-function' as never, representation: { kind: 'function-value-dispatch', abi: held } }
  }
  const call: CallOperation = {
    kind: 'call',
    lineage: 'selected-union-call' as never,
    callee: { value: 'selected-function' as never, representation: read.result.representation },
    receiver: read.receiver,
    thisArgument: read.receiver,
    arguments: [],
    result: result({ kind: 'void' }),
    target: {
      kind: 'union-arm',
      arms: [
        { path: [0], declaration: left.declaration, functionId: 'left-function' as never },
        { path: [1], declaration: right.declaration, functionId: 'right-function' as never }
      ]
    }
  }
  const abis = new Map([
    ['left-function' as never, { ...held, receiver: left }],
    ['right-function' as never, { ...held, receiver: right }]
  ])
  const classes = new Map(
    [left, right].map((receiver, index) => [
      receiver.declaration,
      {
        declaration: receiver.declaration,
        base: null,
        methods: [{ key: 'run', callable: index === 0 ? 'left-function' : 'right-function' }],
        fields: [],
        accessors: [],
        methodOverrides: []
      } as unknown as ClassLayout
    ])
  )
  const definitionOf = (value: unknown): IrOperation | null =>
    value === 'selected-function'
      ? read
      : value === read.key.value
        ? {
            kind: 'constant',
            lineage: 'key' as never,
            literal: 'string',
            text: 'run',
            result: { id: read.key.value, representation: string }
          }
        : null
  assert.equal(nativeUnionMethodTargetMatches(call, classes, definitionOf), true)
  assert.deepEqual(operationConversionInputsOf(call, null, deriver, classes, false, abis, definitionOf), [])

  const inherited: Representation = { ...left, declaration: declarationId('selected-union-call', 2), shapeId: 'base' }
  const inheritedAbis = new Map([...abis].map(([id, abi]) => [id, { ...abi, receiver: inherited }]))
  const upcastCall = { ...call, receiver: operand(inherited) }
  assert.deepEqual(operationConversionInputsOf(upcastCall, null, deriver, classes, false, inheritedAbis, definitionOf), [
    { role: 'call-argument', source: left, target: inherited },
    { role: 'call-argument', source: right, target: inherited }
  ])
  const target = call.target
  assert.ok(target?.kind === 'union-arm')
  const forged: CallOperation = {
    ...call,
    target: {
      kind: 'union-arm',
      arms: target.arms.map((arm) => ({ ...arm, functionId: 'forged-function' as never }))
    }
  }
  assert.equal(nativeUnionMethodTargetMatches(forged, classes, definitionOf), false)
  assert.equal(nativeUnionMethodTargetMatches({ ...call, thisArgument: operand(receiver) }, classes, definitionOf), false)
})

test('union dictionary reads certify each physical value into the optional payload', () => {
  const receiver = sum(
    { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' },
    { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' }
  )
  const payload = sum(number, string)
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'read' as never,
    receiver: operand(receiver),
    key: operand(string),
    result: result({ kind: 'optional', payload, absence: 'undefined' })
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.deepEqual(
    inputs.map((input) => input.role),
    ['index-read', 'index-read']
  )
  assert.ok(inputs.every((input) => representationKey(input.target) === representationKey(payload)))
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
  assert.equal(operationConversionsMatch(inputs, recipes.slice(1), census), false)
  assert.equal(
    operationConversionsMatch(
      inputs,
      recipes.map((recipe) => ({ ...recipe, role: 'descriptor' })),
      census
    ),
    false
  )
  assert.equal(
    operationConversionsMatch(
      inputs,
      recipes.map((recipe) => ({ ...recipe, target: dynamic })),
      census
    ),
    false
  )
})

test('strict equality certifies only genuinely dynamic comparisons that need value transport', () => {
  const operation: IrOperation = {
    kind: 'compute',
    lineage: 'compare' as never,
    form: 'equality',
    operator: '===',
    operands: [operand(sum(dynamic, number)), operand(string)],
    result: result({ kind: 'scalar', domain: 'boolean' })
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.role, 'equality')
  assert.equal(inputs[0]?.source, string)
  assert.equal(inputs[0]?.target, dynamic)
  assert.equal(
    operationConversionInputsOf(
      { ...operation, nativeEquality: { dynamicOperand: 0, primitive: 'string', negate: false } },
      null,
      deriver,
      new Map()
    ).length,
    0
  )
})

test('an indexed native descriptor cites its held value separately from the incoming operand', () => {
  const receiver: Representation = {
    kind: 'record-with-index',
    shapeId: 'indexed',
    ownership: 'shared-refcount',
    fields: [{ key: 'named', value: number, required: true }],
    indexes: [{ key: 'string', value: sum(number, string) }]
  }
  const operation: IrOperation = {
    kind: 'define-own-property',
    lineage: 'define' as never,
    receiver: operand(receiver),
    key: operand(string),
    value: operand(number),
    attributes: { writable: true, enumerable: true, configurable: true },
    result: null
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  const descriptor = inputs.find((input) => input.role === 'descriptor')
  assert.ok(descriptor)
  assert.equal(descriptor.source, receiver.indexes[0]?.value)
  assert.deepEqual(descriptor.target, dynamic)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipe = operationConversionsOf([descriptor], census)[0]!
  assert.equal(recipe.conversion, census.nodeFor(receiver.indexes[0]!.value, dynamic).id)
  assert.equal(operationConversionsMatch([descriptor], [recipe], census), true)
})

test('host dynamic argument packing keeps surplus inputs outside the received native frame', () => {
  const callee: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [{ value: number, passing: 'by-value', ownership: 'owned' }],
      result: { kind: 'void' },
      restFrom: null
    }
  }
  const operation: IrOperation = {
    kind: 'call',
    lineage: 'host-call' as never,
    callee: operand(callee),
    receiver: null,
    arguments: [operand(number), operand({ kind: 'promise', value: string })],
    result: null
  }
  assert.deepEqual(operationConversionInputsOf(operation, null, deriver, new Map()), [])
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map(), true)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.source, number)
  assert.deepEqual(inputs[0]?.target, dynamic)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipe = operationConversionsOf(inputs, census)[0]!
  assert.equal(recipe.conversion, census.nodeFor(number, dynamic).id)
  assert.equal(operationConversionsMatch(inputs, [recipe], census), true)
})

test('native calls cite supplied values entering optional slots and the selected physical body only', () => {
  const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const callable = 'physical-call' as never
  const operation: IrOperation = {
    kind: 'call',
    lineage: 'native-call' as never,
    callee: operand({
      kind: 'function-value-dispatch',
      abi: { receiver: null, parameters: [{ value: dynamic, ownership: 'owned', passing: 'by-value' }], result: dynamic, restFrom: null }
    }),
    receiver: null,
    target: { kind: 'direct', functionId: callable },
    arguments: [operand(number), operand(string)],
    result: result(number)
  }
  const inputs = operationConversionInputsOf(
    operation,
    null,
    deriver,
    new Map(),
    false,
    new Map([
      [
        callable,
        { receiver: null, parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }], result: number, restFrom: null }
      ]
    ])
  )
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.role, 'call-argument')
  assert.equal(inputs[0]?.source, number)
  assert.equal(inputs[0]?.target, optional)
})

test('direct dictionary reads and native field stores cite their complete optional carrier', () => {
  const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
  const read: IrOperation = {
    kind: 'get',
    lineage: 'optional-read' as never,
    receiver: operand({ kind: 'dictionary', key: 'string', value: dynamic, ownership: 'shared-refcount' }),
    key: operand(string),
    result: result(optional)
  }
  const reads = operationConversionInputsOf(read, 'value', deriver, new Map())
  assert.ok(reads.some((input) => input.source === dynamic && input.target === optional))
  const receiver: Representation = {
    kind: 'record',
    shapeId: 'optional-cache',
    ownership: 'shared-refcount',
    fields: [{ key: 'value', value: optional, required: true }],
    accessors: []
  }
  const write: IrOperation = {
    kind: 'set',
    strict: true,
    lineage: 'optional-write' as never,
    receiver: operand(receiver),
    key: operand(string),
    value: operand(string),
    result: null
  }
  const writes = operationConversionInputsOf(write, 'value', deriver, new Map())
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.role, 'field-write')
  assert.equal(writes[0]?.source, string)
  assert.equal(writes[0]?.target, optional)
})

test('native Promise race completion is authenticated by the host protocol and literal member', () => {
  const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
  const operation = {
    kind: 'call',
    lineage: 'race' as never,
    callee: operand({ kind: 'dynamic', reason: 'untyped-callable' }),
    receiver: null,
    arguments: [
      operand({ kind: 'array-object', element: { kind: 'promise', value: string }, ownership: 'shared-refcount', extension: null })
    ],
    result: result({ kind: 'promise', value: optional })
  } as unknown as IrOperation
  const read = {
    kind: 'get',
    key: { value: 'member' },
    receiver: { representation: { kind: 'native-handle', protocol: 'PromiseConstructor' } }
  } as unknown as IrOperation
  const key = { kind: 'constant', literal: 'string', text: 'race' } as unknown as IrOperation
  const definition = (value: unknown): IrOperation | null => (value === 'member' ? key : read)
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, definition)
  assert.ok(inputs.some((input) => input.role === 'host-promise-completion' && input.source === string && input.target === optional))
  const unrelated = {
    ...read,
    receiver: { representation: { kind: 'native-handle', protocol: 'AnotherConstructor' } }
  } as unknown as IrOperation
  assert.ok(
    !operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, (value) =>
      value === 'member' ? key : unrelated
    ).some((input) => input.role === 'host-promise-completion')
  )
  const rejection = { ...operation, arguments: [operand(string)] } as IrOperation
  const rejectionInputs = operationConversionInputsOf(rejection, null, deriver, new Map(), false, undefined, (value) =>
    value === 'member' ? ({ ...key, text: 'reject' } as IrOperation) : read
  )
  assert.ok(rejectionInputs.some((input) => input.source === string && input.target === thrownValueCarrier))
})

test('a disjoint narrowed field read cannot authorize an ordinary store conversion', () => {
  const narrowed: Representation = {
    kind: 'class-ref',
    declaration: 'guarded-class' as never,
    shapeId: 'guarded-class',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const receiver: Representation = {
    kind: 'record',
    shapeId: 'primitive-field',
    ownership: 'shared-refcount',
    fields: [{ key: 'value', value: number, required: true }],
    accessors: []
  }
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'narrowed-read' as never,
    receiver: operand(receiver),
    key: operand(string),
    result: result(narrowed)
  }
  const inputs = operationConversionInputsOf(operation, 'value', deriver, new Map())
  assert.equal(inputs.length, 1)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(census.nodeFor(number, narrowed).capability.kind, 'never')
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(census.nodeById(recipes[0]!.conversion)?.capability.kind, 'static')
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
})

test('a contextual indexed mismatch cannot be replaced by a same-pair numeric coercion', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const inputs = [{ role: 'index-read' as const, source: string, target: number }]
  const recipe = operationConversionsOf(inputs, census)[0]!
  assert.equal(operationConversionsMatch(inputs, [recipe], census), true)
  const coercion = census.coercionFor(string, 'ToNumber')
  assert.equal(operationConversionsMatch(inputs, [{ ...recipe, conversion: coercion.id }], census), false)
})

test('native regular-expression groups publish their physical optional carrier', () => {
  const groups: Representation = { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' }
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'groups-read' as never,
    receiver: operand({
      kind: 'native-record-ref',
      shapeId: 'native-exec-result',
      native: cppRegExpNativeTypes['exec-result'],
      ownership: 'shared-refcount'
    }),
    key: operand(string),
    result: result(groups)
  }
  const inputs = operationConversionInputsOf(operation, 'groups', deriver, new Map())
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.role, 'field-read')
  assert.deepEqual(inputs[0]?.source, { kind: 'optional', payload: groups, absence: 'undefined' })
  assert.equal(inputs[0]?.target, groups)
})

test('RegExp lastIndex writes cite the native property cell rather than its semantic number type', () => {
  const operation: IrOperation = {
    kind: 'set',
    lineage: 'last-index-write' as never,
    receiver: operand({
      kind: 'native-record-ref',
      shapeId: 'pattern',
      native: cppRegExpNativeTypes.pattern,
      ownership: 'shared-refcount'
    }),
    key: operand(string),
    value: operand(number),
    strict: true,
    result: null
  }
  const inputs = operationConversionInputsOf(operation, 'lastIndex', deriver, new Map())
  assert.deepEqual(inputs, [{ role: 'dynamic-write', source: number, target: dynamic }])
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
})

test('promise reactions certify optional thenable adoption and implicit undefined separately', () => {
  const promisedVoid: Representation = { kind: 'promise', value: { kind: 'void' } }
  const published: Representation = { kind: 'promise', value: dynamic }
  const handler = (value: Representation, argument: Representation): Representation => ({
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [{ value: argument, passing: 'by-value', ownership: 'owned' }], result: value, restFrom: null }
  })
  const fulfilled = handler({ kind: 'optional', payload: promisedVoid, absence: 'undefined' }, number)
  const rejected = handler({ kind: 'void' }, dynamic)
  const callee: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [fulfilled, rejected].map((value) => ({ value, passing: 'by-value', ownership: 'owned' })),
      result: published,
      restFrom: null
    }
  }
  const definitions = new Map<string, IrOperation>([
    ['method-key', { kind: 'constant', lineage: 'method-key' as never, literal: 'string', text: 'then', result: result(string) }],
    [
      'method',
      {
        kind: 'get',
        lineage: 'method-read' as never,
        receiver: operand({ kind: 'promise', value: number }),
        key: { ...operand(string), value: 'method-key' as never },
        result: result(callee)
      }
    ]
  ])
  const operation: IrOperation = {
    kind: 'call',
    lineage: 'reaction' as never,
    callee: { ...operand(callee), value: 'method' as never },
    receiver: null,
    arguments: [operand(fulfilled), operand(rejected)],
    result: result(published)
  }
  const inputs = operationConversionInputsOf(
    operation,
    null,
    deriver,
    new Map(),
    false,
    undefined,
    (value) => definitions.get(value) ?? null
  )
  assert.deepEqual(inputs, [
    { role: 'promise-reaction', source: thrownValueCarrier, target: dynamic },
    { role: 'promise-reaction', source: { kind: 'undefined' }, target: dynamic },
    { role: 'promise-reaction', source: promisedVoid, target: published }
  ])
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.deepEqual(
    recipes.map((recipe) => recipe.conversion),
    inputs.map((input) => census.nodeFor(input.source, input.target).id)
  )
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
  assert.ok(recipes.every((recipe) => census.nodeById(recipe.conversion)?.capability.kind !== 'never'))
  definitions.set('method-key', {
    kind: 'constant',
    lineage: 'method-key' as never,
    literal: 'string',
    text: 'unrelated',
    result: result(string)
  })
  assert.deepEqual(
    operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, (value) => definitions.get(value) ?? null),
    []
  )
})

test('an array index read into an absence-capable union certifies the element and the hole', () => {
  const element = sum({ kind: 'string' }, number)
  const published = sum({ kind: 'undefined' }, { kind: 'string' }, number)
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'read' as never,
    receiver: operand({ kind: 'array-object', element, extension: null, ownership: 'shared-refcount' } as Representation),
    key: operand(number),
    result: result(published)
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.deepEqual(inputs.map((input) => representationKey(input.source)).sort(), [representationKey(element), 'undefined'].sort())
  assert.ok(inputs.every((input) => input.role === 'index-read' && representationKey(input.target) === representationKey(published)))
})

test('a typed array block member read certifies its buffer carrier into the declared union', () => {
  const published = sum(
    { kind: 'array-buffer', ownership: 'shared-refcount' },
    { kind: 'shared-array-buffer', ownership: 'shared-refcount' }
  )
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'read' as never,
    receiver: operand({ kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' } as Representation),
    key: operand(string),
    result: result(published)
  }
  const inputs = operationConversionInputsOf(operation, 'buffer', deriver, new Map())
  assert.deepEqual(
    inputs.map((input) => [input.role, representationKey(input.source)]),
    [['field-read', representationKey({ kind: 'array-buffer', ownership: 'shared-refcount' })]]
  )
})

test('an asserted record enters a class-or-primitive slot only through its view origin', () => {
  const color: Representation = {
    kind: 'class-ref',
    declaration: declarationId('asserted-view', 0),
    shapeId: 'color',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const record: Representation = { kind: 'record', shapeId: 'uniforms', ownership: 'shared-refcount', fields: [], accessors: [] }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const slot: Representation = { kind: 'optional', payload: sum(number, string, color), absence: 'undefined' }
  const node = census.assertedViewFor({ kind: 'optional', payload: record, absence: 'undefined' }, slot)
  assert.equal(node?.capability.kind === 'static' && node.capability.materializer.id, 'gea::host::assertedView')
  assert.equal(census.nodeById(node!.id), node)
  // A slot with an object home other than a class could hold the record as
  // itself, so the record is not asserted INTO a class there.
  assert.equal(census.assertedViewFor(record, sum(color, record)), null)
  // No class home: nothing for a record to be a view of.
  assert.equal(census.assertedViewFor(record, sum(number, string)), null)
})
