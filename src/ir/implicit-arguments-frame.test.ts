import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { FunctionId, OperationId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import { convertTo, packRestArguments, type LoweringContext } from './lower-operands.js'
import { allOperationsOf } from './model.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'

test('implicit arguments packs the original supplied list before padding omitted named parameters', () => {
  const entry = resolve('test/runtime/implicit-arguments-actual-frame.runtime.js')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  const details = JSON.stringify({
    diagnostics: result.diagnostics.diagnostics,
    refusals: result.refusals,
    emission: result.emissionRefusals
  })
  assert.equal(result.diagnostics.clean, true, details)
  assert.notEqual(result.source, null, details)
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const counts: number[] = []
  for (const operation of operations) {
    if (operation.kind !== 'call') continue
    const abi = abiOfCallee(operation.callee.representation)
    if (abi?.argumentsFrame !== 'actual' || abi.restFrom === null) continue
    assert.equal(operation.arguments.length, abi.parameters.length)
    const packed = operation.arguments[abi.restFrom]
    const allocation = operations.find((one) => one.kind === 'allocate-array-object' && one.result.id === packed?.value)
    assert.ok(allocation?.kind === 'allocate-array-object')
    counts.push(allocation.elements.length)
  }
  assert.deepEqual(
    counts.sort((left, right) => left - right),
    [0, 1, 1, 2]
  )
})

test('the actual-arguments convention is part of exact callable identity', () => {
  const frame: CallableAbi = {
    receiver: null,
    parameters: [
      {
        value: { kind: 'array-object', element: { kind: 'scalar', domain: 'number' }, ownership: 'shared-refcount', extension: null },
        ownership: 'shared-refcount',
        passing: 'by-value'
      }
    ],
    restFrom: 0,
    result: { kind: 'void' }
  }
  assert.notEqual(abiKey(frame), abiKey({ ...frame, argumentsFrame: 'actual' }))
})

test('a fixed optional physical ABI packs the evaluated Number rather than its converted named formal', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const array: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
  const abi: CallableAbi = {
    receiver: null,
    parameters: [optional, array].map((value) => ({ value, passing: 'by-value' as const, ownership: 'owned' as const })),
    restFrom: 1,
    argumentsFrame: 'actual',
    result: { kind: 'void' }
  }
  const builder = createIrBodyBuilder('optional-arguments-body' as PhysicalBodyId, 'optional-arguments-owner' as FunctionId, abi)
  const block = builder.openBlock()
  const lineage = 'optional-arguments-result' as SemanticResultId
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  // This packing test uses native total conversions only; source/slot queries are deliberately unavailable.
  const context = { builder, exactArmNarrowing: false, program: { conversions } } as unknown as LoweringContext
  const actualValue = { value: builder.constant(block, lineage, '7', 'number', number), representation: number }
  const value = convertTo(context, block, lineage, actualValue, optional)
  assert.ok(value)
  assert.notEqual(value.value, actualValue.value, 'the optional named formal requires an actual conversion')
  const supplied = [{ kind: 'value' as const, value, actualValue }]
  const args = packRestArguments(context, block, lineage, 'optional-arguments-call' as OperationId, abi, supplied)
  assert.deepEqual(args[0], value, 'the physical named formal keeps the converted view')
  const actualPack = builder.operationsOf(block).find((operation) => operation.kind === 'allocate-array-object')
  assert.ok(actualPack?.kind === 'allocate-array-object')
  assert.deepEqual(actualPack.elements, [{ kind: 'element', value: actualValue }])
  const ordinaryAbi: CallableAbi = { receiver: abi.receiver, parameters: abi.parameters, restFrom: abi.restFrom, result: abi.result }
  const ordinaryArgs = packRestArguments(context, block, lineage, 'ordinary-rest-call' as OperationId, ordinaryAbi, supplied)
  assert.deepEqual(ordinaryArgs[0], value)
  const packs = builder.operationsOf(block).filter((operation) => operation.kind === 'allocate-array-object')
  assert.equal(packs.length, 2)
  assert.deepEqual(packs[1]!.elements, [], 'ordinary rest excludes its converted named prefix')
})
