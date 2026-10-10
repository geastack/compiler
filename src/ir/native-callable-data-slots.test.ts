import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile, type CompilationResult } from '../compiler.js'
import { allOperationsOf, type IrOperation } from './model.js'
import { nativeCallableDataSlotInputOf, nativeCallableDataSlotMatches, nativeCallableDataSlotsOf } from './native-callable-data-slots.js'
import { callableOwnDataWriterAt } from '../semantics/callable-own-data-slots.js'
import { nodeOfOperation, type StructuralTypeId } from '../identity/ids.js'

const entry = resolve('test/runtime/native-function-data-slots.runtime.ts')
const original = readFileSync(entry, 'utf8')
const compileSource = (source = original) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })
const operationsOf = (result: CompilationResult): IrOperation[] =>
  (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
const receiptsOf = (result: CompilationResult) =>
  operationsOf(result).flatMap((operation) =>
    (operation.kind === 'get' || operation.kind === 'set' || operation.kind === 'call') && operation.nativeCallableDataSlot
      ? [{ operation, receipt: operation.nativeCallableDataSlot }]
      : []
  )

const primitivesOf = (result: CompilationResult, type: StructuralTypeId): string[] => {
  const shape = result.graph.structuralTypes.get(type)?.shape
  if (shape?.kind === 'primitive' || shape?.kind === 'literal') return [shape.primitive]
  if (shape?.kind === 'union') return [...new Set(shape.members.flatMap((member) => primitivesOf(result, member)))].sort()
  return [shape?.kind ?? 'missing']
}

test('actual native Function data storage retains own descriptors and the installed physical call frame', () => {
  const result = compileSource()
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const receipts = receiptsOf(result)
  assert.equal(receipts.filter(({ operation }) => operation.kind === 'call').length, 3)
  assert.equal(receipts.filter(({ operation }) => operation.kind === 'get').length, 3)
  assert.match(result.source!, /gea::callableNativeDataSet/)
  assert.match(result.source!, /gea::callableNativeDataGet/)
  assert.ok(!result.source!.includes('gea::callableDynamicSet'))
  const sourceCalls = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'invocation' && operation.selectedSignature?.sourceFrame?.kind === 'ordinary-own-data'
  )
  assert.equal(sourceCalls.length, 2)
  for (const operation of sourceCalls) {
    assert.equal(operation.family, 'invocation')
    if (operation.family !== 'invocation') continue
    const selected = operation.selectedSignature!
    assert.equal(selected.parameters.length, 2)
    assert.equal(selected.minimumArity, 2)
    assert.deepEqual(result.graph.structuralTypes.get(selected.returnType)?.shape, { kind: 'primitive', primitive: 'string' })
    assert.equal(operation.results.find((value) => value.role === 'value')?.type, selected.returnType)
    assert.equal(operation.resultDivergence.kind, 'ordinary-own-data-call-return')
    assert.deepEqual(
      operation.operands.filter((operand) => operand.role === 'argument').map((operand) => operand.ordinal),
      [0, 1]
    )
  }
  const erasedLabel = receipts.find(({ operation, receipt }) => operation.kind === 'get' && receipt.key === 'label')
  assert.ok(erasedLabel)
  assert.equal(erasedLabel.operation.kind, 'get')
  if (erasedLabel.operation.kind === 'get') {
    assert.equal(erasedLabel.operation.receiver.representation.kind, 'function-value-dispatch')
    assert.equal(erasedLabel.receipt.materialization, null)
  }
  const call = receipts.find(({ receipt }) => receipt.key === 'call')!.receipt
  assert.equal(call.storage.kind, 'function-value-dispatch')
  if (call.storage.kind === 'function-value-dispatch') {
    assert.equal(call.storage.abi.result.kind, 'string')
    assert.equal(call.storage.abi.parameters.length, 2)
  }
})

