import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId, PhysicalBodyId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { ConversionNode } from '../conversion/algebra.js'
import type { BindingOperation, ComputationOperation } from '../semantics/model/operations.js'
import { normalCompletion, pureEffects } from '../semantics/model/operands.js'
import { createIrBodyBuilder } from './build.js'
import { deadLogicalMergeValueMatches } from './dead-logical-merge.js'
import { allOperationsOf, type DeadLogicalMergeValueOperation, type IrBody } from './model.js'
import { verifyIrBody } from './verify.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const reference: Representation = { kind: 'native-record-ref', shapeId: 'record', native: null, ownership: 'shared-refcount' }
const owner = 'gap' as FunctionId
const left = 'left-value' as SemanticResultId
const lineage = 'logical-value' as SemanticResultId
const source: BindingOperation = {
  id: 'read-left' as BindingOperation['id'],
  family: 'binding',
  action: 'read',
  declaration: 'previous' as DeclarationId,
  mutable: false,
  temporalDeadZone: false,
  caller: { kind: 'function', functionId: owner },
  evaluationOrdinal: 0,
  operands: [],
  results: [{ id: left, role: 'value', type: 'record' as StructuralTypeId }],
  effects: pureEffects,
  completion: normalCompletion
}
const semanticOperationOf = (lineage: SemanticResultId) =>
  lineage === left ? source : lineage === semantic.results[0]?.id ? semantic : null
const semantic: ComputationOperation = {
  id: 'logical' as ComputationOperation['id'],
  family: 'computation',
  form: 'logical',
  operator: '&&',
  caller: { kind: 'function', functionId: owner },
  evaluationOrdinal: 0,
  effects: pureEffects,
  completion: normalCompletion,
  operands: [
    {
      role: 'left',
      ordinal: 0,
      source: { kind: 'result', result: left },
      type: 'record' as StructuralTypeId,
      evaluation: { kind: 'runtime' }
    }
  ],
  results: [{ id: lineage, role: 'value', type: 'number' as StructuralTypeId }],
  logicalLeftObjectTruthy: true
}
const fixture = (deadOnTruthy = false, transport?: 'preserved' | 'discarded') => {
  const builder = createIrBodyBuilder('gap-body' as PhysicalBodyId, owner, {
    receiver: null,
    restFrom: null,
    result: number,
    parameters: [reference, reference].map((value) => ({ value, passing: 'by-value' as const, ownership: 'shared-refcount' as const }))
  })
  const entry = builder.openBlock(),
    yes = builder.openBlock(),
    no = builder.openBlock(),
    join = builder.openBlock()
  const source = builder.bindingRead(entry, left, 'previous' as DeclarationId, reference)
  const other = builder.bindingRead(entry, 'unrelated-value' as SemanticResultId, 'other' as DeclarationId, reference)
  const node: ConversionNode | undefined =
    transport === undefined
      ? undefined
      : {
          id: 'source-envelope',
          source: reference,
          target: transport === 'preserved' ? reference : { kind: 'void' },
          capability:
            transport === 'preserved'
              ? { kind: 'identity' }
              : { kind: 'static', materializer: { id: 'discard', domain: 'all', allocates: false } }
        }
  const incoming =
    node === undefined
      ? { value: source, representation: reference }
      : {
          value: builder.convert(entry, left, node.id, { value: source, representation: reference }, node.target),
          representation: node.target
        }
  const condition = builder.test(entry, left, incoming, 'to-boolean')
  builder.branch(entry, left, { value: condition, representation: { kind: 'scalar', domain: 'boolean' } }, yes, no)
  const deadBlock = deadOnTruthy ? yes : no
  const evaluatedBlock = deadOnTruthy ? no : yes
  const dead = builder.deadLogicalMergeValue(deadBlock, lineage, incoming, number)
  const evaluated = builder.constant(evaluatedBlock, lineage, '4', 'number', number)
  builder.jump(yes, lineage, join)
  builder.jump(no, lineage, join)
  const result = builder.phi(
    join,
    lineage,
    [
      { block: deadBlock, value: { value: dead, representation: number } },
      { block: evaluatedBlock, value: { value: evaluated, representation: number } }
    ],
    number
  )
  builder.return(join, lineage, { value: result, representation: number })
  const body = builder.seal()
  const operation = [...body.blocks.values()]
    .flatMap(allOperationsOf)
    .find((value): value is DeadLogicalMergeValueOperation => value.kind === 'dead-logical-merge-value')!
  assert.deepEqual(verifyIrBody(body), [])
  return { body, operation, other, node }
}
const replace = (body: IrBody, original: DeadLogicalMergeValueOperation, operation: DeadLogicalMergeValueOperation): IrBody => ({
  ...body,
  blocks: new Map(
    [...body.blocks].map(([id, block]) => [
      id,
      { ...block, operations: block.operations.map((value) => (value === original ? operation : value)) }
    ])
  )
})

