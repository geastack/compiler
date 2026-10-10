import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { BindingOperation } from '../semantics/model/operations.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import { closedNormalResultsOf } from './closed-normal-results.js'
import type { CallOperation, IrBody } from './model.js'
import { pruneProvenBranches } from './proven-branches.js'
import { verifyIrBody } from './verify.js'

const undefinedValue: Representation = { kind: 'undefined' }
const string: Representation = { kind: 'string' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
const callable = 'normal-return-function' as FunctionId
const declaration = 'normal-return-binding' as DeclarationId
const lineage = (name: string): SemanticResultId => name as SemanticResultId
const operand = (value: IrValueId, representation: Representation) => ({ value, representation })
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })

const binding = (mutable = false): BindingOperation => ({
  id: 'normal-return-binding-operation' as never,
  family: 'binding',
  action: 'initialize',
  declaration,
  mutable,
  temporalDeadZone: false,
  caller: { kind: 'function', functionId: 'normal-return-caller' as FunctionId },
  operands: [],
  results: [],
  completion: normalCompletion,
  effects: pureEffects,
  evaluationOrdinal: 0
})

const graphOf = (mutable = false): Pick<SemanticGraph, 'operations'> => {
  const operation = binding(mutable)
  return { operations: new Map([[operation.id, operation]]) }
}

const fixture = (mode: 'undefined' | 'mixed' | 'phi' | 'void' | 'cycle' = 'undefined') => {
  const conversions = censusOf()
  const joined = mode === 'mixed' || mode === 'phi'
  const abi: CallableAbi = {
    receiver: null,
    parameters: joined ? [{ value: boolean, passing: 'by-value', ownership: 'owned' }] : [],
    restFrom: null,
    result: mode === 'void' ? { kind: 'void' } : optional
  }
  const functionValue: Representation = { kind: 'function-value-dispatch', abi }
  const bodyId = 'normal-return-body' as PhysicalBodyId
  const builder = createIrBodyBuilder(bodyId, callable, abi)
  const entry = builder.openBlock()
  const absent = (block: typeof entry) => {
    const value = builder.constant(block, lineage('actual-absence'), 'undefined', 'undefined', undefinedValue)
    const recipe = conversions.nodeFor(undefinedValue, optional)
    return builder.convert(block, lineage('absence-widening'), recipe.id, operand(value, undefinedValue), optional)
  }
  if (joined) {
    const left = builder.openBlock()
    const right = builder.openBlock()
    const condition = builder.parameter(entry, lineage('parameter'), 0, boolean)
    builder.branch(entry, lineage('condition'), operand(condition, boolean), left, right)
    const first = absent(left)
    const present = builder.constant(right, lineage('other-return'), 'present', 'string', string)
    const second =
      mode === 'phi'
        ? absent(right)
        : builder.convert(right, lineage('present-widening'), conversions.nodeFor(string, optional).id, operand(present, string), optional)
    if (mode === 'phi') {
      const join = builder.openBlock()
      builder.jump(left, null, join)
      builder.jump(right, null, join)
      const merged = builder.phi(
        join,
        lineage('return-phi'),
        [
          { block: left, value: operand(first, optional) },
          { block: right, value: operand(second, optional) }
        ],
        optional
      )
      builder.return(join, null, operand(merged, optional))
    } else {
      builder.return(left, null, operand(first, optional))
      builder.return(right, null, operand(second, optional))
    }
  } else if (mode === 'void') {
    builder.constant(entry, lineage('discarded-value'), 'present', 'string', string)
    builder.return(entry, null, null)
  } else if (mode === 'cycle') {
    const value = builder.allocateCallable(entry, lineage('recursive-source'), callable, [], functionValue)
    const result = builder.call(entry, lineage('recursive-call'), operand(value, functionValue), null, [], optional)!
    builder.return(entry, null, operand(result, optional))
  } else builder.return(entry, null, operand(absent(entry), optional))
  const body = identifyCalls(builder.seal())

  const callerId = 'normal-return-caller-body' as PhysicalBodyId
  const callerOwner = 'normal-return-caller' as FunctionId
  const caller = createIrBodyBuilder(callerId, callerOwner, null)
  const start = caller.openBlock()
  const unreachable = caller.openBlock()
  const finish = caller.openBlock()
  const functionId = caller.allocateCallable(start, lineage('source'), callable, [], functionValue)
  const condition = caller.constant(start, lineage('argument'), 'true', 'boolean', boolean)
  const called = caller.call(
    start,
    lineage('effectful-call'),
    operand(functionId, functionValue),
    null,
    joined ? [operand(condition, boolean)] : [],
    optional
  )!
  caller.bindingWrite(start, lineage('stored-call-result'), declaration, operand(called, optional))
  const read = caller.bindingRead(start, lineage('read-call-result'), declaration, optional)
  const name = caller.compute(start, lineage('type-name'), 'typeof', 'typeof', [operand(read, optional)], string)
  const functionName = caller.constant(start, lineage('function-name'), 'function', 'string', string)
  const guard = caller.compute(
    start,
    lineage('typeof-guard'),
    'equality',
    '===',
    [operand(name, string), operand(functionName, string)],
    boolean
  )
  caller.branch(start, lineage('branch'), operand(guard, boolean), unreachable, finish)
  const key = caller.constant(unreachable, lineage('prototype-key'), 'prototype', 'string', string)
  caller.get(unreachable, lineage('dead-property-read'), operand(read, optional), operand(key, string), string)
  caller.jump(unreachable, null, finish)
  caller.return(finish, null, null)
  const callerBody = identifyCalls(caller.seal())
  const bodies = new Map([
    [callerId, callerBody],
    [bodyId, body]
  ])
  const placements = new Map<DeclarationId, BindingPlacement>([
    [declaration, { storage: { kind: 'local', owner: callerOwner }, representation: optional }]
  ])
  return { bodies, conversions, placements, callerId, bodyId, called, read, guard, start, unreachable, finish }
}

