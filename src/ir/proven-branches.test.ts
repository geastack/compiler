import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId, OperationId, PhysicalBodyId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { pureEffects, throwingCompletion, type OperandSource } from '../semantics/model/operands.js'
import { createIrBodyBuilder } from './build.js'
import type { SlotDrift } from './lower-operands.js'
import type { IrBody, TestOperation } from './model.js'
import { provenResultTruthiness, pruneProvenBranches } from './proven-branches.js'
import { verifyIrBody } from './verify.js'

const owner = 'proven-branch-owner' as FunctionId
const physical = 'proven-branch-body' as PhysicalBodyId
const absent = 'proven-absent-result' as SemanticResultId
const unrelated = 'unrelated-result' as SemanticResultId
const type = 'proven-branch-type' as StructuralTypeId
const number: Representation = { kind: 'scalar', domain: 'number' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const base = (result: SemanticResultId) => ({
  id: result as string as OperationId,
  caller: { kind: 'function' as const, functionId: owner },
  operands: [],
  results: [{ id: result, role: 'value' as const, type }],
  completion: throwingCompletion,
  effects: pureEffects,
  evaluationOrdinal: 0
})
const absenceOperation: SemanticOperation = {
  ...base(absent),
  family: 'property',
  internalMethod: 'get',
  strict: true,
  keyIsComputed: false,
  descriptor: null,
  normalResult: 'undefined'
}
const graphOf = (...operations: SemanticOperation[]): Pick<SemanticGraph, 'operations'> => ({
  operations: new Map(operations.map((operation) => [operation.id, operation]))
})
const resultSource = (result: SemanticResultId): OperandSource => ({ kind: 'result', result })
const logical = (id: string, operator: string, left: OperandSource, right: OperandSource): SemanticOperation => ({
  ...base(id as SemanticResultId),
  family: 'computation',
  form: 'logical',
  operator,
  operands: [left, right].map((source, index) => ({
    source,
    role: index === 0 ? 'left' : 'right',
    ordinal: 0,
    type,
    evaluation: { kind: 'runtime' }
  }))
})

test('normal-result facts propagate through nested guards without assuming an unknown operand', () => {
  const inner = logical('inner', '&&', resultSource(unrelated), resultSource(absent))
  const outer = logical('outer', '&&', resultSource(unrelated), resultSource(inner.results[0]!.id))
  const unknown = logical('unknown', '||', resultSource(unrelated), resultSource(absent))
  const truth = logical('truth', '||', resultSource(absent), { kind: 'constant', literal: 'string', text: 'undefined' })
  // Deliberately reverse dependency order: facts must reach a fixed point.
  const facts = provenResultTruthiness(graphOf(outer, inner, unknown, truth, absenceOperation))
  assert.equal(facts.get(outer.results[0]!.id), false)
  assert.equal(facts.get(inner.results[0]!.id), false)
  assert.equal(facts.has(unknown.results[0]!.id), false)
  assert.equal(facts.get(truth.results[0]!.id), true)
})

const guardedBody = (
  predicate: TestOperation['predicate'] = 'to-boolean',
  receiverRepresentation: Representation = number,
  readRepresentation: Representation = dynamic
) => {
  const builder = createIrBodyBuilder(physical, owner, null)
  const entry = builder.openBlock()
  const taken = builder.openBlock()
  const skipped = builder.openBlock()
  const join = builder.openBlock()
  const receiver = builder.constant(entry, unrelated, '1', 'number', receiverRepresentation)
  const key = builder.constant(entry, unrelated, 'marker', 'string', string)
  const read = builder.get(
    entry,
    absent,
    { value: receiver, representation: receiverRepresentation },
    { value: key, representation: string },
    readRepresentation
  )
  const condition = builder.test(entry, absent, { value: read, representation: readRepresentation }, predicate)
  builder.branch(entry, absent, { value: condition, representation: boolean }, taken, skipped)
  const yes = builder.constant(taken, unrelated, '1', 'number', number)
  builder.jump(taken, null, join)
  const no = builder.constant(skipped, unrelated, '0', 'number', number)
  builder.jump(skipped, null, join)
  const merged = builder.phi(
    join,
    unrelated,
    [
      { block: taken, value: { value: yes, representation: number } },
      { block: skipped, value: { value: no, representation: number } }
    ],
    number
  )
  builder.return(join, null, { value: merged, representation: number })
  return { body: builder.seal(), entry, taken, skipped, join, yes, read }
}

test('pruning preserves condition evaluation, removes unreachable definitions, and repairs merge predecessors', () => {
  const { body, entry, taken, skipped, join, yes, read } = guardedBody()
  const pruned = pruneProvenBranches(new Map([[physical, body]]), graphOf(absenceOperation)).bodies.get(physical)!
  assert.deepEqual(pruned.blocks.get(entry)!.operations, body.blocks.get(entry)!.operations)
  assert.deepEqual(pruned.blocks.get(entry)!.terminator, { kind: 'jump', lineage: absent, target: skipped })
  assert.equal(pruned.blocks.has(taken), false)
  assert.equal(pruned.values.has(yes), false)
  assert.equal(pruned.values.has(read), true, 'the read can still throw and must execute')
  const phi = pruned.blocks.get(join)!.operations[0]!
  assert.equal(phi.kind, 'phi')
  if (phi.kind === 'phi')
    assert.deepEqual(
      phi.incoming.map((edge) => edge.block),
      [skipped]
    )
  assert.deepEqual(verifyIrBody(pruned), [])
})

test('a shared lineage does not turn a presence test into a truthiness test', () => {
  for (const predicate of ['is-present', 'is-defined'] as const) {
    const { body } = guardedBody(predicate)
    const bodies = new Map([[physical, body]])
    assert.equal(pruneProvenBranches(bodies, graphOf(absenceOperation)).bodies, bodies)
  }
})

test('missing proof and generator control flow keep the original body', () => {
  const { body } = guardedBody()
  const bodies = new Map([[physical, body]])
  assert.equal(pruneProvenBranches(bodies, graphOf()).bodies, bodies)
  const generatorBodies = new Map([[physical, { ...body, generator: true }]])
  assert.equal(pruneProvenBranches(generatorBodies, graphOf(absenceOperation)).bodies, generatorBodies)
})

test('conversion refusals disappear only with the block that would execute them', () => {
  const { body, entry, taken } = guardedBody()
  const drift = (block: typeof entry): SlotDrift => ({
    block,
    operation: absenceOperation.id,
    role: 'value',
    ordinal: 0,
    source: 'string',
    slot: 'number',
    reason: 'no conversion',
    sourceRepresentation: string,
    slotRepresentation: number
  })
  const dead = drift(taken)
  const live = drift(entry)
  const unrelatedBody = drift('another-body-block' as typeof entry)
  const rows = [dead, live, unrelatedBody]
  const bodies = new Map([[physical, body]])
  assert.deepEqual(pruneProvenBranches(bodies, graphOf(absenceOperation), rows).slotDrift, [live, unrelatedBody])
  assert.equal(pruneProvenBranches(bodies, graphOf(), rows).slotDrift, rows)
})

test('a known undefined read keeps a native nullish check when receiver presence is not established', () => {
  const missing: Representation = { kind: 'undefined' }
  for (const receiver of [number, { kind: 'optional', payload: number, absence: 'undefined' }] as const) {
    const { body, entry, read } = guardedBody('to-boolean', receiver, missing)
    const pruned: IrBody = pruneProvenBranches(new Map([[physical, body]]), graphOf(absenceOperation)).bodies.get(physical)!
    const operations = pruned.blocks.get(entry)!.operations
    assert.equal(operations.find((operation) => 'result' in operation && operation.result?.id === read)?.kind, 'constant')
    const checks = operations.filter((operation) => operation.kind === 'compute' && operation.form === 'require-object-coercible')
    assert.equal(checks.length, receiver.kind === 'optional' ? 1 : 0)
    assert.deepEqual(operations.slice(0, 2), body.blocks.get(entry)!.operations.slice(0, 2), 'base and key still evaluate')
    assert.deepEqual(verifyIrBody(pruned), [])
  }
})
