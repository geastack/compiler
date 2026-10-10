import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { FunctionId, SemanticResultId } from '../identity/ids.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { CallOperation, ConvertOperation, IrOperation } from './model.js'
import { nativeCallableSourceOf, nativeCallableSourceMatches, nativeCallableArgumentEntryOf } from './native-callable-argument.js'

const base: Representation = {
  kind: 'class-ref',
  declaration: 'emitter' as never,
  shapeId: 'emitter',
  ancestors: [],
  ownership: 'shared-refcount'
}
const child: Representation = { ...base, declaration: 'child' as never, shapeId: 'child', ancestors: [base.declaration] }
const physical: CallableAbi = { receiver: child, parameters: [], restFrom: null, result: { kind: 'void' } }
const source: Representation = { kind: 'function-value-dispatch', abi: physical }
const target: Representation = { ...source, abi: { ...physical, receiver: base } }
const origin = 'native-source' as SemanticResultId
const callable = 'native-body' as FunctionId
const argument = { role: 'argument', ordinal: 0, source: { kind: 'result', result: origin } } as SemanticOperand
const semantic = { family: 'invocation', operands: [argument] } as unknown as SemanticOperation
const origins = new Map([[origin, callable]])
const abis = new Map([[callable, physical]])

test('known native source bodies authenticate future receiver frames, while equal unknown callable types do not', () => {
  assert.deepEqual(nativeCallableSourceOf(semantic, argument, source, target, origins, abis), {
    origin,
    callable,
    role: 'argument',
    ordinal: 0
  })
  assert.equal(nativeCallableSourceOf(semantic, argument, source, target, new Map(), abis), null)
  assert.equal(nativeCallableSourceOf(semantic, argument, source, target, origins, new Map()), null)
  assert.equal(
    nativeCallableSourceOf(semantic, argument, source, target, origins, new Map([[callable, { ...physical, receiver: base }]])),
    null
  )
  assert.equal(nativeCallableSourceOf(semantic, { ...argument, role: 'receiver' }, source, target, origins, abis), null)
})

test('property, binding, return and element transfers share exact source-body and operand-role authentication', () => {
  for (const [operation, role] of [
    [{ family: 'property', internalMethod: 'set' }, 'value'],
    [{ family: 'binding', action: 'initialize' }, 'initializer'],
    [{ family: 'binding', action: 'write' }, 'value'],
    [{ family: 'control', form: 'return' }, 'value'],
    [{ family: 'allocation', allocated: 'array-literal' }, 'element']
  ] as const) {
    const operand = { ...argument, role }
    const consumer = { ...operation, operands: [operand] } as unknown as SemanticOperation
    assert.deepEqual(nativeCallableSourceOf(consumer, operand, source, target, origins, abis), { origin, callable, role, ordinal: 0 })
    assert.equal(nativeCallableSourceOf(consumer, operand, source, target, new Map(), abis), null)
    assert.equal(nativeCallableSourceOf(consumer, { ...operand, role: 'receiver' }, source, target, origins, abis), null)
  }
})

test('the proof retains the actual source Function and cannot cite an ordinary or counterfeited recipe', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nativeMethodFor(source, target)
  assert.ok(node)
  const ordinary = conversions.nodeFor(source, target)
  assert.notEqual(ordinary, node)
  const proof = nativeCallableSourceOf(semantic, argument, source, target, origins, abis)!
  const converted = {
    kind: 'convert',
    source: { value: 'source', representation: source },
    result: { id: 'adapted', representation: target },
    conversionUse: node.id,
    nativeCallableSource: proof
  } as unknown as ConvertOperation
  const allocation = { kind: 'allocate-callable', functionId: callable, lineage: origin, result: { id: 'source' } } as Extract<
    IrOperation,
    { kind: 'allocate-callable' }
  >
  assert.equal(nativeCallableSourceMatches(converted, semantic, allocation, origins, abis, conversions), true)
  assert.equal(
    nativeCallableSourceMatches(converted, semantic, { ...allocation, lineage: 'other-allocation' as never }, origins, abis, conversions),
    false
  )
  assert.equal(
    nativeCallableSourceMatches(
      converted,
      semantic,
      { ...allocation, result: { ...allocation.result, id: 'other-value' as never } },
      origins,
      abis,
      conversions
    ),
    false
  )
  assert.equal(nativeCallableSourceMatches(converted, semantic, null, origins, abis, conversions), false)
  assert.equal(
    nativeCallableSourceMatches(converted, semantic, { ...allocation, functionId: 'other' as FunctionId }, origins, abis, conversions),
    false
  )
  assert.equal(
    nativeCallableSourceMatches({ ...converted, conversionUse: ordinary.id }, semantic, allocation, origins, abis, conversions),
    false
  )
  assert.equal(
    nativeCallableSourceMatches(converted, semantic, allocation, origins, abis, { ...conversions, nodeById: () => ({ ...node }) }),
    false
  )
})

