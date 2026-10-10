import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import type { IrBody } from './model.js'
import { createReadOnlyDictionaryAuthority } from './read-only-dictionary.js'

const string: Representation = { kind: 'string' }
const dictionary: Representation = { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' }
const abi: CallableAbi = {
  receiver: null,
  parameters: [{ value: dictionary, passing: 'by-value', ownership: 'shared-refcount' }],
  restFrom: null,
  result: { kind: 'void' }
}
const callable: Representation = { kind: 'function-value-dispatch', abi }
const owner = 'readonly-dictionary-owner' as FunctionId
const consumer = 'readonly-dictionary-consumer' as FunctionId
const cell = 'readonly-dictionary-cell' as DeclarationId
const lineage = (name: string) => name as SemanticResultId
const operand = (value: IrValueId, representation: Representation) => ({ value, representation })
const fixture = (mode: 'read' | 'write' | 'return' | 'capture' | 'call' | 'unknown-call' | 'mutating-call' = 'read') => {
  const id = 'readonly-dictionary-body' as PhysicalBodyId
  const builder = createIrBodyBuilder(id, owner, abi)
  const block = builder.openBlock()
  const root = builder.parameter(block, lineage('dictionary'), 0, dictionary)
  const key = builder.constant(block, lineage('key'), 'key', 'string', string)
  builder.bindingWrite(block, lineage('local-store'), cell, operand(root, dictionary))
  const alias = builder.bindingRead(block, lineage('local-read'), cell, dictionary)
  builder.get(block, lineage('entry-read'), operand(alias, dictionary), operand(key, string), string)
  if (mode === 'write')
    builder.set(block, lineage('write'), operand(alias, dictionary), operand(key, string), operand(key, string), true, null)
  if (mode === 'capture') builder.allocateCallable(block, lineage('capture'), consumer, [operand(alias, dictionary)], callable)
  if (mode === 'call' || mode === 'unknown-call' || mode === 'mutating-call') {
    const target = builder.allocateCallable(block, lineage('callee'), consumer, [], callable)
    builder.call(block, lineage('closed-consumer'), operand(target, callable), null, [operand(alias, dictionary)], null)
  }
  builder.return(block, null, mode === 'return' ? operand(alias, dictionary) : null)
  const body = builder.seal()
  const identified: IrBody = {
    ...body,
    blocks: new Map(
      [...body.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((operation) =>
            operation.kind === 'call' && mode !== 'unknown-call'
              ? { ...operation, closedCallee: { kind: 'exact' as const, functionId: consumer } }
              : operation
          )
        }
      ])
    )
  }
  const childId = 'readonly-dictionary-consumer-body' as PhysicalBodyId
  const child = createIrBodyBuilder(childId, consumer, abi)
  const entry = child.openBlock()
  const parameter = child.parameter(entry, lineage('consumer-parameter'), 0, dictionary)
  const name = child.constant(entry, lineage('consumer-key'), 'key', 'string', string)
  child.get(entry, lineage('consumer-read'), operand(parameter, dictionary), operand(name, string), string)
  if (mode === 'mutating-call')
    child.set(entry, lineage('consumer-write'), operand(parameter, dictionary), operand(name, string), operand(name, string), true, null)
  child.return(entry, null, null)
  const bodies = new Map([
    [id, identified],
    [childId, child.seal()]
  ])
  const placements = new Map<DeclarationId, BindingPlacement>([[cell, { storage: { kind: 'local', owner }, representation: dictionary }]])
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const inputs = { bodies, placements, conversions, classes: new Map() }
  return { root, alias, parameter, id, inputs }
}

test('a header initializer merge seals a complete readonly dispatch for both its live cache and fallback dictionary', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/merge-arm-dictionary-into-header-union.ts')],
    projectFileName: null,
    closedScriptScope: true,
    includeIr: true
  })
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
  const views = operations.filter((operation) => {
    if (operation.kind !== 'convert') return false
    const node = result.conversionCensus.nodeById(operation.conversionUse)
    return node?.capability.kind === 'static' && node.capability.materializer.readOnlyDictionary !== undefined
  })
  assert.equal(views.length, 2, 'both the live cache arm and conditional fallback need a complete reader')
  for (const operation of views) {
    assert.equal(operation.kind, 'convert')
    if (operation.kind !== 'convert') continue
    assert.ok(operation.readOnlyDictionaryProof)
    assert.equal(operation.readOnlyDictionaryProof.root, operation.result.id)
  }
})

test('a readonly dictionary proof seals every local alias and actual read consumer', () => {
  const input = fixture()
  const authority = createReadOnlyDictionaryAuthority(input.inputs)
  const proof = authority.proofOf(input.root)
  assert.ok(proof)
  assert.ok(proof.aliases.includes(input.alias))
  assert.ok(proof.consumers.some((operation) => operation.lineage === 'entry-read'))
  assert.equal(createReadOnlyDictionaryAuthority(input.inputs).matches(input.root, proof), true)
  assert.equal(authority.matches(input.alias, proof), false)
  assert.equal(authority.matches(input.root, { ...proof, consumers: [] }), false)
})

