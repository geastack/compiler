import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { IrValueId, SemanticResultId } from '../identity/ids.js'
import { allOperationsOf, type IrNonTerminatorOperation } from './model.js'
import {
  nativeCallablePrototypeDescriptorsOf as descriptorsOf,
  nativeCallablePrototypeMatches,
  nativeCallablePrototypeReadsOf as readsOf
} from './native-callable-prototype.js'
import { nativeCallableDataSlotInputOf, type PublishNativeCallableDataSlotsInput } from './native-callable-data-slots.js'
import { operandOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { coreHostMembers } from '../targets/cpp/host/host-members.js'

const entry = resolve('test/runtime/function-value-computed-symbol.ts')
const resultOf = () =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([
      [
        entry,
        `export {}; function target(first?: number, ...rest: number[]) { return (first ?? 0) + rest.length }; const observed: any = target.prototype; console.log(observed.constructor === target)`
      ]
    ])
  })
// Each query derives its one flow from exactly the bodies it is handed.
const nativeCallablePrototypeReadsOf = (input: PublishNativeCallableDataSlotsInput) => readsOf(nativeCallableDataSlotInputOf(input))
const nativeCallablePrototypeDescriptorsOf = (input: PublishNativeCallableDataSlotsInput) =>
  descriptorsOf(nativeCallableDataSlotInputOf(input))
const inputOf = (result: ReturnType<typeof resultOf>): PublishNativeCallableDataSlotsInput => ({
  nativeCallableData: result.representations.nativeCallableData,
  programConversions: null,
  graph: result.graph,
  bodies: new Map((result.irBodies ?? []).map((body) => [body.owner, body])),
  placements: result.projection.placements,
  classes: result.projection.classes,
  deriver: result.representations.deriver,
  conversions: result.conversionCensus,
  calleeRendering: {
    hostMembers: coreHostMembers,
    graph: result.graph,
    plan: result.representations.plan,
    deriver: result.representations.deriver,
    placements: result.projection.placements,
    classes: result.projection.classes,
    hostMethodAliasDeclarations: new Set()
  }
})

test('a reflected native prototype value publishes exact backpointer observation after freeze', () => {
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([
      [
        entry,
        `export {}; function target(first?: number, ...rest: number[]) { return (first ?? 0) + rest.length }
         Object.freeze(target)
         const descriptor = Object.getOwnPropertyDescriptor(target, 'prototype')!
         console.log(descriptor.value.constructor === target, descriptor.writable, descriptor.configurable)`
      ]
    ])
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const input = inputOf(result)
  const original = nativeCallablePrototypeDescriptorsOf(input)
  assert.equal(original.required.size, 1)
  assert.equal(original.receipts.size, 1)
  const [operation, receipt] = [...original.receipts][0]!
  assert.equal(nativeCallablePrototypeMatches(receipt, { ...receipt, allocation: 'unrelated-allocation' as IrValueId }), false)
  const changedKey = nativeCallablePrototypeDescriptorsOf(
    changed(input, (current) =>
      current.kind === 'constant' && current.literal === 'string' && current.text === 'prototype'
        ? { ...current, text: 'constructor' }
        : current
    )
  )
  assert.equal(changedKey.receipts.has(operation), false)
  assert.equal(changedKey.required.has(operation), true)
  const changedReceiver = nativeCallablePrototypeDescriptorsOf(
    changed(input, (current) =>
      current === operation && current.kind === 'call'
        ? { ...current, arguments: [{ ...current.arguments[0]!, value: 'unrelated-owner' as IrValueId }, ...current.arguments.slice(1)] }
        : current
    )
  )
  assert.equal(changedReceiver.receipts.size, 0)
  assert.match(result.source!, /__gea_descriptor->dataValue\(\)/)
  assert.match(result.source!, /gea::installCallableNativePrototype\(__gea_callable, /)
  assert.doesNotMatch(result.source!, /installCallableConstructorPrototype\(__gea_callable\)/)
})
const changed = (
  input: PublishNativeCallableDataSlotsInput,
  change: (operation: IrNonTerminatorOperation) => IrNonTerminatorOperation
): PublishNativeCallableDataSlotsInput => ({
  ...input,
  bodies: new Map(
    [...input.bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map([...body.blocks].map(([key, block]) => [key, { ...block, operations: block.operations.map(change) }]))
      }
    ])
  )
})