const identifyCalls = (body: IrBody): IrBody => ({
  ...body,
  blocks: new Map(
    [...body.blocks].map(([id, block]) => [
      id,
      {
        ...block,
        operations: block.operations.map((operation) =>
          operation.kind === 'call' ? { ...operation, closedCallee: { kind: 'exact' as const, functionId: callable } } : operation
        )
      }
    ])
  )
})

test('a closed actual undefined return prunes the prototype arm and preserves call evaluation', () => {
  const found = fixture()
  const facts = closedNormalResultsOf(found.bodies, graphOf(), found)
  assert.equal(facts.undefinedValues.has(found.called), true)
  assert.equal(facts.undefinedValues.has(found.read), true)
  assert.equal(facts.truthiness.get(found.guard), false)
  const result = pruneProvenBranches(found.bodies, graphOf(), [], found).bodies.get(found.callerId)!
  assert.equal(result.blocks.has(found.unreachable), false)
  assert.deepEqual(result.blocks.get(found.start)!.terminator, { kind: 'jump', lineage: lineage('branch'), target: found.finish })
  assert.ok(
    result.blocks.get(found.start)!.operations.some((operation) => operation.kind === 'call' && operation.result?.id === found.called)
  )
  assert.deepEqual(verifyIrBody(result), [])
})

test('all physical phi returns must preserve the same actual undefined state', () => {
  const same = fixture('phi')
  assert.equal(closedNormalResultsOf(same.bodies, graphOf(), same).undefinedValues.has(same.called), true)
  for (const mode of ['mixed', 'void', 'cycle'] as const) {
    const found = fixture(mode)
    assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.called), false, mode)
  }
})