test('actual object presence licenses only its exact && falsy contribution', () => {
  const { body, operation } = fixture()
  assert.equal(deadLogicalMergeValueMatches(operation, semantic, body, semanticOperationOf), true)
})
test('missing source facts, another operator or another logical lineage cannot borrow the proof', () => {
  const { body, operation } = fixture()
  const { logicalLeftObjectTruthy: _proof, ...unknown } = semantic
  assert.equal(deadLogicalMergeValueMatches(operation, unknown, body, semanticOperationOf), false)
  assert.equal(deadLogicalMergeValueMatches(operation, { ...semantic, operator: '||' }, body, semanticOperationOf), false)
  assert.equal(
    deadLogicalMergeValueMatches(
      operation,
      { ...semantic, results: [{ ...semantic.results[0]!, id: 'different' as SemanticResultId }] },
      body,
      semanticOperationOf
    ),
    false
  )
})
test('an unrelated equal-shaped SSA cannot borrow the left object fact', () => {
  const { body, operation, other } = fixture()
  const forged = { ...operation, source: { ...operation.source, value: other } }
  assert.equal(deadLogicalMergeValueMatches(forged, semantic, replace(body, operation, forged), semanticOperationOf), false)
})
test('a source with the same lineage cannot substitute a different binding', () => {
  const { body, operation } = fixture()
  const forged: IrBody = {
    ...body,
    blocks: new Map(
      [...body.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: block.operations.map((value) =>
            value.kind === 'binding-read' && value.lineage === left ? { ...value, declaration: 'other' as DeclarationId } : value
          )
        }
      ])
    )
  }
  assert.equal(deadLogicalMergeValueMatches(operation, semantic, forged, semanticOperationOf), false)
})
test('source aliases require an exact value-preserving conversion citation', () => {
  const preserved = fixture(false, 'preserved')
  const resolve = (id: string) => (id === preserved.node?.id ? (preserved.node ?? null) : null)
  assert.equal(
    deadLogicalMergeValueMatches(preserved.operation, semantic, preserved.body, semanticOperationOf, { nodeById: resolve }),
    true
  )
  assert.equal(deadLogicalMergeValueMatches(preserved.operation, semantic, preserved.body, semanticOperationOf), false)
  const discarded = fixture(false, 'discarded')
  assert.equal(
    deadLogicalMergeValueMatches(discarded.operation, semantic, discarded.body, semanticOperationOf, {
      nodeById: (id) => (id === discarded.node?.id ? (discarded.node ?? null) : null)
    }),
    false
  )
})
test('the truthy edge and an operation outside its authenticated body are refused', () => {
  const { body, operation } = fixture(true)
  assert.equal(deadLogicalMergeValueMatches(operation, semantic, body, semanticOperationOf), false)
  assert.equal(deadLogicalMergeValueMatches({ ...operation }, semantic, body, semanticOperationOf), false)
})

/** The left cell `previous`, written once in the entry block from `origin`,
 * read back as the && left -- the shape `const api = v as Api; api && api.x`
 * lowers to. */