test('a complete descriptor key domain avoids constructor demand only on its actual native source frame', () => {
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([
      [
        entry,
        `export {}; function inspect(key: string | symbol) {
          const descriptor = Object.getOwnPropertyDescriptor(Date.prototype.getTime, key)
          console.log(descriptor?.writable)
        }
        inspect('name'); inspect('length')`
      ]
    ])
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  const input = inputOf(result)
  const source = [...input.graph.operations.values()].find(
    (operation) => operation.family === 'invocation' && operation.intrinsicDescriptorKeys !== undefined
  )
  assert.ok(source?.family === 'invocation' && source.intrinsicDescriptorKeys)
  const key = operandOf(source, 'argument', 1)!
  assert.equal(key.source.kind, 'result')
  if (key.source.kind !== 'result') throw new Error('the source key was not a result')
  assert.equal(source.intrinsicDescriptorKeys.key, key.source.result)
  assert.deepEqual(new Set(source.intrinsicDescriptorKeys.names), new Set(['name', 'length']))
  assert.equal(nativeCallablePrototypeDescriptorsOf(input).required.size, 0)
  // The host-method authentication reads the callee-rendering graph and
  // requires it to hold this exact source operation, so a forged source must
  // replace it in the one graph both readers share, as a real compile does.
  const withSource = (replacement: Extract<SemanticOperation, { family: 'invocation' }>): PublishNativeCallableDataSlotsInput => {
    const graph = {
      ...input.graph,
      operations: new Map([...input.graph.operations].map(([id, operation]) => [id, id === source.id ? replacement : operation]))
    }
    return { ...input, graph, calleeRendering: { ...input.calleeRendering!, graph } }
  }
  const { intrinsicDescriptorKeys: _domain, ...unproved } = source
  assert.ok(nativeCallablePrototypeDescriptorsOf(withSource(unproved)).required.size > 0)
  assert.ok(
    nativeCallablePrototypeDescriptorsOf(
      withSource({ ...source, intrinsicDescriptorKeys: { key: 'unrelated-key' as SemanticResultId, names: ['name', 'length'] } })
    ).required.size > 0
  )
  assert.ok(
    nativeCallablePrototypeDescriptorsOf(
      withSource({ ...source, intrinsicDescriptorKeys: { key: key.source.result, names: ['name', 'prototype'] } })
    ).required.size > 0
  )
  const wrongKey = changed(input, (operation) =>
    operation.kind === 'call' && operation.lineage !== null && input.graph.results.get(operation.lineage) === source.id
      ? { ...operation, arguments: [operation.arguments[0]!, { ...operation.arguments[1]!, value: 'unrelated-key' as IrValueId }] }
      : operation
  )
  assert.ok(nativeCallablePrototypeDescriptorsOf(wrongKey).required.size > 0)
  assert.equal(nativeCallablePrototypeDescriptorsOf(wrongKey).receipts.size, 0)
})

