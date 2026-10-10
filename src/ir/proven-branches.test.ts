import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
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

const objectNegation = (ordinal = 0, proof = true): SemanticOperation => ({
  ...base('object-negation' as SemanticResultId),
  family: 'computation',
  form: 'unary',
  operator: '!',
  ...(proof ? { operandObjectTruthy: true as const } : {}),
  operands: [{ source: { kind: 'parameter', ordinal }, role: 'operand', ordinal: 0, type, evaluation: { kind: 'runtime' } }]
})

test('a source object negation prunes only its exact entered operand and retains evaluation', () => {
  const builder = createIrBodyBuilder(physical, owner, null)
  const entry = builder.openBlock(),
    taken = builder.openBlock(),
    skipped = builder.openBlock()
  const record: Representation = { kind: 'record', shapeId: type, fields: [], accessors: [], ownership: 'shared-refcount' }
  const value = builder.parameter(entry, unrelated, 0, record)
  const negated = builder.compute(entry, 'object-negation' as SemanticResultId, 'unary', '!', [{ value, representation: record }], boolean)
  const condition = builder.test(entry, 'object-negation' as SemanticResultId, { value: negated, representation: boolean }, 'to-boolean')
  builder.branch(entry, 'object-negation' as SemanticResultId, { value: condition, representation: boolean }, taken, skipped)
  builder.return(taken, null, null)
  builder.return(skipped, null, null)
  const body = builder.seal(),
    bodies = new Map([[physical, body]])
  const result = pruneProvenBranches(bodies, graphOf(objectNegation())).bodies.get(physical)!
  assert.equal(result.blocks.has(taken), false)
  assert.deepEqual(result.blocks.get(entry)!.operations, body.blocks.get(entry)!.operations)
  assert.equal(result.blocks.get(entry)!.terminator.kind, 'jump')
  for (const semantic of [objectNegation(1), objectNegation(0, false), { ...objectNegation(), operator: '~' }])
    assert.equal(pruneProvenBranches(bodies, graphOf(semantic)).bodies, bodies)
})

test('closed object-only constructor options do not demand a conversion from an unreachable fallback', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/arithmetic-over-two-dynamic-operands.runtime.js')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const proof = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'computation' && operation.operandObjectTruthy === true
  )
  assert.ok(proof)
  assert.ok(proof.results[0])
  assert.equal(provenResultTruthiness(result.graph).get(proof.results[0].id), false)
  // The pruning pass retains condition evaluation. Once the branch is gone,
  // ordinary dead-value elimination may remove this pure negation itself.
  assert.ok(
    !(result.irBodies ?? []).some((body) =>
      [...body.blocks.values()].some((block) =>
        block.operations.some(
          (operation) =>
            operation.kind === 'convert' &&
            operation.source.representation.kind === 'record' &&
            operation.source.representation.fields.length === 0 &&
            operation.result.representation.kind === 'record' &&
            operation.result.representation.ownership === 'owned' &&
            operation.result.representation.fields.length > 0
        )
      )
    )
  )
  assert.ok(!result.refusals.some((row) => row.key.includes('shared-refcount,;)->record(')))
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