const writtenCell = (origin: 'assertion' | 'parameter', order: 'write-first' | 'read-first' = 'write-first') => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const builder = createIrBodyBuilder('cell-body' as PhysicalBodyId, owner, {
    receiver: null,
    restFrom: null,
    result: number,
    parameters: [
      { value: origin === 'assertion' ? dynamic : reference, passing: 'by-value' as const, ownership: 'shared-refcount' as const }
    ]
  })
  const entry = builder.openBlock(),
    yes = builder.openBlock(),
    no = builder.openBlock(),
    join = builder.openBlock()
  const write = (): void => {
    const argument = builder.parameter(entry, 'argument' as SemanticResultId, 0, origin === 'assertion' ? dynamic : reference)
    const value =
      origin === 'assertion'
        ? builder.convert(
            entry,
            'asserted' as SemanticResultId,
            'dynamic-to-record',
            { value: argument, representation: dynamic },
            reference
          )
        : argument
    builder.bindingWrite(entry, 'asserted' as SemanticResultId, 'previous' as DeclarationId, { value, representation: reference })
  }
  if (order === 'write-first') write()
  const read = builder.bindingRead(entry, left, 'previous' as DeclarationId, reference)
  if (order === 'read-first') write()
  const incoming = { value: read, representation: reference }
  const condition = builder.test(entry, left, incoming, 'to-boolean')
  builder.branch(entry, left, { value: condition, representation: { kind: 'scalar', domain: 'boolean' } }, yes, no)
  const dead = builder.deadLogicalMergeValue(no, lineage, incoming, number)
  const evaluated = builder.constant(yes, lineage, '4', 'number', number)
  builder.jump(yes, lineage, join)
  builder.jump(no, lineage, join)
  const result = builder.phi(
    join,
    lineage,
    [
      { block: no, value: { value: dead, representation: number } },
      { block: yes, value: { value: evaluated, representation: number } }
    ],
    number
  )
  builder.return(join, lineage, { value: result, representation: number })
  const sealed = builder.seal()
  const facts = (boxed: readonly string[]) => ({
    capturedDeclarations: [],
    capturedReceiver: null,
    allocatedAsValue: false,
    readsReceiver: false,
    boxed: new Set(boxed as DeclarationId[]),
    requiresEarlyBox: new Set<DeclarationId>()
  })
  const operation = [...sealed.blocks.values()]
    .flatMap(allOperationsOf)
    .find((value): value is DeadLogicalMergeValueOperation => value.kind === 'dead-logical-merge-value')!
  return {
    operation,
    body: (boxed: readonly string[] = []) => ({ ...sealed, facts: facts(boxed) }) as IrBody
  }
}

test('a cell written only from a checked assertion out of a box proves the && left an object without a source fact', () => {
  const { logicalLeftObjectTruthy: _proof, ...unproven } = semantic
  const { body, operation } = writtenCell('assertion')
  assert.equal(deadLogicalMergeValueMatches(operation, unproven, body(), semanticOperationOf), true)
})
test('a cell written from a parameter, shared with a closure, or read before its write keeps the refusal', () => {
  const { logicalLeftObjectTruthy: _proof, ...unproven } = semantic
  const parameter = writtenCell('parameter')
  assert.equal(deadLogicalMergeValueMatches(parameter.operation, unproven, parameter.body(), semanticOperationOf), false)
  const shared = writtenCell('assertion')
  assert.equal(deadLogicalMergeValueMatches(shared.operation, unproven, shared.body(['previous']), semanticOperationOf), false)
  const early = writtenCell('assertion', 'read-first')
  assert.equal(deadLogicalMergeValueMatches(early.operation, unproven, early.body(), semanticOperationOf), false)
  const { operation, body } = writtenCell('assertion')
  const factless = ({ facts: _facts, ...rest }: IrBody): IrBody => rest
  assert.equal(deadLogicalMergeValueMatches(operation, unproven, factless(body()), semanticOperationOf), false)
})