test('native prototype replay authenticates the actual allocation and complete physical packing frame', () => {
  const result = resultOf()
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  const input = inputOf(result)
  const original = nativeCallablePrototypeReadsOf(input)
  assert.equal(original.receipts.size, 1)
  const [read, receipt] = [...original.receipts][0]!
  assert.equal(receipt.entry.restFrom, 1)
  const allocations = [...input.bodies.values()]
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter((operation) => operation.kind === 'allocate-callable' && operation.result.id === receipt.allocation)
  assert.equal(allocations.length, 1)
  const definitions = new Map(
    [...input.bodies.values()]
      .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
      .flatMap((operation) => ('result' in operation && operation.result ? [[operation.result.id, operation] as const] : []))
  )
  let receiver = definitions.get(receipt.receiver.value)
  while (receiver?.kind === 'convert') receiver = definitions.get(receiver.source.value)
  assert.ok(receiver?.kind === 'binding-read')
  const receiverRead = receiver
  const readId = input.graph.results.get(receiverRead.lineage)
  const semanticRead = readId === undefined ? undefined : input.graph.operations.get(readId)
  assert.ok(semanticRead?.family === 'binding' && semanticRead.action === 'read')
  assert.equal(semanticRead.mutable, true)
  const initializer = [...input.graph.operations.values()].find(
    (operation) => operation.family === 'binding' && operation.action === 'initialize' && operation.declaration === receiverRead.declaration
  )
  assert.ok(initializer?.family === 'binding')
  const changedGraph = (parameterInitialization: boolean) => ({
    ...input,
    graph: {
      ...input.graph,
      operations: new Map(
        [...input.graph.operations].map(([id, operation]) => [
          id,
          operation === initializer
            ? parameterInitialization
              ? { ...initializer, parameterInitialization: true as const }
              : { ...initializer, action: 'write' as const }
            : operation
        ])
      )
    }
  })
  assert.equal(nativeCallablePrototypeReadsOf(changedGraph(false)).receipts.size, 0)
  assert.equal(nativeCallablePrototypeReadsOf(changedGraph(true)).receipts.size, 0)
  const wrongRead = nativeCallablePrototypeReadsOf(
    changed(input, (operation) => (operation === receiverRead ? { ...receiverRead, lineage: receipt.source } : operation))
  )
  assert.equal(wrongRead.receipts.size, 0)
  const repeatedAllocation = nativeCallablePrototypeReadsOf({
    ...input,
    bodies: new Map(
      [...input.bodies].map(([id, body]) => [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([key, block]) => [
              key,
              {
                ...block,
                operations: block.operations.flatMap((operation) =>
                  operation.kind === 'allocate-callable' && operation.result.id === receipt.allocation
                    ? [operation, { ...operation, result: { ...operation.result, id: 'forged-same-source-allocation' as IrValueId } }]
                    : [operation]
                )
              }
            ])
          )
        }
      ])
    )
  })
  assert.equal(repeatedAllocation.receipts.size, 0)
  const repeatedInitializer = nativeCallablePrototypeReadsOf({
    ...input,
    bodies: new Map(
      [...input.bodies].map(([id, body]) => [
        id,
        {
          ...body,
          blocks: new Map(
            [...body.blocks].map(([key, block]) => [
              key,
              {
                ...block,
                operations: block.operations.flatMap((operation) =>
                  operation.kind === 'binding-write' && operation.declaration === receiverRead.declaration
                    ? [operation, { ...operation }]
                    : [operation]
                )
              }
            ])
          )
        }
      ])
    )
  })
  assert.equal(repeatedInitializer.receipts.size, 0)
  const missingFact = nativeCallablePrototypeReadsOf(
    changed(input, (operation) =>
      operation.kind === 'allocate-callable' && operation.result.id === receipt.allocation
        ? { ...operation, callableOwnPrototype: false }
        : operation
    )
  )
  assert.equal(missingFact.receipts.size, 0)
  assert.equal(missingFact.required.size, 1)
  const wrongOperand = nativeCallablePrototypeReadsOf(
    changed(input, (operation) =>
      operation === read && operation.kind === 'get'
        ? { ...operation, receiver: { ...operation.receiver, value: 'unrelated-same-frame' as IrValueId } }
        : operation
    )
  )
  assert.equal(wrongOperand.receipts.size, 0)
  const wrongFrame = nativeCallablePrototypeReadsOf(
    changed(input, (operation) => {
      if (operation !== read || operation.kind !== 'get' || !('abi' in operation.receiver.representation)) return operation
      return {
        ...operation,
        receiver: {
          ...operation.receiver,
          representation: {
            ...operation.receiver.representation,
            abi: { ...operation.receiver.representation.abi, argumentsFrame: 'actual' }
          }
        }
      }
    })
  )
  assert.equal(wrongFrame.receipts.size, 0)
  const missingBody = nativeCallablePrototypeReadsOf({
    ...input,
    bodies: new Map([...input.bodies].filter(([, body]) => body.sourceOwner !== receipt.owner))
  })
  assert.equal(missingBody.receipts.size, 0)
})