test('unknown, substituted and async callees cannot borrow an absent-return body summary', () => {
  for (const mode of ['unknown', 'substituted', 'async'] as const) {
    const found = fixture()
    const caller = found.bodies.get(found.callerId)!
    if (mode === 'async') found.bodies.set(found.bodyId, { ...found.bodies.get(found.bodyId)!, async: true })
    else {
      if (mode === 'substituted') {
        const source = found.bodies.get(found.bodyId)!
        const otherId = 'other-normal-return-body' as PhysicalBodyId
        const other = createIrBodyBuilder(otherId, 'another-source' as FunctionId, source.abi)
        const entry = other.openBlock()
        const value = other.constant(entry, lineage('other-absence'), 'undefined', 'undefined', undefinedValue)
        const converted = other.convert(
          entry,
          lineage('other-return'),
          found.conversions.nodeFor(undefinedValue, optional).id,
          operand(value, undefinedValue),
          optional
        )
        other.return(entry, null, operand(converted, optional))
        found.bodies.set(otherId, other.seal())
      }
      found.bodies.set(found.callerId, {
        ...caller,
        blocks: new Map(
          [...caller.blocks].map(([id, block]) => [
            id,
            {
              ...block,
              operations: block.operations.map((operation) => {
                if (operation.kind !== 'call') return operation
                const { closedCallee: _, ...unproved } = operation
                return mode === 'unknown'
                  ? unproved
                  : ({ ...operation, closedCallee: { kind: 'exact', functionId: 'another-source' as FunctionId } } satisfies CallOperation)
              })
            }
          ])
        )
      })
    }
    assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.called), false, mode)
  }
})

test('known undefined is false for each absence predicate, while unknown parameters remain unproved', () => {
  const conversions = censusOf()
  const id = 'normal-return-predicates' as PhysicalBodyId
  const abi: CallableAbi = {
    receiver: null,
    parameters: [{ value: optional, passing: 'by-value', ownership: 'owned' }],
    restFrom: null,
    result: { kind: 'void' }
  }
  const builder = createIrBodyBuilder(id, callable, abi)
  const entry = builder.openBlock()
  const known = builder.constant(entry, lineage('known'), 'undefined', 'undefined', undefinedValue)
  const unknown = builder.parameter(entry, lineage('unknown'), 0, optional)
  const predicates = (['to-boolean', 'is-present', 'is-defined'] as const).map((predicate) => [
    builder.test(entry, lineage(`known-${predicate}`), operand(known, undefinedValue), predicate),
    builder.test(entry, lineage(`unknown-${predicate}`), operand(unknown, optional), predicate)
  ])
  builder.return(entry, null, null)
  const facts = closedNormalResultsOf(new Map([[id, builder.seal()]]), graphOf(), { conversions, placements: new Map() })
  for (const [known, unknown] of predicates) {
    assert.equal(facts.truthiness.get(known!), false)
    assert.equal(facts.truthiness.has(unknown!), false)
  }
})

test('mutable or externally supplied bindings cannot extend an exact call-result fact', () => {
  const found = fixture()
  assert.equal(closedNormalResultsOf(found.bodies, graphOf(true), found).undefinedValues.has(found.read), false)
  found.placements.set(declaration, { storage: { kind: 'external', linkageName: 'external-binding' }, representation: optional })
  assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.read), false)
})

test('a different native recipe cannot authenticate the source of an absence conversion', () => {
  const found = fixture()
  const body = found.bodies.get(found.bodyId)!
  const wrong = found.conversions.nodeFor(string, optional)
  found.bodies.set(found.bodyId, {
    ...body,
    blocks: new Map(
      [...body.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((operation) =>
            operation.kind === 'convert' ? { ...operation, conversionUse: wrong.id } : operation
          )
        }
      ])
    )
  })
  assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.called), false)
})

test('binding propagation needs a unique initialization that dominates the actual read', () => {
  for (const mode of ['read-before-write', 'second-write'] as const) {
    const found = fixture()
    const body = found.bodies.get(found.callerId)!
    const block = body.blocks.get(found.start)!
    const write = block.operations.find((operation) => operation.kind === 'binding-write')!
    const read = block.operations.find((operation) => operation.kind === 'binding-read')!
    const operations = block.operations.flatMap((operation) =>
      mode === 'second-write'
        ? operation === write
          ? [write, { ...write, lineage: lineage('another-write') }]
          : [operation]
        : operation === read
          ? []
          : operation === write
            ? [read, write]
            : [operation]
    )
    found.bodies.set(found.callerId, { ...body, blocks: new Map([...body.blocks, [found.start, { ...block, operations }]]) })
    assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.called), true)
    assert.equal(closedNormalResultsOf(found.bodies, graphOf(), found).undefinedValues.has(found.read), false, mode)
  }
})