test('semantic assignment aliases authenticate the original SSA value without authorizing another same-body allocation', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nativeMethodFor(source, target)!
  const alias = 'assignment-result' as SemanticResultId
  const operand = { ...argument, source: { kind: 'result' as const, result: alias } }
  const consumer = { ...semantic, operands: [operand] } as SemanticOperation
  const sourceOrigins = new Map([...origins, [alias, callable]])
  const proof = nativeCallableSourceOf(consumer, operand, source, target, sourceOrigins, abis)!
  const converted = {
    kind: 'convert',
    source: { value: 'source', representation: source },
    result: { id: 'adapted', representation: target },
    conversionUse: node.id,
    nativeCallableSource: proof
  } as unknown as ConvertOperation
  const allocation = {
    kind: 'allocate-callable',
    functionId: callable,
    lineage: origin,
    result: { id: 'source', representation: source }
  } as unknown as IrOperation
  const aliasOperation = {
    family: 'binding',
    action: 'initialize',
    operands: [{ ...argument, role: 'initializer' }]
  } as unknown as SemanticOperation
  const graph = {
    results: new Map([[alias, 'alias-operation' as never]]),
    operations: new Map([['alias-operation' as never, aliasOperation]])
  }
  assert.equal(nativeCallableSourceMatches(converted, consumer, allocation, sourceOrigins, abis, conversions), false)
  assert.equal(nativeCallableSourceMatches(converted, consumer, allocation, sourceOrigins, abis, conversions, graph), true)
  assert.equal(
    nativeCallableSourceMatches(
      converted,
      consumer,
      { ...allocation, lineage: 'other-allocation' as never },
      sourceOrigins,
      abis,
      conversions,
      graph
    ),
    false
  )
})

test('native prototype argument recipes consume actual source identity and reject unknown equal carriers', () => {
  const operation = {
    kind: 'call',
    arguments: [{ value: 'argument', representation: source }]
  } as unknown as CallOperation
  const allocation = { kind: 'allocate-callable', functionId: callable } as Extract<IrOperation, { kind: 'allocate-callable' }>
  assert.deepEqual(
    nativeCallableArgumentEntryOf(operation, 0, target, () => allocation, abis),
    { ordinal: 0, callables: [callable] }
  )
  const binding = { kind: 'binding-read', closedCallable: { kind: 'exact', functionId: callable } } as Extract<
    IrOperation,
    { kind: 'binding-read' }
  >
  assert.deepEqual(
    nativeCallableArgumentEntryOf(operation, 0, target, () => binding, abis),
    { ordinal: 0, callables: [callable] }
  )
  assert.equal(
    nativeCallableArgumentEntryOf(operation, 0, target, () => ({ kind: 'parameter' }) as IrOperation, abis),
    null
  )
  assert.equal(
    nativeCallableArgumentEntryOf(operation, 0, target, () => allocation, new Map()),
    null
  )
  assert.equal(
    nativeCallableArgumentEntryOf(operation, 0, target, () => allocation, new Map([[callable, { ...physical, receiver: base }]])),
    null
  )
  assert.equal(
    nativeCallableArgumentEntryOf(operation, 1, target, () => allocation, abis),
    null
  )
})

const emitter = `
type Handler = (this: Emitter, ...args: any[]) => unknown
class Emitter {
  private fns: Handler[] = []
  on(fn: () => void): this
  on(fn: Handler): this { this.fns.push(fn); return this }
  emit(): void { for (const fn of this.fns) fn.call(this) }
}
class Child extends Emitter { label = 'child' }
`
test('a named function with native this enters an emitter subclass slot through an authenticated argument recipe', () => {
  const entry = resolve('test/runtime/split-copy-this-listener-into-emitter-slot.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    includeIr: true,
    closedScriptScope: true,
    sourceOverlay: new Map([
      [
        entry,
        emitter +
          `
function show(this: Child): void { console.log(this.label) }
const child = new Child()
child.on(show)
child.emit()
`
      ]
    ])
  })
  const recipes = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation): operation is ConvertOperation => operation.kind === 'convert' && operation.nativeCallableSource !== undefined)
  assert.equal(recipes.length, 1)
  assert.equal(result.certificate !== null, true, JSON.stringify(result.refusals))
})

test('a receiver-bearing function parameter cannot acquire the same source proof from its type', () => {
  const entry = resolve('test/runtime/split-copy-this-listener-into-emitter-slot.runtime.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    includeIr: true,
    sourceOverlay: new Map([
      [
        entry,
        emitter +
          `
class Other extends Emitter { label = 'other' }
export function register(emitter: Emitter, unknownSource: (this: Child | Other) => void): void { emitter.on(unknownSource) }
const externalSource: (this: Child | Other) => void = JSON.parse('null')
register(new Child(), externalSource)
`
      ]
    ])
  })
  const recipes = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation) => operation.kind === 'convert' && operation.nativeCallableSource !== undefined)
  assert.equal(recipes.length, 0)
  assert.equal(result.certificate, null)
  assert.ok(result.refusals.some((refusal) => refusal.key.startsWith('conversion:')))
})

test('a known native-this Function assignment acquires a source recipe, while an equal parameter does not', () => {
  const entry = resolve('test/runtime/native-method-public-frame.runtime.ts')
  const prefix = `
class Base { total = 0; hook(a: number, b: number): void {} }
class Child extends Base { offset = 10 }
const child = new Child()
function invoke(value: Base): void { value.hook(1, 2) }
`
  const run = (code: string) =>
    compile({
      rootFileNames: [entry],
      projectFileName: null,
      includeIr: true,
      closedScriptScope: true,
      sourceOverlay: new Map([[entry, prefix + code]])
    })
  const known = run(`
child.hook = function(this: Child, a: number, b: number): void { this.total = this.offset + a + b }
invoke(child)
`)
  const proofs = (known.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation): operation is ConvertOperation => operation.kind === 'convert' && operation.nativeCallableSource !== undefined)
  assert.ok(proofs.some((operation) => operation.nativeCallableSource?.role === 'value'))
  assert.notEqual(known.certificate, null, JSON.stringify(known.refusals))
  const unknown = run(`
function install(value: Child, input: (this: Child, a: number, b: number) => void): void { value.hook = input }
const input: (this: Child, a: number, b: number) => void = JSON.parse('null')
install(child, input)
invoke(child)
`)
  assert.equal(unknown.certificate, null)
  assert.ok(unknown.refusals.some((refusal) => refusal.key.startsWith('conversion:')))
})
