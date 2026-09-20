import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { Representation } from '../representation/model.js'
import type { IrBody, IrOperation } from './model.js'
import { closedStaticCallablesOf } from './static-callables.js'
import { fillCallDispatchTargets } from './call-dispatch.js'

const root = 'static-root' as DeclarationId
const child = 'static-child' as DeclarationId
const functionId = 'static-run' as never
const abi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } } as const
const constructor: Representation = { kind: 'constructor-family', members: [child], abi }
const callable: Representation = { kind: 'function-value-dispatch', abi }
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })
const lineage = 'static-callable-test' as never
const layout = (declaration: DeclarationId, base: DeclarationId | null): ClassLayout => ({
  declaration,
  base,
  nativeBase: null,
  construct: null,
  instance: null,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticAccessors: [],
  staticMethods: declaration === root ? [{ key: 'run', callable: functionId }] : [],
  name: null,
  length: null
})
const classes = new Map([
  [root, layout(root, null)],
  [child, layout(child, root)]
])
const read: Extract<IrOperation, { kind: 'get' }> = {
  kind: 'get',
  lineage,
  receiver: operand('constructor', constructor),
  key: operand('key', { kind: 'string' }),
  result: { id: 'method' as never, representation: callable }
}
const call: Extract<IrOperation, { kind: 'call' }> = {
  kind: 'call',
  lineage,
  callee: operand('method', callable),
  receiver: operand('constructor', constructor),
  arguments: [],
  result: { id: 'result' as never, representation: abi.result }
}
const bodyOf = (extra: readonly IrOperation[] = []): IrBody => {
  const entry = 'static-entry' as never
  const operations: IrOperation[] = [
    { kind: 'constant', lineage, text: 'run', literal: 'string', result: { id: 'key' as never, representation: { kind: 'string' } } },
    {
      kind: 'allocate-constructor',
      lineage,
      declaration: child,
      captures: [],
      result: { id: 'constructor' as never, representation: constructor }
    },
    read,
    call,
    ...extra
  ]
  return {
    owner: 'static-body' as never,
    sourceOwner: 'static-body' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([[entry, { id: entry, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const facts = (extra: readonly IrOperation[] = []) => closedStaticCallablesOf([bodyOf(extra)], new Map(), classes)

test('an inherited static method retains identity without physical direct dispatch', () => {
  assert.deepEqual(facts().get(read.result.id), { kind: 'exact', functionId })
  const body = bodyOf()
  const filled = fillCallDispatchTargets(
    new Map([[body.owner, body]]),
    new Map(),
    classes,
    () => abi,
    () => false,
    { families: [], refused: [], dispatched: new Map() }
  )
  const invocation = filled
    .get(body.owner)!
    .blocks.get(body.entry)!
    .operations.find((operation) => operation.kind === 'call') as typeof call
  assert.deepEqual(invocation.closedCallee, { kind: 'exact', functionId })
  assert.equal(invocation.receiver, null)
  assert.deepEqual(invocation.closedFrame, { abi, receivedArguments: 0, result: 'ignored' })
  assert.equal(invocation.target, undefined)
})

test('a receiver used by the static body is preserved', () => {
  const heldAbi = { ...abi, receiver: constructor }
  const typedCallable: Representation = { kind: 'function-value-dispatch', abi: heldAbi }
  const body = bodyOf()
  const block = body.blocks.get(body.entry)!
  const updated = {
    ...body,
    blocks: new Map([
      [
        body.entry,
        {
          ...block,
          operations: [
            block.operations[0]!,
            block.operations[1]!,
            { ...read, result: { ...read.result, representation: typedCallable } },
            { ...call, callee: operand('method', typedCallable) }
          ]
        }
      ]
    ])
  }
  const filled = fillCallDispatchTargets(
    new Map([[body.owner, updated]]),
    new Map(),
    classes,
    () => heldAbi,
    () => false,
    { families: [], refused: [], dispatched: new Map() }
  )
  const invocation = filled
    .get(body.owner)!
    .blocks.get(body.entry)!
    .operations.find((operation) => operation.kind === 'call') as typeof call
  assert.deepEqual(invocation.receiver, call.receiver)
  assert.deepEqual(invocation.closedFrame?.abi, heldAbi)
})

test('writes to the receiver or declaring base revoke the static identity', () => {
  for (const members of [[child], [root]]) {
    const value: Representation = { ...constructor, members }
    assert.equal(
      facts([
        {
          kind: 'set',
          lineage,
          receiver: operand('alias', value),
          key: read.key,
          value: operand('replacement', callable),
          strict: true,
          result: null
        }
      ]).size,
      0
    )
  }
})

test('unknown publication and dynamic member reads revoke static identity', () => {
  assert.equal(
    facts([
      {
        ...call,
        callee: operand('external', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
        receiver: null,
        arguments: [operand('constructor', constructor)]
      }
    ]).size,
    0
  )
  assert.equal(
    facts([{ ...read, key: operand('runtime-key', { kind: 'string' }), result: { ...read.result, id: 'other-read' as never } }]).size,
    0
  )
})

test('an intermediate constructor mutation can shadow an inherited static method', () => {
  const middle = 'static-middle' as DeclarationId
  const hierarchy = new Map(classes)
  hierarchy.set(child, layout(child, middle))
  hierarchy.set(middle, layout(middle, root))
  const body = bodyOf([
    {
      kind: 'set',
      lineage,
      receiver: operand('middle', { ...constructor, members: [middle] }),
      key: read.key,
      value: operand('replacement', callable),
      strict: true,
      result: null
    }
  ])
  assert.equal(closedStaticCallablesOf([body], new Map(), hierarchy).size, 0)
})

test('an escaped instance exposes its constructor and inherited static methods', () => {
  const instance: Representation = {
    kind: 'class-ref',
    declaration: child,
    shapeId: 'static-instance-shape' as never,
    ownership: 'shared-refcount',
    ancestors: [root]
  }
  assert.equal(
    facts([
      {
        ...call,
        callee: operand('external', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
        receiver: null,
        arguments: [operand('instance', instance)]
      }
    ]).size,
    0
  )
})

test('a constructor-shaped value without native allocation provenance carries no static identity', () => {
  const body = bodyOf()
  const block = body.blocks.get(body.entry)!
  const external = {
    ...body,
    blocks: new Map([
      [body.entry, { ...block, operations: block.operations.filter((operation) => operation.kind !== 'allocate-constructor') }]
    ])
  }
  assert.equal(closedStaticCallablesOf([external], new Map(), classes).size, 0)
})
