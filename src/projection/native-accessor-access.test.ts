import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId } from '../identity/ids.js'
import type { CallableAbi, RecordAccessor, Representation } from '../representation/model.js'
import { nativeAccessorAccessOf } from './native-accessor-access.js'

const number: Representation = { kind: 'scalar', domain: 'number' } as Representation
const undefinedValue: Representation = { kind: 'undefined' } as Representation
const abi = (parameters: readonly Representation[], result: Representation, restFrom: number | null = null): CallableAbi =>
  ({ receiver: null, parameters: parameters.map((value) => ({ value })), result, restFrom }) as unknown as CallableAbi
const accessorOf = (value: Representation): RecordAccessor => ({
  key: 'x',
  getter: 'get' as FunctionId,
  setter: 'set' as FunctionId,
  value
})

test('a receiver-only getter and a one-argument setter answer the native protocol', () => {
  const frames = new Map<string, CallableAbi>([
    ['get', abi([], number)],
    ['set', abi([number], { kind: 'void' } as Representation)]
  ])
  const access = nativeAccessorAccessOf(accessorOf(number), (callable) => frames.get(callable) ?? null)
  assert.deepEqual(access.read, { value: number, voidResult: false })
  assert.deepEqual(access.write, { value: number })
})

test('a void getter reads undefined only when its public value is undefined', () => {
  const frames = new Map<string, CallableAbi>([['get', abi([], { kind: 'void' } as Representation)]])
  const frameOf = (callable: FunctionId): CallableAbi | null => frames.get(callable) ?? null
  assert.deepEqual(nativeAccessorAccessOf(accessorOf(undefinedValue), frameOf).read, { value: undefinedValue, voidResult: true })
  assert.equal(nativeAccessorAccessOf(accessorOf(number), frameOf).read, null)
})

test('extra parameters, rest frames and missing frames refuse the native protocol', () => {
  const frames = new Map<string, CallableAbi>([
    ['get', abi([number], number)],
    ['set', abi([number], number, 0)]
  ])
  const access = nativeAccessorAccessOf(accessorOf(number), (callable) => frames.get(callable) ?? null)
  assert.equal(access.read, null)
  assert.equal(access.write, null)
  assert.deepEqual(nativeAccessorAccessOf(accessorOf(number), undefined), { read: null, write: null })
})