test('a readonly dictionary view cannot mutate, escape, or enter an unproved callback', () => {
  for (const mode of ['write', 'return', 'capture', 'unknown-call', 'mutating-call'] as const) {
    const input = fixture(mode)
    assert.equal(createReadOnlyDictionaryAuthority(input.inputs).proofOf(input.root), null, mode)
  }
})

test('an exact synchronous consumer is walked through its actual source body', () => {
  const input = fixture('call')
  const authority = createReadOnlyDictionaryAuthority(input.inputs)
  const proof = authority.proofOf(input.root)
  assert.ok(proof)
  assert.ok(proof.aliases.includes(input.parameter))
  assert.ok(proof.consumers.some((operation) => operation.lineage === 'consumer-read'))
  const changed = fixture('mutating-call')
  assert.equal(createReadOnlyDictionaryAuthority(changed.inputs).matches(input.root, proof), false)
})

test('a local alias cannot be substituted with externally retained storage', () => {
  const input = fixture()
  const placements = new Map<DeclarationId, BindingPlacement>([
    [cell, { storage: { kind: 'external', linkageName: 'externally-retained' }, representation: dictionary }]
  ])
  assert.equal(createReadOnlyDictionaryAuthority({ ...input.inputs, placements }).proofOf(input.root), null)
})

test('implicit cell captures cannot hide behind an empty allocation capture operand', () => {
  const input = fixture()
  const id = 'implicit-capture-body' as PhysicalBodyId
  const builder = createIrBodyBuilder(id, consumer, abi)
  const block = builder.openBlock()
  builder.bindingRead(block, lineage('implicit-captured-read'), cell, dictionary)
  builder.return(block, null, null)
  const bodies = new Map(input.inputs.bodies)
  bodies.set(id, builder.seal())
  assert.equal(createReadOnlyDictionaryAuthority({ ...input.inputs, bodies }).proofOf(input.root), null)
})

test('a transitive capture fact cannot hide behind removed direct cell reads', () => {
  const input = fixture()
  const bodies = new Map(input.inputs.bodies)
  const child = [...bodies.values()].find((body) => body.sourceOwner === consumer)!
  bodies.set(child.owner, {
    ...child,
    facts: {
      capturedDeclarations: [cell],
      capturedReceiver: null,
      allocatedAsValue: true,
      readsReceiver: false,
      boxed: new Set(),
      requiresEarlyBox: new Set()
    }
  })
  assert.equal(createReadOnlyDictionaryAuthority({ ...input.inputs, bodies }).proofOf(input.root), null)
})

test('a forged carrier-only host template cannot bypass an actual mutating body', () => {
  const input = fixture('mutating-call')
  const bodies = new Map(
    [...input.inputs.bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) =>
                operation.kind === 'call' ? { ...operation, hostTemplate: 'array-is-array' as const } : operation
              )
            }
          ])
        )
      }
    ])
  )
  assert.equal(createReadOnlyDictionaryAuthority({ ...input.inputs, bodies }).proofOf(input.root), null)
})

test('a rest frame cannot hide the readonly handle inside a mutable array element', () => {
  const input = fixture()
  const packed: Representation = { kind: 'array-object', element: dictionary, ownership: 'shared-refcount', extension: null }
  const restAbi: CallableAbi = { ...abi, restFrom: 0, parameters: [{ ...abi.parameters[0]!, value: packed }] }
  const restCallable: Representation = { kind: 'function-value-dispatch', abi: restAbi }
  const builder = createIrBodyBuilder(input.id, owner, abi)
  const block = builder.openBlock()
  const root = builder.parameter(block, lineage('rest-root'), 0, dictionary)
  const target = builder.allocateCallable(block, lineage('rest-callee'), consumer, [], restCallable)
  builder.call(block, lineage('rest-consumer'), operand(target, restCallable), null, [operand(root, dictionary)], null)
  builder.return(block, null, null)
  const raw = builder.seal()
  const caller: IrBody = {
    ...raw,
    blocks: new Map(
      [...raw.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((operation) =>
            operation.kind === 'call' ? { ...operation, closedCallee: { kind: 'exact' as const, functionId: consumer } } : operation
          )
        }
      ])
    )
  }
  const child = createIrBodyBuilder('rest-consumer-body' as PhysicalBodyId, consumer, restAbi)
  const entry = child.openBlock()
  const parameter = child.parameter(entry, lineage('rest-parameter'), 0, packed)
  const index = child.constant(entry, lineage('rest-index'), '0', 'number', { kind: 'scalar', domain: 'number' })
  const element = child.get(
    entry,
    lineage('rest-element'),
    operand(parameter, packed),
    operand(index, { kind: 'scalar', domain: 'number' }),
    dictionary
  )
  const key = child.constant(entry, lineage('rest-key'), 'key', 'string', string)
  child.set(entry, lineage('rest-write'), operand(element, dictionary), operand(key, string), operand(key, string), true, null)
  child.return(entry, null, null)
  const callee = child.seal()
  const bodies = new Map([
    [caller.owner, caller],
    [callee.owner, callee]
  ])
  assert.equal(createReadOnlyDictionaryAuthority({ ...input.inputs, bodies }).proofOf(root), null)
})