test('inferred const and complete let writer domains retain the installed result through typeof', () => {
  const entry = resolve('test/runtime/native-function-own-call-inferred-locals.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const operations = [...result.graph.operations.values()]
  const nativeResults = result.representations.nativeCallableData.results
  const initialized = operations.filter((operation) => operation.family === 'binding' && operation.action === 'initialize')
  for (const [name, expected] of [
    ['constant', ['string']],
    ['changing', ['number', 'string']],
    ['alias', ['string']]
  ] as const) {
    const binding = initialized.find((operation) => result.textOfNode(nodeOfOperation(operation.id))?.startsWith(`${name} =`))
    assert.ok(binding, name)
    assert.ok(binding.results[0])
    assert.deepEqual(primitivesOf(result, binding.results[0].type), expected, name)
    if (name === 'changing') assert.equal(nativeResults.has(binding.results[0].id), false, 'a first result cannot replace mutable storage')
  }
  const queries = operations.filter((operation) => operation.family === 'computation' && operation.form === 'typeof')
  assert.equal(queries.length, 4)
  for (const query of queries) {
    const name = result.textOfNode(nodeOfOperation(query.id))
    assert.ok(query.operands[0])
    assert.deepEqual(
      primitivesOf(result, query.operands[0].type),
      name === 'typeof changing' ? ['number', 'string'] : ['string'],
      name ?? ''
    )
  }
  assert.ok(!result.source!.includes('gea::callableDynamicSet'))
})

test('mixed callable writers cannot borrow the first installed physical frame', () => {
  const result = compileSource(`
    export {};
    function owner(value: string): number { return value.length }
    function secondOwner(value: string): number { return value.length }
    function installed(first: string, second: string): string { return first + second }
    function changed(first: string, second: string): number { return first.length + second.length }
    Reflect.set(owner, 'call', installed);
    Reflect.set(secondOwner, 'call', changed);
    let selected = owner.call;
    selected = secondOwner.call;
    console.log(typeof selected);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const nativeResults = result.representations.nativeCallableData.results
  const binding = [...result.graph.operations.values()].find(
    (operation) =>
      operation.family === 'binding' &&
      operation.action === 'initialize' &&
      result.textOfNode(nodeOfOperation(operation.id)) === 'selected = owner.call'
  )
  assert.ok(binding?.results[0])
  assert.equal(nativeResults.has(binding.results[0].id), false)
})

test('a void installed body gives its inferred local the actual undefined result', () => {
  const result = compileSource(`
    export {};
    function owner(value: string): number { return value.length }
    function installed(first: string, second: string): void { first.length; second.length; }
    Reflect.set(owner, 'call', installed);
    const observed = owner.call('first', 'second');
    console.log(typeof observed);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const query = [...result.graph.operations.values()].find((operation) => operation.family === 'computation' && operation.form === 'typeof')
  assert.ok(query?.operands[0])
  assert.deepEqual(primitivesOf(result, query.operands[0].type), ['undefined'])
  assert.ok(result.manifest.runtimeHelpers.has('computation:typeof:undefined'))
})

test('a receipt cannot replace the source body, owner allocation, key or actual installation', () => {
  const result = compileSource()
  const row = receiptsOf(result)[0]
  assert.ok(row)
  for (const changed of [
    { ...row.receipt, owner: 'different-function' as never },
    { ...row.receipt, ownerAllocation: 'other-allocation' as never },
    { ...row.receipt, writer: 'other-store' as never },
    { ...row.receipt, key: 'apply' },
    { ...row.receipt, value: { ...row.receipt.value, value: 'other-source' as never } }
  ])
    assert.equal(nativeCallableDataSlotMatches(row.receipt, changed), false)
  const source = callableOwnDataWriterAt(result.representations.nativeCallableData.census, row.receipt.writer)?.value?.callable
  assert.ok(source)
  const bodies = new Map(
    (result.irBodies ?? []).map((body) => [
      body.owner,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([id, block]) => [
            id,
            {
              ...block,
              operations: block.operations.map((operation) =>
                operation.kind === 'allocate-callable' && operation.functionId === source
                  ? { ...operation, functionId: 'substituted-body' as never }
                  : operation
              )
            }
          ])
        )
      }
    ])
  )
  const expected = nativeCallableDataSlotsOf(
    nativeCallableDataSlotInputOf({
      bodies,
      graph: result.graph,
      deriver: result.representations.deriver,
      placements: result.projection.placements,
      classes: result.projection.classes,
      conversions: result.conversionCensus,
      nativeCallableData: result.representations.nativeCallableData,
      programConversions: null
    })
  )
  assert.ok(![...expected.values()].some((receipt) => receipt.writer === row.receipt.writer))
})

test('unsupported receiver entry, opaque publication, mutation and explicit Reflect Receiver cannot gain native storage', () => {
  for (const source of [
    original.replace('return `${this.name}:${value}:${extra}`', 'return `${this.call}:${value}:${extra}`'),
    original.replace(
      "Reflect.set(target, 'call', replacement)",
      "Reflect.set(target, 'call', replacement); Reflect.set(target, 'call', independent)"
    ),
    original.replace("Reflect.set(target, 'call', replacement)", "Reflect.set(target, 'call', replacement, target)"),
    original.replace("Reflect.set(target, 'call', replacement)", "console.log(target); Reflect.set(target, 'call', replacement)")
  ]) {
    const result = compileSource(source)
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    const first = [...result.graph.operations.values()].find(
      (operation) => operation.family === 'invocation' && operation.intrinsicMutation === 'reflect-set'
    )
    assert.ok(first)
    assert.equal(result.representations.nativeCallableData.routeAt(first.id), null)
    assert.ok(!receiptsOf(result).some(({ receipt }) => receipt.writer === first.id))
    assert.equal(result.certificate, null, 'an unsupported native receipt cannot restore boxed Function data storage')
    assert.ok(result.refusals.some((refusal) => refusal.key === 'property-access:function:get:native-data-slot'))
  }
})

test('an opaque typed Function owner cannot box a typed stored Function without native storage authority', () => {
  const result = compileSource(`
    export {};
    function installed(value: string): string { return value }
    function install(owner: (value: string) => string) { Reflect.set(owner, 'label', installed) }
    declare function externalOwner(): (value: string) => string;
    install(externalOwner());
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.certificate, null)
  assert.ok(result.refusals.some((refusal) => refusal.key === 'property-access:function:get:native-data-slot'))
})

test('reading a selected native own slot before installation fails its presence proof', () => {
  const result = compileSource(
    original.replace(
      "Reflect.set(target, 'call', replacement)",
      "console.log(target.call('argument', 'payload')); Reflect.set(target, 'call', replacement)"
    )
  )
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.certificate, null)
  assert.ok(result.refusals.some((refusal) => refusal.key === 'property-access:function:get:native-data-slot'))
})

test('a closed typed Function slot cannot fall back to boxed storage when inherited descriptor proof is unavailable', () => {
  const result = compileSource(`
    export {};
    function owner(value: string): number { return value.length }
    function replacement(first: string, second: string): string { return first + second }
    declare function arbitrary(value: unknown): void;
    arbitrary('can reach constructor prototypes');
    Reflect.set(owner, 'call', replacement);
    console.log(owner.call('first', 'second'));
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(result.certificate, null)
  assert.ok(result.refusals.some((refusal) => refusal.key === 'property-access:function:get:native-data-slot'))
})
