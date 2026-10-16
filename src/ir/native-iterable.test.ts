import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeIterableProvider } from '../plugins/native-iterable-providers.js'
import type { Representation } from '../representation/model.js'
import type { NativeIterableReceipt } from '../semantics/model/native-iterable.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { nativeIterableReceiptMatches, type NativeIterableCertificationInput } from './native-iterable.js'
import type { GetIteratorOperation, IrOperation } from './model.js'

const fixture = () => {
  const receipt: NativeIterableReceipt = {
    protocol: 'host-sync-iterable@1',
    receiverNative: 'host::List',
    method: 'method' as never,
    source: 'source' as never,
    iterator: 'iterator-type' as never,
    element: 'element-type' as never,
    returnMethod: 'absent'
  }
  const element: Representation = { kind: 'string' }
  const receiver: Representation = {
    kind: 'native-handle',
    protocol: 'host',
    version: 1,
    native: 'host::List',
    bases: [],
    call: null,
    construct: null
  }
  const iterator: Representation = {
    kind: 'iterator',
    element,
    source: 'sequence',
    resume: { kind: 'undefined' },
    completion: { kind: 'undefined' }
  }
  const operation: GetIteratorOperation = {
    kind: 'get-iterator',
    lineage: 'walk' as never,
    protocol: 'iterator',
    method: null,
    nativeIterable: receipt,
    receiver: { value: 'input' as never, representation: receiver },
    result: { id: 'cursor' as never, representation: iterator }
  }
  const semantic = {
    family: 'protocol',
    protocol: 'iterator',
    step: 'get-iterator',
    nativeIterable: receipt,
    operands: [{ role: 'target', ordinal: 0, type: 'source-type', source: { kind: 'result', result: 'source' } }],
    results: [{ role: 'iterator-record', type: 'iterator-type' }]
  } as unknown as SemanticOperation
  const definition = { kind: 'get', lineage: 'source', result: { id: 'input', representation: receiver } } as unknown as IrOperation
  const provider: NativeIterableProvider = {
    protocol: 'host-sync-iterable@1',
    receiverNative: 'host::List',
    memberModel: 'native-fixed-member',
    iteratorFactory: { kind: 'method', arity: 0, emit: '$self.values()' }
  }
  const input: NativeIterableCertificationInput = {
    nativeIterableAuthorities: new Map([[operation.lineage, { ...receipt }]]),
    nativeIterableProviders: new Map([['host::List', provider]]),
    definitionOf: () => definition,
    deriver: { derive: (type) => (type === 'source-type' ? receiver : type === 'iterator-type' ? iterator : element) }
  }
  return { receipt, operation, semantic, input, definition }
}

test('exact independent source/provider/typed cursor authority matches', () => {
  const f = fixture()
  assert.equal(nativeIterableReceiptMatches(f.operation, f.semantic, f.input), true)
})

test('every receipt field is checked independently of the IR copy', () => {
  const f = fixture()
  for (const key of Object.keys(f.receipt) as (keyof NativeIterableReceipt)[]) {
    const nativeIterable = { ...f.receipt, [key]: 'forged' } as NativeIterableReceipt
    assert.equal(nativeIterableReceiptMatches({ ...f.operation, nativeIterable }, f.semantic, f.input), false, key)
    const semantic = { ...f.semantic, nativeIterable } as SemanticOperation
    assert.equal(nativeIterableReceiptMatches({ ...f.operation, nativeIterable }, semantic, f.input), false, `both ${key}`)
  }
})

test('dropped semantic/IR receipts and missing independent authority refuse', () => {
  const f = fixture()
  const { nativeIterable: _, ...without } = f.operation
  assert.equal(nativeIterableReceiptMatches(without, f.semantic, f.input), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, null, f.input), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, f.semantic, { ...f.input, nativeIterableAuthorities: undefined }), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, f.semantic, { ...f.input, nativeIterableProviders: undefined }), false)
})