test('strict comparisons retain a native reference undefined lane while disjoint primitive branches still prune', () => {
  const reference: Representation = {
    kind: 'class-ref',
    declaration: 'strict-receiver' as never,
    shapeId: 'strict-receiver-shape' as never,
    ownership: 'shared-refcount',
    ancestors: []
  }
  for (const representation of [reference, number]) {
    const builder = createIrBodyBuilder(physical, owner, null)
    const entry = builder.openBlock()
    const taken = builder.openBlock()
    const skipped = builder.openBlock()
    const receiver = builder.receiver(entry, unrelated, representation)
    const missing: Representation = { kind: 'undefined' }
    const undefinedValue = builder.constant(entry, absent, 'undefined', 'undefined', missing)
    const condition = builder.compute(
      entry,
      unrelated,
      'equality',
      '===',
      [
        { value: receiver, representation },
        { value: undefinedValue, representation: missing }
      ],
      boolean
    )
    builder.branch(entry, unrelated, { value: condition, representation: boolean }, taken, skipped)
    builder.return(taken, null, null)
    builder.return(skipped, null, null)
    const body = builder.seal()
    const pruned = pruneProvenBranches(new Map([[physical, body]]), graphOf()).bodies.get(physical)!
    assert.equal(pruned.blocks.get(entry)!.terminator.kind, representation === reference ? 'branch' : 'jump')
    assert.equal(pruned.blocks.has(taken), representation === reference)
    assert.deepEqual(verifyIrBody(pruned), [])
  }
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

test('a read on a receiver that can only be nullish throws there, and nothing after it in the block survives', () => {
  for (const kind of ['undefined', 'null'] as const) {
    const receiver: Representation = { kind }
    const { body, entry } = guardedBody('to-boolean', receiver, dynamic)
    const pruned: IrBody = pruneProvenBranches(new Map([[physical, body]]), graphOf()).bodies.get(physical)!
    const block = pruned.blocks.get(entry)!
    const last = block.operations.at(-1)
    assert.equal(last?.kind === 'compute' && last.form, 'require-object-coercible')
    assert.equal(
      block.operations.some((operation) => operation.kind === 'get' || operation.kind === 'test'),
      false
    )
    assert.equal(block.terminator.kind, 'throw')
    assert.deepEqual(block.operations.slice(0, 2), body.blocks.get(entry)!.operations.slice(0, 2), 'base and key still evaluate')
    assert.equal(pruned.blocks.size, 1, 'every successor is unreachable')
    assert.deepEqual(verifyIrBody(pruned), [])
  }
  const { body } = guardedBody('to-boolean', { kind: 'optional', payload: number, absence: 'undefined' }, dynamic)
  assert.equal(
    pruneProvenBranches(new Map([[physical, body]]), graphOf()).bodies.get(physical),
    body,
    'a maybe-present receiver keeps its read'
  )
})

const undefinedType = 'proven-undefined-type' as StructuralTypeId
const stringType = 'proven-string-type' as StructuralTypeId
const typedGraphOf = (...operations: SemanticOperation[]): Pick<SemanticGraph, 'operations' | 'structuralTypes'> => ({
  operations: new Map(operations.map((operation) => [operation.id, operation])),
  structuralTypes: new Map([
    [undefinedType, { shape: { kind: 'primitive', primitive: 'undefined' } }],
    [stringType, { shape: { kind: 'primitive', primitive: 'string' } }]
  ]) as unknown as SemanticGraph['structuralTypes']
})
const typeofOf = (id: string, operandType: StructuralTypeId): SemanticOperation => ({
  ...base(id as SemanticResultId),
  family: 'computation',
  form: 'typeof',
  operator: 'typeof',
  operands: [
    {
      source: { kind: 'constant', literal: 'undefined', text: 'undefined' },
      role: 'operand',
      ordinal: 0,
      type: operandType,
      evaluation: { kind: 'runtime' }
    }
  ]
})
const typeofEquality = (id: string, operator: string, typeofResult: string): SemanticOperation => ({
  ...base(id as SemanticResultId),
  family: 'computation',
  form: 'equality',
  operator,
  operands: [
    { source: resultSource(typeofResult as SemanticResultId), role: 'left', ordinal: 0, type: stringType, evaluation: { kind: 'runtime' } },
    {
      source: { kind: 'constant', literal: 'string', text: 'undefined' },
      role: 'right',
      ordinal: 1,
      type: stringType,
      evaluation: { kind: 'runtime' }
    }
  ]
})

test('typeof of a value whose sealed type is undefined decides its comparison with a string, and the guard that holds it', () => {
  // `typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement`
  // on a host that declares the global absent: the read is `undefined`.
  const present = typeofOf('typeof-absent', undefinedType)
  const guard = typeofEquality('guard', '!==', 'typeof-absent')
  const early = typeofEquality('early-return', '===', 'typeof-absent')
  const conjunction = logical('conjunction', '&&', resultSource('guard' as SemanticResultId), resultSource(unrelated))
  const facts = provenResultTruthiness(typedGraphOf(conjunction, guard, early, present))
  assert.equal(facts.get('guard' as SemanticResultId), false)
  assert.equal(facts.get('early-return' as SemanticResultId), true)
  assert.equal(facts.get('conjunction' as SemanticResultId), false)
})

test('typeof of a value that may be defined decides nothing', () => {
  const live = typeofOf('typeof-live', stringType)
  const guard = typeofEquality('guard', '!==', 'typeof-live')
  const facts = provenResultTruthiness(typedGraphOf(guard, live))
  assert.equal(facts.has('guard' as SemanticResultId), false)
})

test('a decided typeof equality prunes the branch it guards, keeping the comparison evaluated', () => {
  const guardResult = 'guard-result' as SemanticResultId
  const builder = createIrBodyBuilder(physical, owner, null)
  const entry = builder.openBlock()
  const taken = builder.openBlock()
  const skipped = builder.openBlock()
  const name = builder.constant(entry, guardResult, 'undefined', 'string', string)
  const other = builder.constant(entry, guardResult, 'undefined', 'string', string)
  const condition = builder.compute(
    entry,
    guardResult,
    'equality',
    '!==',
    [
      { value: name, representation: string },
      { value: other, representation: string }
    ],
    boolean
  )
  builder.branch(entry, guardResult, { value: condition, representation: boolean }, taken, skipped)
  builder.return(taken, null, { value: name, representation: string })
  builder.return(skipped, null, { value: other, representation: string })
  const body = builder.seal()
  const facts = typedGraphOf(typeofEquality('guard-result', '!==', 'typeof-absent'), typeofOf('typeof-absent', undefinedType))
  const pruned = pruneProvenBranches(new Map([[physical, body]]), facts).bodies.get(physical)!
  assert.deepEqual(pruned.blocks.get(entry)!.terminator, { kind: 'jump', lineage: guardResult, target: skipped })
  assert.equal(pruned.blocks.has(taken), false)
  assert.ok(
    pruned.blocks.get(entry)!.operations.some((operation) => operation.kind === 'compute'),
    'the comparison still executes'
  )
  assert.deepEqual(verifyIrBody(pruned), [])
})