test('same-carrier borrowed SSA source and wrong native carrier refuse', () => {
  const f = fixture()
  assert.equal(
    nativeIterableReceiptMatches({ ...f.operation, receiver: { ...f.operation.receiver, value: 'other' as never } }, f.semantic, f.input),
    false
  )
  assert.equal(
    nativeIterableReceiptMatches(f.operation, f.semantic, {
      ...f.input,
      definitionOf: () => ({ ...f.definition, lineage: 'other' as never })
    }),
    false
  )
  assert.equal(
    nativeIterableReceiptMatches(
      {
        ...f.operation,
        receiver: {
          ...f.operation.receiver,
          representation: { kind: 'native-handle', protocol: 'host', version: 1, native: 'other', bases: [], call: null, construct: null }
        }
      },
      f.semantic,
      f.input
    ),
    false
  )
})

test('dynamic element, generator cursor and result carrier mismatch refuse', () => {
  const f = fixture()
  const iterator = f.operation.result.representation
  assert.equal(iterator.kind, 'iterator')
  if (iterator.kind !== 'iterator') return
  for (const representation of [{ ...iterator, source: 'generator' as const }, { kind: 'undefined' as const }])
    assert.equal(
      nativeIterableReceiptMatches({ ...f.operation, result: { ...f.operation.result, representation } }, f.semantic, f.input),
      false
    )
  assert.equal(
    nativeIterableReceiptMatches(f.operation, f.semantic, {
      ...f.input,
      deriver: { derive: (id) => (id === 'element-type' ? ({ kind: 'dynamic' } as Representation) : f.input.deriver.derive(id)) }
    }),
    false
  )
})

test('existing receipt-free operations remain outside the new authority route', () => {
  const f = fixture()
  const { nativeIterable: _, ...operation } = f.operation
  assert.equal(nativeIterableReceiptMatches(operation, null, f.input), false)
  assert.equal(nativeIterableReceiptMatches(operation, null, { ...f.input, nativeIterableAuthorities: undefined }), true)
})

test('protocol, dynamic method and semantic result/operand substitutions refuse', () => {
  const f = fixture()
  assert.equal(nativeIterableReceiptMatches({ ...f.operation, protocol: 'async-iterator' }, f.semantic, f.input), false)
  assert.equal(nativeIterableReceiptMatches({ ...f.operation, method: f.operation.receiver }, f.semantic, f.input), false)
  const source = f.semantic as Extract<SemanticOperation, { family: 'protocol' }>
  assert.equal(nativeIterableReceiptMatches(f.operation, { ...source, step: 'next' }, f.input), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, { ...source, results: [] }, f.input), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, { ...source, operands: [] }, f.input), false)
  assert.equal(nativeIterableReceiptMatches(f.operation, f.semantic, { ...f.input, nativeIterableProviders: new Map() }), false)
})

test('native element names and source cursor channels cannot hide behind physical keys', () => {
  const f = fixture()
  const node: Representation = {
    kind: 'native-handle',
    protocol: 'node',
    version: 1,
    native: 'host::Node',
    bases: [],
    call: null,
    construct: null
  }
  const iterator = f.operation.result.representation
  assert.equal(iterator.kind, 'iterator')
  if (iterator.kind !== 'iterator') return
  const typed = { ...iterator, element: node }
  const input = {
    ...f.input,
    deriver: {
      derive: (id: Parameters<typeof f.input.deriver.derive>[0]) =>
        id === 'iterator-type' ? typed : id === 'element-type' ? node : f.input.deriver.derive(id)
    }
  }
  const operation = { ...f.operation, result: { ...f.operation.result, representation: typed } }
  assert.equal(nativeIterableReceiptMatches(operation, f.semantic, input), true)
  const wrong = { ...typed, element: { ...node, native: 'host::OtherNode' } }
  assert.equal(
    nativeIterableReceiptMatches({ ...operation, result: { ...operation.result, representation: wrong } }, f.semantic, input),
    false
  )
  const resumed = { ...typed, resume: { kind: 'string' as const } }
  assert.equal(
    nativeIterableReceiptMatches({ ...operation, result: { ...operation.result, representation: resumed } }, f.semantic, input),
    false
  )
})
